/**
 * Провайдер данных TON — tonapi.io.
 *
 * Как и Helius для Solana, tonapi отдаёт РАЗОБРАННЫЕ действия, а не сырые
 * сообщения. Событие адреса приходит списком actions, среди которых нас
 * интересуют два типа:
 *
 *   TonTransfer     перевод самой монеты
 *   JettonTransfer  перевод жетона (так в TON называются токены)
 *
 * Альтернатива — toncenter: там пришлось бы дёргать два эндпоинта
 * (/transactions и /jetton/transfers) и отдельно искать символы токенов.
 * Здесь символ и точность приходят прямо в ответе.
 *
 * ЛОВУШКА С ТОЧНОСТЬЮ. Суммы приходят по-разному:
 *
 *   "JettonTransfer": { "amount": "1" }          строка — точно
 *   "TonTransfer":    { "amount": 200000000 }    ЧИСЛО — опасно
 *
 * У TON девять знаков после запятой, поэтому число переполнит точное целое
 * JavaScript на суммах свыше девяти миллионов TON. Перехватываем большие
 * числа ДО разбора JSON — тем же приёмом, что в tronGrid.js.
 *
 * ЖЁСТКИЙ ЛИМИТ. Бесплатный тариф — около запроса в секунду; замерено:
 * без пауз 429 приходит на одиннадцатом запросе, с паузой 1.1 секунды
 * проходят все. Поэтому запросы выстроены в общую очередь.
 */

import axios from 'axios';

import { config } from '../../config/env.js';
import { consume } from '../apiBudget.js';
import { getNetwork } from '../../config/networks.js';
import { toCanonical } from '../normalize/tonAddress.js';

const API_BASE = 'https://tonapi.io/v2';

/** Событий за один запрос. Потолок API — 100 */
const PAGE_SIZE = 100;

/** Повторы при временных сбоях */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

/**
 * Пауза между запросами.
 *
 * Замерено на бесплатном тарифе: без пауз 429 прилетает на одиннадцатом
 * запросе подряд, с 1.1 секунды проходят все восемь из восьми. Берём
 * с небольшим запасом — отказ обходится дороже, чем лишние сто
 * миллисекунд.
 */
const REQUEST_INTERVAL_MS = 1100;

/** Нативная монета: девять знаков, единица — нанотон */
const TON_DECIMALS = 9;

/**
 * Очередь запросов.
 *
 * Лимит считается на ключ, а не на соединение, поэтому паузу приходится
 * держать глобально: два параллельных запроса из разных мест кода вместе
 * упрутся в тот же предел. Тот же приём, что в labelService.js для
 * TronScan.
 */
let queue = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Поставить задачу в общую очередь, выдержав интервал */
function throttle(task) {
  const scheduled = queue.then(async () => {
    const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);

    lastRequestAt = Date.now();
    return task();
  });

  // Очередь не должна ломаться из-за упавшей задачи
  queue = scheduled.catch(() => {});

  return scheduled;
}

/**
 * Большие целые числа в строки ДО разбора JSON.
 *
 * `JSON.parse` округляет всё, что не помещается в точное целое, и
 * восстановить исходное значение потом уже нельзя. Оборачиваем в кавычки
 * поле amount, если в нём больше пятнадцати цифр.
 *
 * @param {string} text
 */
function protectBigNumbers(text) {
  if (typeof text !== 'string') return text;

  return text.replace(/"amount":\s*(\d{16,})/g, '"amount":"$1"');
}

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30_000,
  transformResponse: [
    (data) => {
      if (typeof data !== 'string') return data;
      try {
        return JSON.parse(protectBigNumbers(data));
      } catch {
        return data;
      }
    },
  ],
});

/* --------------------------------- Транспорт ------------------------------ */

function requireKey() {
  if (!config.api.tonApiKey) {
    throw new Error(
      'Не задан TONAPI_KEY — TON без него почти недоступна: без ключа лимит ' +
        'ещё жёстче. Получить: https://tonconsole.com',
    );
  }
}

/**
 * GET с повторами и троттлингом.
 *
 * @param {string} path
 * @param {object} [params]
 */
async function get(path, params = {}) {
  requireKey();
  consume('tonapi');

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { data } = await throttle(() =>
        client.get(path, {
          params,
          headers: { Authorization: `Bearer ${config.api.tonApiKey}` },
        }),
      );

      return data;
    } catch (error) {
      lastError = error;

      const status = error.response?.status;
      // 401 и 403 — про ключ, повторять бессмысленно
      if (status === 401 || status === 403) break;
      if (!(status === 429 || status === undefined || status >= 500)) break;
      if (attempt === MAX_RETRIES) break;

      // При 429 ждём заметно дольше обычного интервала: лимит считается
      // в окне, и повтор через сто миллисекунд снова упрётся в него
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  throw new Error(
    `Запрос к tonapi не удался (${path}): ` +
      `${lastError?.response?.status ?? ''} ${lastError?.message ?? 'неизвестная ошибка'}`.trim(),
  );
}

/* ------------------------------ Разбор ответов ---------------------------- */

/** timestamp в СЕКУНДАХ, как у Etherscan и Helius */
function toDate(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

/** Адрес к канонической форме. Мусор не роняет заход */
function address(raw) {
  if (!raw) return null;
  try {
    return toCanonical(raw);
  } catch {
    return null;
  }
}

/**
 * Действия события в наши переводы.
 *
 * Одно событие — это транзакция со списком действий. Нас интересуют два
 * типа, остальные (SmartContractExec, ContractDeploy, NftItemTransfer)
 * средств между кошельками не двигают.
 *
 * @param {object} event
 * @param {object} network
 * @returns {object[]}
 */
function parseEvent(event, network) {
  const transfers = [];

  (event.actions ?? []).forEach((action, index) => {
    // Неуспешные действия состояние не меняют
    if (action.status && action.status !== 'ok') return;

    if (action.type === 'TonTransfer') {
      const body = action.TonTransfer ?? {};
      const from = address(body.sender?.address);
      const to = address(body.recipient?.address);
      const value = String(body.amount ?? '0');

      if (!from || !to || value === '0') return;

      transfers.push({
        network: network.key,
        hash: event.event_id,
        // Позиция действия внутри события. Событие приходит целиком
        // и не разрывается между страницами, поэтому позиция
        // воспроизводится от запроса к запросу
        transferIndex: `n:${index}`,
        transferType: 'native',
        fromAddress: from,
        toAddress: to,
        value,
        tokenSymbol: network.nativeSymbol,
        tokenContractAddress: null,
        decimals: TON_DECIMALS,
        blockNumber: Number(event.lt) || null,
        blockTimestamp: toDate(event.timestamp),
      });

      return;
    }

    if (action.type === 'JettonTransfer') {
      const body = action.JettonTransfer ?? {};
      const from = address(body.sender?.address);
      const to = address(body.recipient?.address);
      const value = String(body.amount ?? '0');

      if (!from || !to || value === '0') return;

      const jetton = body.jetton ?? {};

      transfers.push({
        network: network.key,
        hash: event.event_id,
        transferIndex: `t:${index}`,
        transferType: 'token',
        fromAddress: from,
        toAddress: to,
        value,
        tokenSymbol: jetton.symbol ?? null,
        tokenContractAddress: address(jetton.address),
        decimals: Number.isInteger(jetton.decimals) ? jetton.decimals : null,
        blockNumber: Number(event.lt) || null,
        blockTimestamp: toDate(event.timestamp),
      });
    }
  });

  return transfers;
}

/* --------------------------------- Пагинация ------------------------------ */

/**
 * Нижняя граница выборки по времени.
 *
 * Фильтра по дате у API нет — только курсор по логическому времени,
 * поэтому горизонт применяем на своей стороне.
 *
 * @returns {number} метка в секундах, 0 — без ограничения
 */
function horizonSeconds() {
  if (config.app.graphDays <= 0) return 0;
  return Math.floor(Date.now() / 1000) - config.app.graphDays * 24 * 60 * 60;
}

/**
 * Забрать страницы событий.
 *
 * Курсор — `before_lt`, логическое время последнего события страницы.
 * Отдельного параметра «новее чем» у API нет, поэтому вверх идём от
 * свежих и останавливаемся, встретив известное событие.
 *
 * @param {string} addr канонический адрес
 * @param {{ lastEventId?: string|null, pendingBeforeLt?: string|null }} state
 * @param {{ loadMore?: boolean }} options
 */
async function fetchPages(addr, state, { loadMore = false } = {}) {
  const isFirstFetch = !state.lastEventId;
  const horizon = horizonSeconds();

  // Просят догрузить, а хвоста нет — источник вычерпан
  if (loadMore && !isFirstFetch && !state.pendingBeforeLt) {
    return { events: [], newestEventId: null, oldestLt: null, exhausted: true };
  }

  const maxPages = isFirstFetch ? config.app.firstFetchPages : config.app.maxPagesPerFetch;

  const events = [];
  let beforeLt = loadMore ? state.pendingBeforeLt : null;
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    const body = await get(`/accounts/${addr}/events`, {
      limit: PAGE_SIZE,
      ...(beforeLt ? { before_lt: beforeLt } : {}),
    });

    const batch = body?.events ?? [];

    if (batch.length === 0) {
      exhausted = true;
      break;
    }

    // Вверх идём до уже известного события: всё, что ниже, у нас есть
    const known = loadMore
      ? -1
      : batch.findIndex((event) => event.event_id === state.lastEventId);

    const slice = known >= 0 ? batch.slice(0, known) : batch;

    // Горизонт: старое не берём и дальше не листаем
    const fresh = horizon > 0 ? slice.filter((event) => Number(event.timestamp) >= horizon) : slice;

    events.push(...fresh);

    if (known >= 0 || fresh.length < slice.length || batch.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }

    beforeLt = body.next_from ?? batch[batch.length - 1].lt;
    if (!beforeLt) {
      exhausted = true;
      break;
    }
  }

  return {
    events,
    newestEventId: events[0]?.event_id ?? null,
    oldestLt: events.length ? String(events[events.length - 1].lt) : null,
    exhausted,
  };
}

/* --------------------------- Публичный интерфейс -------------------------- */

/**
 * Забрать переводы адреса.
 *
 * @param {string} networkKey
 * @param {string} addr канонический адрес
 * @param {object} [rawSyncState]
 * @param {{ loadMore?: boolean }} [options]
 */
export async function fetchTransfers(networkKey, addr, rawSyncState, options = {}) {
  const network = getNetwork(networkKey);
  const state = rawSyncState ?? {};

  const page = await fetchPages(addr, state, options);

  const transfers = [];
  for (const event of page.events) {
    transfers.push(...parseEvent(event, network));
  }

  // Как и в Solana, API отдаёт события, где адрес участвует любым образом.
  // Оставляем только переводы, которые действительно его касаются
  const mine = transfers.filter(
    (transfer) => transfer.fromAddress === addr || transfer.toAddress === addr,
  );

  const goingDown = Boolean(options.loadMore);

  const lastEventId = goingDown
    ? (state.lastEventId ?? null)
    : (page.newestEventId ?? state.lastEventId ?? null);

  let pendingBeforeLt = state.pendingBeforeLt ?? null;

  if (page.exhausted) {
    pendingBeforeLt = goingDown ? null : pendingBeforeLt;
  } else if (page.oldestLt) {
    pendingBeforeLt = page.oldestLt;
  }

  return {
    transfers: mine,
    syncState: { ...state, lastEventId, pendingBeforeLt },
    hasMore: pendingBeforeLt !== null,
  };
}

/**
 * Баланс адреса: TON и жетоны.
 *
 * @param {string} networkKey
 * @param {string} addr
 */
export async function fetchBalance(networkKey, addr) {
  const network = getNetwork(networkKey);

  const [account, jettons] = await Promise.all([
    get(`/accounts/${addr}`),
    get(`/accounts/${addr}/jettons`),
  ]);

  const tokens = [];

  for (const item of jettons?.balances ?? []) {
    const balance = String(item.balance ?? '0');
    if (balance === '0') continue;

    const contractAddress = address(item.jetton?.address);
    if (!contractAddress) continue;

    tokens.push({ contractAddress, balance });
  }

  return {
    native: {
      balance: String(account?.balance ?? '0'),
      // Замороженного в понимании Tron здесь нет
      frozen: '0',
      decimals: network.nativeDecimals,
      symbol: network.nativeSymbol,
    },
    tokens,
  };
}

export const provider = {
  family: 'ton',
  fetchTransfers,
  fetchBalance,
};

export const __testing = {
  parseEvent,
  fetchPages,
  horizonSeconds,
  protectBigNumbers,
  toDate,
  PAGE_SIZE,
  REQUEST_INTERVAL_MS,
};

export default provider;
