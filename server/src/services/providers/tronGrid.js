/**
 * Провайдер данных TronGrid.
 *
 * Отвечает за два из трёх источников переводов:
 *   /v1/accounts/{addr}/transactions        — нативные TRX (фильтр TransferContract)
 *   /v1/accounts/{addr}/transactions/trc20  — токены TRC-20
 *
 * Третий источник — внутренние переводы — TronGrid не отдаёт вовсе,
 * им занимается providers/tronScan.js.
 *
 * Наружу выставляет одну функцию fetchTransfers(). Всё остальное — детали
 * этого API, и знать о них никому больше не нужно: ни контроллеру, ни
 * построителю графа.
 */

import { createHash } from 'node:crypto';
import axios from 'axios';
import { config } from '../../config/env.js';
import { getNetwork } from '../../config/networks.js';
import { toBase58 } from '../normalize/tronAddress.js';

const NETWORK_KEY = 'tron';
const network = getNetwork(NETWORK_KEY);

/** Сколько раз повторяем запрос при 429 и 5xx */
const MAX_RETRIES = 4;

/** Базовая задержка перед повтором, мс. Растёт экспоненциально */
const RETRY_BASE_DELAY_MS = 500;

/** Таймаут одного запроса */
const REQUEST_TIMEOUT_MS = 15_000;

/* ────────────────────────────── HTTP-клиент ────────────────────────────── */

const client = axios.create({
  baseURL: network.api.tronGrid,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    // Ключ не обязателен: API отвечает и без него, просто с низким лимитом.
    ...(config.api.tronGridKey ? { 'TRON-PRO-API-KEY': config.api.tronGridKey } : {}),
  },

  /**
   * ЗАЩИТА ОТ ПОТЕРИ ТОЧНОСТИ.
   *
   * В /transactions сумма TRX приходит ЧИСЛОМ: "amount": 3226990000000.
   * JSON.parse превратит его в Number, а тот надёжен лишь до 2^53 ≈ 9·10^15
   * SUN, то есть до ~9 миллиардов TRX. При общем предложении TRX около
   * 92 миллиардов такой перевод возможен, и точность потерялась бы МОЛЧА.
   *
   * Поэтому до разбора JSON оборачиваем числовые amount в строки.
   * В /trc20 value и так приходит строкой — там проблемы нет.
   */
  transformResponse: [
    (data) => {
      if (typeof data !== 'string') return data;
      try {
        return JSON.parse(data.replace(/"amount"\s*:\s*(\d+)/g, '"amount":"$1"'));
      } catch {
        // Не JSON — вернём как есть, разбираться будет вызывающий код
        return data;
      }
    },
  ],
});

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET с повторами.
 *
 * Точные лимиты TronGrid официально не публикуются — в документации прямо
 * сказано не зашивать их в логику. Поэтому вместо «5 запросов в секунду»
 * реагируем на фактический отказ: 429 (лимит) и 5xx (сбой на их стороне)
 * повторяем с растущей паузой. Ошибки 4xx, кроме 429, не повторяем —
 * это наши собственные ошибки в запросе, повтор их не исправит.
 *
 * @param {string} path
 * @param {Record<string, string|number|boolean>} [params]
 * @returns {Promise<any>}
 */
async function get(path, params = {}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.get(path, { params });
      const body = response.data;

      // TronGrid умеет отвечать HTTP 200 с признаком ошибки в теле
      if (body && body.success === false) {
        throw new Error(
          `TronGrid вернул ошибку: ${JSON.stringify(body.error ?? body).slice(0, 200)}`,
        );
      }

      return body;
    } catch (error) {
      lastError = error;

      const status = error.response?.status;
      const retriable =
        status === 429 || status === undefined || (status >= 500 && status < 600);

      if (!retriable || attempt === MAX_RETRIES) break;

      // 500, 1000, 2000, 4000 мс
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw new Error(
    `Запрос к TronGrid не удался: ${path} — ${lastError?.message ?? 'неизвестная ошибка'}`,
    { cause: lastError },
  );
}

/* ──────────────────────────── Общие помощники ──────────────────────────── */

/**
 * Ключ перевода на случай, когда индекса события в ответе нет.
 *
 * Сворачивает четыре поля, которые вместе почти всегда уникальны внутри
 * транзакции, в короткую строку — она годится в первичный ключ, в отличие
 * от 34-символьных адресов и 78-значных сумм.
 *
 * @returns {string} например "h:a3f9c21b8e4d7062"
 */
function transferKeyFromFields(from, to, tokenAddress, value) {
  const digest = createHash('sha256')
    .update(`${from}|${to}|${tokenAddress ?? ''}|${value}`)
    .digest('hex')
    .slice(0, 16);
  return `h:${digest}`;
}

/**
 * Развести повторяющиеся ключи суффиксами: "h:abc", "h:abc#1", "h:abc#2".
 *
 * Нужно только в аварийной ветке — когда ключи совпали, а получить точный
 * event_index не удалось (TronGrid не ответил даже после всех повторов).
 *
 * Без суффикса вторая запись затирала бы первую по первичному ключу —
 * потеря данных ровно там, где мы её предотвращаем.
 *
 * ПОЧЕМУ ЭТО НЕ СОЗДАЁТ ДУБЛЕЙ ПРИ ПОВТОРНОЙ СИНХРОНИЗАЦИИ.
 * Суффикс получают только записи с ОДИНАКОВЫМ ключом, то есть совпадающие
 * по from, to, токену и сумме. Прочие поля у них тоже общие — это одна
 * транзакция и один контракт. Значит записи неразличимы, и перестановка
 * их в ответе API ничего не меняет: набор ключей {X, X#1, ...} выйдет тем
 * же самым, а upsert перезапишет строки, а не задвоит их.
 *
 * Количество переводов в транзакции измениться не может — блокчейн
 * неизменяем.
 *
 * @param {string[]} keys
 * @returns {string[]}
 */
function dedupeKeys(keys) {
  const seen = new Map();
  return keys.map((key) => {
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? key : `${key}#${count}`;
  });
}

/**
 * Время блока в Date. Приходит в МИЛЛИСЕКУНДАХ (13 цифр);
 * многие блокчейн-API отдают секунды, и перепутать — получить 1970 год.
 *
 * @param {number} blockTimestamp
 * @returns {Date}
 */
function toDate(blockTimestamp) {
  return new Date(Number(blockTimestamp));
}

/* ───────────────────────── Нативные переводы TRX ───────────────────────── */

/**
 * Разобрать страницу ответа /transactions.
 *
 * Эндпоинт отдаёт ВСЮ активность аккаунта: вызовы контрактов, заморозку
 * ресурсов, голосования. Переводом средств является только
 * TransferContract — остальное отбрасываем не глядя.
 *
 * Отдельно проверяем contractRet: транзакция могла попасть в блок
 * и провалиться. Такая не двигала средств, и в графе ей не место.
 *
 * @param {any[]} rows
 * @returns {import('./types.js').NormalizedTransfer[]}
 */
function parseNativeTransfers(rows) {
  const transfers = [];

  for (const row of rows) {
    const contract = row.raw_data?.contract?.[0];
    if (!contract || contract.type !== 'TransferContract') continue;

    // Неуспешные транзакции средств не двигали
    const contractRet = row.ret?.[0]?.contractRet;
    if (contractRet && contractRet !== 'SUCCESS') continue;

    const value = contract.parameter?.value;
    if (!value?.owner_address || !value?.to_address || value.amount === undefined) continue;

    transfers.push({
      network: NETWORK_KEY,
      hash: row.txID,
      // Одна транзакция TransferContract = ровно один перевод,
      // различать нечего
      transferIndex: 'e:0',
      fromAddress: toBase58(value.owner_address),
      toAddress: toBase58(value.to_address),
      // amount обёрнут в строку в transformResponse — см. пояснение выше
      value: String(value.amount),
      decimals: network.nativeDecimals,
      tokenSymbol: network.nativeSymbol,
      tokenContractAddress: null,
      transferType: 'native',
      blockNumber: row.blockNumber ?? null,
      blockTimestamp: toDate(row.block_timestamp),
    });
  }

  return transfers;
}

/* ───────────────────────── Переводы токенов TRC-20 ─────────────────────── */

/**
 * Разобрать страницу ответа /trc20 в промежуточный вид, ещё без transferIndex.
 *
 * @param {any[]} rows
 */
function parseTokenRows(rows) {
  const parsed = [];

  for (const row of rows) {
    if (!row.transaction_id || !row.from || !row.to || row.value === undefined) continue;

    const info = row.token_info ?? {};

    parsed.push({
      hash: row.transaction_id,
      fromAddress: toBase58(row.from),
      toAddress: toBase58(row.to),
      value: String(row.value),
      // token_info бывает ПУСТЫМ (замерено — до 21% записей на адресах
      // контрактов). Подставлять 6 или 18 по умолчанию нельзя: это тихо
      // исказит сумму. null означает «неизвестно», фронт покажет сырое
      // значение с пометкой.
      decimals: Number.isInteger(info.decimals) ? info.decimals : null,
      tokenSymbol: info.symbol ?? null,
      tokenContractAddress: info.address ? toBase58(info.address) : null,
      blockTimestamp: toDate(row.block_timestamp),
      blockNumber: null,
    });
  }

  return parsed;
}

/**
 * Присвоить transferIndex переводам токенов.
 *
 * В ответе /trc20 нет аналога logIndex, а одна транзакция может содержать
 * несколько переводов — на живых данных встретился мультисенд с 22.
 * Поэтому:
 *
 *   1. Считаем ключ по полям — почти всегда переводы внутри транзакции
 *      различаются получателем или суммой, и ключи выходят разными.
 *   2. Если два ключа совпали, различить записи нечем: дозапрашиваем
 *      /events и берём event_index — он приходит из блокчейна и не может
 *      измениться между запросами, в отличие от порядка в ответе API.
 *   3. То же делаем для транзакции, задевшей границу страницы: её переводы
 *      могли разъехаться по двум страницам, и коллизию мы бы не увидели.
 *
 * Замерено: коллизий 0 из 3 мультипереводных транзакций — дозапрос нужен
 * действительно редко.
 *
 * @param {ReturnType<typeof parseTokenRows>} rows
 * @param {Set<string>} boundaryHashes хэши транзакций на границах страниц
 */
async function assignTokenTransferIndexes(rows, boundaryHashes) {
  /** @type {Map<string, typeof rows>} */
  const byTx = new Map();
  for (const row of rows) {
    if (!byTx.has(row.hash)) byTx.set(row.hash, []);
    byTx.get(row.hash).push(row);
  }

  const result = [];

  for (const [hash, group] of byTx) {
    const keys = group.map((r) =>
      transferKeyFromFields(r.fromAddress, r.toAddress, r.tokenContractAddress, r.value),
    );

    const hasCollision = new Set(keys).size !== keys.length;
    const needsExactIndex = hasCollision || (group.length > 1 && boundaryHashes.has(hash));

    if (!needsExactIndex) {
      group.forEach((row, i) => {
        result.push({ ...row, network: NETWORK_KEY, transferType: 'token', transferIndex: keys[i] });
      });
      continue;
    }

    // Записи /trc20 для этой транзакции ОТБРАСЫВАЕМ и строим строки из
    // событий. Иначе пришлось бы сопоставлять два списка одинаковых
    // записей — то есть снова опираться на порядок.
    const fromEvents = await buildTransfersFromEvents(hash, group);

    if (fromEvents.length > 0) {
      result.push(...fromEvents);
    } else {
      // События получить не удалось — сохраняем то, что есть, но обязательно
      // разводим совпавшие ключи суффиксом. Иначе вторая запись затрёт
      // первую по первичному ключу, и потеря случится именно там, где мы
      // её предотвращали.
      const uniqueKeys = dedupeKeys(keys);
      group.forEach((row, i) => {
        result.push({
          ...row,
          network: NETWORK_KEY,
          transferType: 'token',
          transferIndex: uniqueKeys[i],
        });
      });
    }
  }

  return result;
}

/**
 * Построить переводы из событий транзакции.
 *
 * В /events нет token_info, поэтому символ и decimals берём из записей
 * /trc20 той же транзакции — сопоставляя по адресу контракта. Это
 * безопасно: у одного контракта они одинаковы независимо от события.
 *
 * @param {string} hash
 * @param {any[]} trc20Group записи /trc20 этой же транзакции
 */
async function buildTransfersFromEvents(hash, trc20Group) {
  /** @type {Map<string, {symbol: string|null, decimals: number|null}>} */
  const tokenMeta = new Map();
  for (const row of trc20Group) {
    if (row.tokenContractAddress) {
      tokenMeta.set(row.tokenContractAddress, {
        symbol: row.tokenSymbol,
        decimals: row.decimals,
      });
    }
  }

  let body;
  try {
    body = await get(`/v1/transactions/${hash}/events`);
  } catch {
    // Дозапрос — оптимизация точности, а не обязательный шаг.
    // Не смогли — вернём пусто, вызывающий код обойдётся хэшами.
    return [];
  }

  const transfers = [];

  for (const event of body?.data ?? []) {
    if (event.event_name !== 'Transfer') continue;

    const from = event.result?.from;
    const to = event.result?.to;
    const value = event.result?.value;
    if (!from || !to || value === undefined) continue;

    const contractAddress = event.contract_address ? toBase58(event.contract_address) : null;
    const meta = contractAddress ? tokenMeta.get(contractAddress) : undefined;

    transfers.push({
      network: NETWORK_KEY,
      hash,
      // Индекс события в блоке — стабилен при любом порядке в ответе
      transferIndex: `e:${event.event_index}`,
      // В /events адреса приходят в 20-байтовой форме 0x... — третий
      // формат записи того же адреса
      fromAddress: toBase58(from),
      toAddress: toBase58(to),
      value: String(value),
      decimals: meta?.decimals ?? null,
      tokenSymbol: meta?.symbol ?? null,
      tokenContractAddress: contractAddress,
      transferType: 'token',
      blockNumber: event.block_number ?? null,
      blockTimestamp: toDate(event.block_timestamp),
    });
  }

  return transfers;
}

/* ─────────────────────────────── Пагинация ─────────────────────────────── */

/**
 * Пройти страницы одного эндпоинта, двигаясь от новых записей к старым.
 *
 * Курсор fingerprint живёт ТОЛЬКО внутри одного захода — между вызовами он
 * не сохраняется. Границы диапазона задают min_timestamp / max_timestamp:
 * они не устаревают и не ломаются при смене параметров.
 *
 * Порядок всегда desc: нас интересуют последние переводы, а не первые
 * в истории адреса.
 *
 * @param {string} path
 * @param {{ minTimestamp?: number, maxTimestamp?: number }} range
 * @returns {Promise<{
 *   rows: any[],
 *   boundaryHashes: Set<string>,
 *   latestTimestamp: number|undefined,
 *   oldestTimestamp: number|undefined,
 *   exhausted: boolean,
 * }>}
 *   exhausted — дошли до конца диапазона (данные кончились), а не упёрлись
 *   в потолок страниц. От этого зависит, можно ли двигать границу полноты.
 */
async function fetchPages(path, { minTimestamp, maxTimestamp, maxPages: pagesLimit } = {}) {
  const rows = [];
  const boundaryHashes = new Set();
  const maxPages = Math.max(1, pagesLimit ?? config.app.maxPagesPerFetch);

  let fingerprint;
  let latestTimestamp;
  let oldestTimestamp;
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    /** @type {Record<string, string|number|boolean>} */
    const params = {
      limit: Math.min(config.app.fetchLimit, 200), // потолок самого API — 200
      order_by: 'block_timestamp,desc',
      only_confirmed: true,
    };
    if (minTimestamp !== undefined) params.min_timestamp = minTimestamp;
    if (maxTimestamp !== undefined) params.max_timestamp = maxTimestamp;
    if (fingerprint) params.fingerprint = fingerprint;

    const body = await get(path, params);
    const pageRows = body?.data ?? [];

    if (pageRows.length === 0) {
      // Данные кончились — диапазон закрыт полностью
      exhausted = true;
      break;
    }

    rows.push(...pageRows);

    // При порядке desc самая свежая запись — первая на первой странице,
    // самая старая — последняя на последней
    if (latestTimestamp === undefined) latestTimestamp = pageRows[0]?.block_timestamp;
    oldestTimestamp = pageRows[pageRows.length - 1]?.block_timestamp;

    fingerprint = body?.meta?.fingerprint;

    if (!fingerprint) {
      // Продолжения нет — диапазон вычерпан
      exhausted = true;
      break;
    }

    // Страницы ещё будут: транзакция на стыке могла быть разрезана,
    // помечаем её как требующую точного индекса
    const edge = pageRows[pageRows.length - 1];
    const edgeHash = edge?.transaction_id ?? edge?.txID;
    if (edgeHash) boundaryHashes.add(edgeHash);
  }

  return { rows, boundaryHashes, latestTimestamp, oldestTimestamp, exhausted };
}

/**
 * С какого момента догружать. Отступаем назад на reorgBufferSec: последние
 * блоки не окончательны, и перезапрос этого отрезка (с upsert) исправит
 * данные, если цепь откатилась.
 *
 * @param {number|undefined|null} lastTimestamp
 * @returns {number|undefined} undefined = первый заход, тянем последние N
 */
function incrementalFrom(lastTimestamp) {
  if (!lastTimestamp) return undefined;
  return Math.max(0, lastTimestamp - network.reorgBufferSec * 1000);
}

/**
 * Нижняя граница выборки: глубже горизонта графа не копаем.
 *
 * Показываем мы последние GRAPH_DAYS дней — значит и догонять хвост глубже
 * бессмысленно. Без этого ограничения адрес, не запрошенный неделю, тянул бы
 * хвост сотнями заходов: замерено, что активный кошелёк делает ~200
 * переводов за 20 минут, то есть недельная история — это десятки тысяч
 * записей, которые всё равно не будут показаны.
 *
 * GRAPH_DAYS=0 — без ограничения.
 *
 * @param {number|undefined} incrementalStart
 * @returns {number|undefined}
 */
function applyHorizon(incrementalStart) {
  if (config.app.graphDays <= 0) return incrementalStart;

  const horizon = Date.now() - config.app.graphDays * 24 * 60 * 60 * 1000;
  if (incrementalStart === undefined) return horizon;
  return Math.max(incrementalStart, horizon);
}

/**
 * Забрать данные одного источника с учётом состояния синхронизации.
 *
 * ЗАЧЕМ ЭТО СЛОЖНЕЕ, ЧЕМ «ВЗЯТЬ ПОСЛЕДНИЕ 200».
 *
 * Наивная схема — всегда тянуть свежие и двигать отметку на самую новую
 * запись — теряет данные. Если между двумя обращениями к адресу случилось
 * больше переводов, чем влезает в лимит, середина остаётся позади границы
 * и не запрашивается уже никогда:
 *
 *   было 500 переводов, взяли 200 свежих, отметку сдвинули на новейшую
 *   -> 300 в середине потеряны навсегда
 *
 * Поэтому состояние хранит ДВЕ НЕЗАВИСИМЫЕ границы:
 *
 *   lastTimestamp        самая свежая известная запись — точка отсчёта
 *                        для инкремента ВВЕРХ (что появилось нового)
 *   pendingMaxTimestamp  докуда дочитано ВНИЗ; не null означает, что ниже
 *                        остался непрочитанный промежуток
 *
 * Два режима, и вызывающий код выбирает нужный явно:
 *
 *   обычный запрос     идём вверх от lastTimestamp — что нового
 *   догрузка (кнопка)  идём вниз от pendingMaxTimestamp — что осталось
 *
 * Промежуток не теряется ни в одном случае: если заход упёрся в потолок
 * страниц, pendingMaxTimestamp фиксирует место остановки, и оно видно
 * снаружи через флаг hasMore.
 *
 * @param {string} path
 * @param {{ lastTimestamp?: number|null, pendingMaxTimestamp?: number|null }} [state]
 * @param {{ loadMore?: boolean }} [options] loadMore — догружать вниз, а не вверх
 */
async function fetchSource(path, rawState, { loadMore = false } = {}) {
  const state = rawState ?? {};
  const isFirstFetch = !state.lastTimestamp;
  const pending = state.pendingMaxTimestamp ?? undefined;

  // Просят догрузить вниз, а хвоста у этого источника нет — значит для него
  // всё уже выкачано. Запрос не делаем вовсе: иначе ушли бы ВВЕРХ и
  // подмешали свежие записи, чего кнопка «загрузить ещё» делать не должна.
  if (loadMore && pending === undefined) {
    return {
      rows: [],
      boundaryHashes: new Set(),
      nextState: {
        lastTimestamp: state.lastTimestamp ?? null,
        pendingMaxTimestamp: null,
      },
    };
  }

  const goingDown = loadMore;

  const result = await fetchPages(path, {
    minTimestamp: applyHorizon(goingDown ? undefined : incrementalFrom(state.lastTimestamp)),
    maxTimestamp: goingDown ? pending : undefined,
    // Первый показ графа должен быть быстрым; догрузка идёт по кнопке,
    // и там пользователь готов подождать
    maxPages: isFirstFetch && !goingDown
      ? config.app.firstFetchPages
      : config.app.maxPagesPerFetch,
  });

  // Верхняя граница двигается только когда шли вверх: при догрузке вниз
  // мы получаем старые записи, и обновлять ею отметку свежести нельзя
  const lastTimestamp = goingDown
    ? (state.lastTimestamp ?? null)
    : (result.latestTimestamp ?? state.lastTimestamp ?? null);

  // Нижняя граница: если диапазон вычерпан — промежутка больше нет.
  // Иначе запоминаем, где остановились.
  let pendingMaxTimestamp;
  if (result.exhausted) {
    pendingMaxTimestamp = goingDown ? null : (state.pendingMaxTimestamp ?? null);
  } else if (result.oldestTimestamp === undefined) {
    pendingMaxTimestamp = state.pendingMaxTimestamp ?? null;
  } else {
    // Берём МИНИМУМ со старой границей: заход вверх, не уместившийся
    // в страницу, иначе поднял бы её выше уже дочитанной точки, и
    // следующая догрузка заново прошла бы то, что уже в базе.
    const previous = state.pendingMaxTimestamp;
    pendingMaxTimestamp = previous
      ? Math.min(result.oldestTimestamp, previous)
      : result.oldestTimestamp;
  }

  return {
    rows: result.rows,
    boundaryHashes: result.boundaryHashes,
    nextState: { lastTimestamp, pendingMaxTimestamp },
  };
}

/* ────────────────────────── Публичный интерфейс ────────────────────────── */

/**
 * Забрать переводы адреса из TronGrid.
 *
 * Контракт, общий для всех провайдеров: получает состояние синхронизации,
 * возвращает переводы и НОВОЕ состояние. Что внутри syncState — дело
 * провайдера, вызывающий код только хранит его и отдаёт обратно.
 *
 * @param {string} address адрес в канонической форме (base58)
 * @param {object} [syncState] предыдущее состояние из БД
 * @param {{ loadMore?: boolean }} [options]
 *   loadMore — догрузить более старые переводы («загрузить ещё»),
 *   вместо обычной проверки на новые
 * @returns {Promise<{ transfers: object[], syncState: object, hasMore: boolean }>}
 */
export async function fetchTransfers(address, rawSyncState, options = {}) {
  // Из БД может прийти null — значение по умолчанию его не перехватывает
  const syncState = rawSyncState ?? {};
  // Два источника независимы — запрашиваем параллельно
  const [nativeResult, tokenResult] = await Promise.all([
    fetchSource(`/v1/accounts/${address}/transactions`, syncState?.trx, options),
    fetchSource(`/v1/accounts/${address}/transactions/trc20`, syncState?.trc20, options),
  ]);

  const nativeTransfers = parseNativeTransfers(nativeResult.rows);
  const tokenTransfers = await assignTokenTransferIndexes(
    parseTokenRows(tokenResult.rows),
    tokenResult.boundaryHashes,
  );

  return {
    transfers: [...nativeTransfers, ...tokenTransfers],
    syncState: {
      ...syncState,
      trx: nativeResult.nextState,
      trc20: tokenResult.nextState,
    },
    // Ниже остался непрочитанный промежуток — фронт показывает
    // кнопку «загрузить ещё»
    hasMore:
      nativeResult.nextState.pendingMaxTimestamp !== null ||
      tokenResult.nextState.pendingMaxTimestamp !== null,
  };
}

/**
 * Текущий баланс адреса.
 *
 * Отдельный запрос, а НЕ вычисление из переводов: мимо списка транзакций
 * проходят комиссии за энергию и пропускную способность, заморозка TRX под
 * ресурсы, награды и делегирование. Сумма переводов — это сальдо переводов,
 * а не баланс.
 *
 * Поэтому полнота выкачанной истории на баланс никак не влияет: он всегда
 * актуален на момент запроса.
 *
 * @param {string} address base58
 * @returns {Promise<{
 *   native: { balance: string, frozen: string, decimals: number, symbol: string },
 *   tokens: Array<{ contractAddress: string, balance: string }>,
 * }>}
 */
export async function fetchBalance(address) {
  const body = await get(`/v1/accounts/${address}`);
  const account = body?.data?.[0] ?? {};

  // Свободный TRX. Замороженное под энергию и TRON Power лежит отдельно —
  // без него баланс стейкающих адресов выглядел бы заниженным.
  const balance = String(account.balance ?? '0');
  const frozen = (account.frozenV2 ?? []).reduce(
    (sum, entry) => sum + BigInt(entry.amount ?? 0),
    0n,
  );

  // Балансы токенов приходят массивом объектов { адрес_контракта: сумма },
  // БЕЗ символа и decimals — их подтянем из наших же транзакций по адресу
  // контракта. Для незнакомых токенов покажем сырое значение.
  const tokens = (account.trc20 ?? []).flatMap((entry) =>
    Object.entries(entry).map(([contractAddress, value]) => ({
      contractAddress,
      balance: String(value),
    })),
  );

  return {
    // Ключ native, а не trx: имя поля общее для всех сетей, иначе фронту
    // пришлось бы знать, какую сеть он сейчас показывает
    native: {
      balance,
      frozen: frozen.toString(),
      decimals: network.nativeDecimals,
      symbol: network.nativeSymbol,
    },
    tokens,
  };
}

export const provider = {
  family: 'tron',
  fetchTransfers,
};

/**
 * Внутренние функции, открытые для тестов.
 *
 * Ветка с дозапросом /events срабатывает только при коллизии ключей —
 * на живых данных это редкость (замерено: 0 из 3 мультипереводных
 * транзакций). Без прямого доступа этот код остался бы непроверенным.
 */
export const __testing = {
  parseNativeTransfers,
  parseTokenRows,
  transferKeyFromFields,
  dedupeKeys,
  buildTransfersFromEvents,
  assignTokenTransferIndexes,
  fetchPages,
  fetchSource,
  incrementalFrom,
};

export default provider;
