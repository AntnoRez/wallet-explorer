/**
 * Провайдер внутренних переводов — TronScan.
 *
 * Существует ровно по одной причине: TronGrid внутренние переводы НЕ ОТДАЁТ.
 * Транзакция, в которой адрес получил TRX изнутри исполнения контракта,
 * не появляется даже в списке транзакций этого адреса — проверено на
 * 40e4d806..., где поиск в окне ±4 секунды вернул ноль записей.
 *
 * Внутренний перевод — это TRX, который двигает контракт во время работы:
 * сдача при свапе, вывод из стейкинга, возврат средств. Отдельной подписи
 * у такой операции нет, она часть родительской транзакции.
 *
 *   GET /api/internal-transaction?address={base58}&limit=N&start=0
 *
 * Отличия от TronGrid, важные при чтении кода ниже:
 *   - адреса сразу в base58, конвертировать не нужно;
 *   - пагинация офсетная (start/limit), с жёстким потолком start+limit<=10000;
 *   - в выдачу попадают не только переводы, но и операции с ресурсами сети.
 */

import axios from 'axios';
import { config } from '../../config/env.js';
import { consume } from '../apiBudget.js';
import { getNetwork } from '../../config/networks.js';

const NETWORK_KEY = 'tron';
const network = getNetwork(NETWORK_KEY);

const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Потолок офсетной пагинации TronScan: start + limit не может превышать
 * это значение. Подтверждено: у контракта WTRX total равен ровно 10000.
 */
const OFFSET_CEILING = 10_000;

/**
 * Реальный максимум записей на страницу.
 *
 * TronScan молча режет limit до 50: запрос с limit=100 или limit=200 всё
 * равно возвращает 50. Документация об этом не говорит — замерено.
 *
 * Знать это обязательно: признаком «данные кончились» служит неполная
 * страница, и с завышенным limit каждая страница выглядела бы неполной.
 * Пагинация останавливалась бы на первой же порции.
 */
const PAGE_SIZE = 50;

/**
 * Значения note, которые протокол TRON знает для внутренних транзакций.
 * Подтверждено protobuf-схемой InternalTransaction в репозитории
 * tronprotocol.
 *
 * Всё остальное, что показывает TronScan (delegateResourceOfEnergy и т.п.),
 * — операции с РЕСУРСАМИ сети, а не движение средств между владельцами.
 * Замерено на обычном кошельке: из 61 записи только 2 были переводами,
 * остальные 48 — делегирование энергии. Без этого фильтра в графе появилось
 * бы ребро на 3 226 990 TRX, которого в реальности не существует.
 */
const TRANSFER_NOTES = new Set(['call', 'create', 'suicide']);

/** token_id нативного TRX в ответах TronScan */
const NATIVE_TOKEN_ID = '_';

/* ────────────────────────────── HTTP-клиент ────────────────────────────── */

const client = axios.create({
  baseURL: network.api.tronScan,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    ...(config.api.tronScanKey ? { 'TRON-PRO-API-KEY': config.api.tronScanKey } : {}),
  },

  /**
   * Та же защита от потери точности, что и в tronGrid.js, но для другого
   * поля: здесь сумма приходит как callValue / call_value — ЧИСЛОМ.
   *
   *   "callValue": 3226990000000
   *
   * Number надёжен до 2^53 ≈ 9·10^15 SUN (~9 млрд TRX), а предложение TRX
   * около 92 млрд. Оборачиваем в строку ДО разбора JSON.
   */
  transformResponse: [
    (data) => {
      if (typeof data !== 'string') return data;
      try {
        return JSON.parse(
          data.replace(/"(callValue|call_value)"\s*:\s*(\d+)/g, '"$1":"$2"'),
        );
      } catch {
        return data;
      }
    },
  ],
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET с повторами. Логика та же, что у TronGrid: повторяем 429, 5xx и
 * отсутствие ответа; прочие 4xx — наши ошибки, повтор их не исправит.
 *
 * @param {string} path
 * @param {Record<string, string|number|boolean>} [params]
 */
async function get(path, params = {}) {
  consume('tronscan');

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.get(path, { params });
      return response.data;
    } catch (error) {
      lastError = error;

      const status = error.response?.status;
      const retriable =
        status === 429 || status === undefined || (status >= 500 && status < 600);

      if (!retriable || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw new Error(
    `Запрос к TronScan не удался: ${path} — ${lastError?.message ?? 'неизвестная ошибка'}`,
    { cause: lastError },
  );
}

/* ─────────────────────────────── Разбор ────────────────────────────────── */

/**
 * Является ли запись движением средств.
 *
 * Пять условий, и каждое отсеивает свой класс мусора:
 *   note        операции с ресурсами сети (делегирование энергии)
 *   rejected    внутренняя транзакция отклонена и не исполнялась
 *   revert      исполнение откатилось
 *   result      родительская транзакция провалилась целиком
 *   callValue   вызов контракта без передачи средств
 *
 * @param {any} row
 * @param {string} callValue сумма в SUN, строкой
 */
function isRealTransfer(row, callValue) {
  if (!TRANSFER_NOTES.has(row.note)) return false;
  if (row.rejected === true) return false;
  if (row.revert === true) return false;
  if (row.result && row.result !== 'SUCCESS') return false;
  return callValue !== '0' && callValue !== '';
}

/**
 * Достать сумму и сведения о токене.
 *
 * TronScan отдаёт одно и то же тремя способами: valueInfoList (массив),
 * token_list (объект) и плоские поля верхнего уровня. Массив — самый
 * полный: в нём может быть несколько записей, если внутри одной операции
 * двигалось несколько токенов.
 *
 * @param {any} row
 * @returns {Array<{ value: string, decimals: number|null, symbol: string|null, tokenId: string|null }>}
 */
function extractValues(row) {
  const list = Array.isArray(row.valueInfoList) && row.valueInfoList.length > 0
    ? row.valueInfoList
    : [row.token_list].filter(Boolean);

  if (list.length === 0) {
    // Совсем ничего не пришло — берём плоские поля
    return [
      {
        value: String(row.call_value ?? '0'),
        decimals: null,
        symbol: null,
        tokenId: row.token_id ?? null,
      },
    ];
  }

  return list.map((entry) => {
    const info = entry.tokenInfo ?? {};
    const tokenId = info.tokenId ?? entry.token_id ?? null;
    const isNative = tokenId === NATIVE_TOKEN_ID || tokenId === null;

    return {
      value: String(entry.callValue ?? entry.call_value ?? '0'),
      decimals: Number.isInteger(info.tokenDecimal)
        ? info.tokenDecimal
        : isNative
          ? network.nativeDecimals
          : null,
      // TronScan пишет символ строчными: "trx". Приводим к виду,
      // в котором символы хранятся у нас
      symbol: info.tokenAbbr ? String(info.tokenAbbr).toUpperCase() : null,
      tokenId,
    };
  });
}

/**
 * Превратить страницу ответа в нормализованные переводы.
 *
 * @param {any[]} rows
 */
function parseInternalTransfers(rows) {
  const transfers = [];

  for (const row of rows) {
    if (!row.internal_hash || !row.from || !row.to) continue;

    const values = extractValues(row);

    values.forEach((entry, valueIndex) => {
      if (!isRealTransfer(row, entry.value)) return;

      const isNative = entry.tokenId === NATIVE_TOKEN_ID || entry.tokenId === null;

      transfers.push({
        network: NETWORK_KEY,
        // Хэш РОДИТЕЛЬСКОЙ транзакции: так внутренний перевод виден рядом
        // с остальными переводами той же транзакции
        hash: row.hash,
        // У внутренней транзакции есть собственный хэш — готовый уникальный
        // ключ, придумывать ничего не нужно.
        //
        // Суффикс нужен на случай, когда внутри ОДНОЙ внутренней транзакции
        // двигалось несколько токенов: valueInfoList — массив, и без
        // суффикса все записи получили бы одинаковый первичный ключ и
        // схлопнулись бы в базе. На живых данных массив всегда приходил из
        // одного элемента, поэтому обычный случай выглядит как раньше.
        transferIndex:
          values.length > 1
            ? `i:${row.internal_hash}#${valueIndex}`
            : `i:${row.internal_hash}`,
        fromAddress: row.from,
        toAddress: row.to,
        value: entry.value,
        decimals: entry.decimals,
        tokenSymbol: entry.symbol ?? (isNative ? network.nativeSymbol : null),
        // TRC-10 опознаётся числовым ID, а не адресом контракта;
        // для нативного TRX контракта нет вовсе
        tokenContractAddress: isNative ? null : entry.tokenId,
        transferType: 'internal',
        blockNumber: row.block ?? null,
        blockTimestamp: new Date(Number(row.timestamp)),
      });
    });
  }

  return transfers;
}

/* ────────────────────────── Загрузка с пагинацией ──────────────────────── */

/**
 * Нижняя граница выборки — не глубже горизонта графа.
 * @param {number|null|undefined} lastTimestamp
 */
function rangeStart(lastTimestamp) {
  const incremental = lastTimestamp
    ? Math.max(0, lastTimestamp - network.reorgBufferSec * 1000)
    : undefined;

  if (config.app.graphDays <= 0) return incremental;

  const horizon = Date.now() - config.app.graphDays * 24 * 60 * 60 * 1000;
  return incremental === undefined ? horizon : Math.max(incremental, horizon);
}

/**
 * Забрать внутренние переводы адреса.
 *
 * Состояние такое же, как у TronGrid-провайдера: две независимые границы.
 * Разница лишь в механике пагинации — здесь офсет, а не курсор.
 *
 * @param {string} address base58
 * @param {{ lastTimestamp?: number|null, pendingMaxTimestamp?: number|null }} [state]
 * @param {{ loadMore?: boolean }} [options]
 * @returns {Promise<{ transfers: object[], syncState: object, hasMore: boolean }>}
 */
export async function fetchTransfers(address, rawState, { loadMore = false } = {}) {
  // Не полагаемся на значение по умолчанию: оно подставляется только для
  // undefined, а из БД вполне может прийти null
  const state = rawState ?? {};
  const pending = state.pendingMaxTimestamp ?? undefined;

  // Просят догрузить вниз, а хвоста нет — источник вычерпан.
  // Запрос не делаем: иначе ушли бы вверх и подмешали свежие записи.
  if (loadMore && pending === undefined) {
    return {
      transfers: [],
      syncState: { lastTimestamp: state.lastTimestamp ?? null, pendingMaxTimestamp: null },
      hasMore: false,
    };
  }

  // Просить больше PAGE_SIZE бессмысленно — API всё равно вернёт 50
  const limit = Math.min(Math.max(1, config.app.internalFetchLimit), PAGE_SIZE);
  const maxPages = Math.max(
    1,
    !state.lastTimestamp && !loadMore
      ? config.app.firstFetchPages
      : config.app.maxPagesPerFetch,
  );

  /** @type {Record<string, string|number|boolean>} */
  const baseParams = { address, limit, sort: '-timestamp' };

  const from = rangeStart(loadMore ? null : state.lastTimestamp);
  if (from !== undefined) baseParams.start_timestamp = from;
  // Догрузка вниз: берём то, что старее точки остановки
  if (loadMore) baseParams.end_timestamp = pending;

  const rows = [];
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    const start = page * limit;

    // Офсетный потолок TronScan: глубже он данных не отдаст в принципе
    if (start + limit > OFFSET_CEILING) {
      exhausted = true;
      break;
    }

    const body = await get('/api/internal-transaction', { ...baseParams, start });
    const pageRows = body?.data ?? [];

    rows.push(...pageRows);

    // Неполная страница означает, что данные кончились
    if (pageRows.length < limit) {
      exhausted = true;
      break;
    }

    // Точный признак конца: TronScan отдаёт total, причём с учётом
    // фильтра по времени (проверено: 61 запись всего, 2 за май)
    const total = Number(body?.total);
    if (Number.isFinite(total) && start + pageRows.length >= total) {
      exhausted = true;
      break;
    }
  }

  const timestamps = rows.map((r) => Number(r.timestamp)).filter(Number.isFinite);
  const latest = timestamps.length ? Math.max(...timestamps) : undefined;
  const oldest = timestamps.length ? Math.min(...timestamps) : undefined;

  // Верхняя граница двигается только при движении вверх
  const lastTimestamp = loadMore
    ? (state.lastTimestamp ?? null)
    : (latest ?? state.lastTimestamp ?? null);

  let pendingMaxTimestamp;
  if (exhausted) {
    pendingMaxTimestamp = loadMore ? null : (state.pendingMaxTimestamp ?? null);
  } else if (oldest === undefined) {
    pendingMaxTimestamp = state.pendingMaxTimestamp ?? null;
  } else {
    // Берём МИНИМУМ со старой границей. Иначе обычный заход вверх, не
    // уместившийся в страницу, поднял бы границу выше уже дочитанной точки,
    // и следующая догрузка заново прошла бы участок, который уже в базе.
    // Данные при этом не терялись бы, но запросы тратились бы впустую.
    const previous = state.pendingMaxTimestamp;
    pendingMaxTimestamp = previous ? Math.min(oldest, previous) : oldest;
  }

  return {
    transfers: parseInternalTransfers(rows),
    syncState: { lastTimestamp, pendingMaxTimestamp },
    hasMore: pendingMaxTimestamp !== null,
  };
}

export const provider = {
  family: 'tron',
  source: 'internal',
  fetchTransfers,
};

export const __testing = {
  parseInternalTransfers,
  isRealTransfer,
  extractValues,
  rangeStart,
  TRANSFER_NOTES,
};

export default provider;
