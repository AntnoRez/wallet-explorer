/**
 * Провайдер данных Solana — Helius.
 *
 * У Solana нет эндпоинта «переводы адреса». Штатный путь такой: взять
 * список подписей транзакций, запросить каждую и разобрать инструкции.
 * Мы этого не делаем — за нас разбирает Helius.
 *
 * ПОЧЕМУ НЕ ОБЫЧНЫЙ RPC. Замерено на публичном узле и на самом Helius:
 *
 *   разбор через RPC          75% переводов удаётся связать с кошельками
 *   Enhanced Transactions    100% (454 перевода из 454 на двух адресах)
 *
 * Причина в токен-аккаунтах: у владельца отдельный счёт на каждый токен,
 * и в инструкциях стоят именно они, а не кошелёк. Сопоставление лежит
 * в балансах транзакции, но там есть не все счета — закрытые внутри той
 * же транзакции отсутствуют, и дозапросом их не достать (проверено:
 * getMultipleAccounts вернул ноль из девяти). Enhanced API отдаёт
 * fromUserAccount и toUserAccount сразу.
 *
 * ЕЩЁ ОДНА ОСОБЕННОСТЬ: API отдаёт транзакции, где адрес УПОМЯНУТ, а не
 * где он двигает средства. Для обычного кошелька разница невелика, для
 * адреса-пула — полная: у пула PUMP_AMM в ответе 612 переводов и ни
 * одного с его участием. Поэтому чужое отсеиваем, см. fetchTransfers().
 *
 * ЛОВУШКА С ТОЧНОСТЬЮ. Сумма перевода приходит ЧИСЛОМ с плавающей точкой:
 *
 *   "tokenAmount": 1608.299142                       <- float, ненадёжно
 *   "rawTokenAmount": { "tokenAmount": "-1608299142",
 *                       "decimals": 6 }              <- строка, точно
 *
 * Берём второе. Первое совпало с точным на всех 37 проверенных переводах,
 * но float даёт 15–16 значащих цифр, а у токенов с девятью знаками после
 * запятой суммы легко выходят за этот предел. Один раз мы это уже прошли
 * в tronScan.js.
 */

import axios from 'axios';

import { config } from '../../config/env.js';
import { consume } from '../apiBudget.js';
import { getNetwork } from '../../config/networks.js';
import { toCanonical } from '../normalize/solanaAddress.js';

/** Разобранные транзакции по адресу */
const ENHANCED_BASE = 'https://api.helius.xyz/v0';

/** Обычный RPC: балансы и метаданные токенов */
const RPC_BASE = 'https://mainnet.helius-rpc.com';

/**
 * Транзакций за один запрос. Потолок Enhanced API — 100, больше просить
 * бессмысленно.
 */
const PAGE_SIZE = 100;

/** Повторы при временных сбоях — как в остальных провайдерах */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

/** Нативная монета: у SOL девять знаков, единица — lamport */
const SOL_DECIMALS = 9;

/**
 * Кэш метаданных токенов: mint -> { symbol, decimals }.
 *
 * Enhanced API отдаёт mint, но НЕ отдаёт символ — без него в графе будут
 * висеть неразличимые хэши вместо USDC. Символы запрашиваются отдельно
 * и живут в памяти процесса: у токена они не меняются.
 */
const tokenMetaCache = new Map();

/**
 * Потолок кэша метаданных.
 *
 * У Solana спам-токенов на порядок больше, чем в других сетях: на одном
 * биржевом адресе нашлось 3812 токен-аккаунтов. Без потолка карта росла
 * бы всю жизнь процесса — за сутки работы это десятки тысяч записей
 * о токенах, которые больше никогда не встретятся.
 *
 * Вытесняем самые старые: Map перебирает ключи в порядке вставки.
 */
const TOKEN_META_LIMIT = 5000;

const enhanced = axios.create({ baseURL: ENHANCED_BASE, timeout: 45_000 });
const rpc = axios.create({ baseURL: RPC_BASE, timeout: 45_000 });

/* --------------------------------- Транспорт ------------------------------ */

function requireKey() {
  if (!config.api.heliusKey) {
    throw new Error(
      'Не задан HELIUS_API_KEY — Solana без него недоступна. ' +
        'Публичный узел не годится: он отдаёт только недавнюю историю. ' +
        'Получить ключ: https://helius.dev',
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Запрос к Enhanced API с повторами.
 *
 * @param {string} path
 * @param {object} params
 * @returns {Promise<any[]>}
 */
async function getEnhanced(path, params) {
  requireKey();
  consume('helius');

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { data } = await enhanced.get(path, {
        params: { 'api-key': config.api.heliusKey, ...params },
      });

      return Array.isArray(data) ? data : [];
    } catch (error) {
      lastError = error;

      const status = error.response?.status;
      // 429 и 5xx временные. 401 и 403 — про ключ, повторять бессмысленно
      if (status === 401 || status === 403) break;
      if (!(status === 429 || status === undefined || status >= 500)) break;
      if (attempt === MAX_RETRIES) break;

      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  throw new Error(
    `Запрос к Helius не удался (${path}): ` +
      `${lastError?.response?.status ?? ''} ${lastError?.message ?? 'неизвестная ошибка'}`.trim(),
  );
}

/**
 * Вызов обычного RPC (JSON-RPC).
 *
 * @param {string} method
 * @param {any} params
 */
async function callRpc(method, params) {
  requireKey();
  consume('helius');

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const { data } = await rpc.post(
        '/',
        { jsonrpc: '2.0', id: 1, method, params },
        { params: { 'api-key': config.api.heliusKey } },
      );

      if (data?.error) {
        throw Object.assign(new Error(`RPC ${method}: ${data.error.message ?? 'ошибка'}`), {
          permanent: true,
        });
      }

      return data?.result;
    } catch (error) {
      if (error.permanent) throw error;

      lastError = error;
      const status = error.response?.status;
      if (!(status === 429 || status === undefined || status >= 500)) break;
      if (attempt === MAX_RETRIES) break;

      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  throw new Error(`Запрос к Helius RPC не удался (${method}): ${lastError?.message ?? '?'}`);
}

/* ------------------------------ Метаданные токенов ------------------------ */

/**
 * Символы и точность для набора токенов.
 *
 * Спрашиваем только незнакомые: у токена метаданные не меняются, а
 * повторные обращения к одному и тому же адресу — обычное дело.
 *
 * @param {string[]} mints
 * @returns {Promise<Map<string, {symbol: string|null, decimals: number|null}>>}
 */
async function fetchTokenMeta(mints) {
  const unknown = [...new Set(mints)].filter((mint) => mint && !tokenMetaCache.has(mint));

  // DAS принимает до 1000 идентификаторов за раз, но столько разных
  // токенов у одного адреса не бывает — режем на всякий случай
  for (let i = 0; i < unknown.length; i += 100) {
    const batch = unknown.slice(i, i + 100);

    try {
      const assets = await callRpc('getAssetBatch', { ids: batch });

      for (const asset of assets ?? []) {
        if (!asset?.id) continue;
        const meta = asset.content?.metadata ?? {};
        const info = asset.token_info ?? {};

        tokenMetaCache.set(asset.id, {
          symbol: info.symbol || meta.symbol || null,
          decimals: Number.isInteger(info.decimals) ? info.decimals : null,
        });
      }
    } catch (error) {
      // Без символа граф просто менее читаем — это не повод терять переводы
      console.warn(`[solanaHelius] метаданные токенов недоступны: ${error.message}`);
    }

    // Незнакомые токены помечаем, чтобы не спрашивать о них снова
    for (const mint of batch) {
      if (!tokenMetaCache.has(mint)) tokenMetaCache.set(mint, { symbol: null, decimals: null });
    }

    evictTokenMeta();
  }

  return tokenMetaCache;
}

/** Убрать самые старые записи, если кэш перерос потолок */
function evictTokenMeta() {
  while (tokenMetaCache.size > TOKEN_META_LIMIT) {
    const oldest = tokenMetaCache.keys().next().value;
    tokenMetaCache.delete(oldest);
  }
}

/* ------------------------------ Разбор ответов ---------------------------- */

/** timestamp приходит в СЕКУНДАХ, как у Etherscan (в Tron — миллисекунды) */
function toDate(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

/** Адрес из ответа API к канонической форме. Мусор не роняет заход */
function address(raw) {
  if (!raw) return null;
  try {
    return toCanonical(raw);
  } catch {
    return null;
  }
}

/**
 * Точные суммы по (токен-аккаунт, mint) из одной транзакции.
 *
 * Это единственный источник, которому можно верить: в tokenTransfers
 * сумма приходит числом с плавающей точкой.
 *
 * @param {object} tx транзакция Enhanced API
 * @returns {Map<string, {amount: string, decimals: number}>}
 */
function exactAmounts(tx) {
  const amounts = new Map();

  for (const account of tx.accountData ?? []) {
    for (const change of account.tokenBalanceChanges ?? []) {
      const raw = change.rawTokenAmount ?? {};
      if (raw.tokenAmount === undefined) continue;

      amounts.set(`${change.tokenAccount}|${change.mint}`, {
        // Знак говорит о направлении, а сумма перевода — величина
        amount: String(raw.tokenAmount).replace('-', ''),
        decimals: Number(raw.decimals),
      });
    }
  }

  return amounts;
}

/**
 * Переводы токенов из одной транзакции.
 *
 * @param {object} tx
 * @param {object} network
 * @returns {object[]}
 */
function parseTokenTransfers(tx, network) {
  const exact = exactAmounts(tx);
  const transfers = [];

  (tx.tokenTransfers ?? []).forEach((transfer, index) => {
    const from = address(transfer.fromUserAccount);
    const to = address(transfer.toUserAccount);
    if (!from || !to) return;

    // Точную сумму ищем по счёту получателя, при неудаче — по счёту
    // отправителя: у одной из сторон запись о балансе есть почти всегда
    const precise =
      exact.get(`${transfer.toTokenAccount}|${transfer.mint}`) ??
      exact.get(`${transfer.fromTokenAccount}|${transfer.mint}`);

    const meta = tokenMetaCache.get(transfer.mint);
    const decimals = precise?.decimals ?? meta?.decimals ?? null;

    // Запасной путь: пересчёт из float. Хуже по точности, но лучше, чем
    // потерять перевод целиком
    const value =
      precise?.amount ??
      (decimals !== null && Number.isFinite(transfer.tokenAmount)
        ? BigInt(Math.round(transfer.tokenAmount * 10 ** decimals)).toString()
        : null);

    if (value === null || value === '0') return;

    transfers.push({
      network: network.key,
      hash: tx.signature,
      // Позиция в списке переводов транзакции. Транзакция приходит
      // целиком и не разрывается между страницами, поэтому позиция
      // воспроизводится от запроса к запросу
      transferIndex: `t:${index}`,
      transferType: 'token',
      fromAddress: from,
      toAddress: to,
      value,
      tokenSymbol: meta?.symbol ?? null,
      tokenContractAddress: transfer.mint ?? null,
      decimals,
      blockNumber: Number(tx.slot),
      blockTimestamp: toDate(tx.timestamp),
    });
  });

  return transfers;
}

/**
 * Переводы SOL из одной транзакции.
 *
 * Здесь сумма приходит целым числом в lamports — пересчитывать и терять
 * точность не нужно.
 *
 * @param {object} tx
 * @param {object} network
 */
function parseNativeTransfers(tx, network) {
  const transfers = [];

  (tx.nativeTransfers ?? []).forEach((transfer, index) => {
    const from = address(transfer.fromUserAccount);
    const to = address(transfer.toUserAccount);
    if (!from || !to) return;

    const value = String(transfer.amount ?? '0');
    if (value === '0') return;

    transfers.push({
      network: network.key,
      hash: tx.signature,
      transferIndex: `n:${index}`,
      transferType: 'native',
      fromAddress: from,
      toAddress: to,
      value,
      tokenSymbol: network.nativeSymbol,
      tokenContractAddress: null,
      decimals: SOL_DECIMALS,
      blockNumber: Number(tx.slot),
      blockTimestamp: toDate(tx.timestamp),
    });
  });

  return transfers;
}

/* --------------------------------- Пагинация ------------------------------ */

/**
 * Граница выборки по времени: глубже горизонта графа не копаем.
 *
 * У Enhanced API нет фильтра по дате — только курсор по подписи. Поэтому
 * горизонт применяется на нашей стороне: как только страница уходит
 * старше него, дальше не листаем.
 *
 * @returns {number} метка времени в секундах, 0 — без ограничения
 */
function horizonSeconds() {
  if (config.app.graphDays <= 0) return 0;
  return Math.floor(Date.now() / 1000) - config.app.graphDays * 24 * 60 * 60;
}

/**
 * Забрать страницы транзакций.
 *
 * Два режима, как и у остальных провайдеров:
 *
 *   вверх (обычный запрос)  until = последняя известная подпись,
 *                           листаем от свежих, пока не упрёмся в неё
 *   вниз  (загрузить ещё)   before = место, где остановились в прошлый раз
 *
 * @param {string} addr
 * @param {{ lastSignature?: string|null, pendingBefore?: string|null }} state
 * @param {{ loadMore?: boolean }} options
 */
async function fetchPages(addr, state, { loadMore = false } = {}) {
  const isFirstFetch = !state.lastSignature;
  const horizon = horizonSeconds();

  // Просят догрузить, а хвоста нет — источник вычерпан
  if (loadMore && !isFirstFetch && !state.pendingBefore) {
    return { transactions: [], newestSignature: null, oldestSignature: null, exhausted: true };
  }

  const maxPages = isFirstFetch ? config.app.firstFetchPages : config.app.maxPagesPerFetch;

  const params = {};
  if (loadMore && state.pendingBefore) params.before = state.pendingBefore;
  // Вверх идём до последней известной подписи. При первом заходе её нет,
  // и мы просто берём свежие страницы
  else if (!isFirstFetch) params.until = state.lastSignature;

  const transactions = [];
  let before = params.before ?? null;
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    const batch = await getEnhanced(`/addresses/${addr}/transactions`, {
      limit: PAGE_SIZE,
      ...(before ? { before } : {}),
      ...(params.until ? { until: params.until } : {}),
    });

    if (batch.length === 0) {
      exhausted = true;
      break;
    }

    // Горизонт: всё, что старше, не берём и дальше не листаем
    const fresh = horizon > 0 ? batch.filter((tx) => Number(tx.timestamp) >= horizon) : batch;
    transactions.push(...fresh);

    if (fresh.length < batch.length) {
      exhausted = true;
      break;
    }

    if (batch.length < PAGE_SIZE) {
      exhausted = true;
      break;
    }

    before = batch[batch.length - 1].signature;
  }

  return {
    transactions,
    newestSignature: transactions[0]?.signature ?? null,
    oldestSignature: transactions[transactions.length - 1]?.signature ?? null,
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
 * @returns {Promise<{ transfers: object[], syncState: object, hasMore: boolean }>}
 */
export async function fetchTransfers(networkKey, addr, rawSyncState, options = {}) {
  const network = getNetwork(networkKey);
  const state = rawSyncState ?? {};

  const page = await fetchPages(addr, state, options);

  // Символы токенов нужны до разбора: они попадают в каждый перевод
  const mints = page.transactions.flatMap((tx) =>
    (tx.tokenTransfers ?? []).map((transfer) => transfer.mint),
  );
  await fetchTokenMeta(mints);

  const transfers = [];

  for (const tx of page.transactions) {
    // Неуспешные транзакции состояние не меняют
    if (tx.transactionError) continue;

    transfers.push(...parseNativeTransfers(tx, network));
    transfers.push(...parseTokenTransfers(tx, network));
  }

  // Оставляем только переводы, где адрес действительно участвует.
  //
  // ЗАЧЕМ ЭТО НУЖНО ИМЕННО ЗДЕСЬ. Enhanced API отдаёт транзакции, где
  // адрес УПОМЯНУТ, а не где он двигает средства. Для обычного кошелька
  // разницы почти нет, а вот для адреса-пула она полная: замерено на
  // пуле PUMP_AMM — 612 переводов в ответе, с его участием НИ ОДНОГО,
  // все между третьими сторонами.
  //
  // Остальные провайдеры отдают именно переводы адреса, и код выше
  // рассчитывает на это: сохранив чужое, мы пометили бы адрес как
  // загруженный, не загрузив о нём ничего.
  const mine = transfers.filter(
    (transfer) => transfer.fromAddress === addr || transfer.toAddress === addr,
  );

  const goingDown = Boolean(options.loadMore);

  // Верхняя граница растёт только при движении вверх: догрузка приносит
  // старое, и обновлять ею отметку свежести нельзя
  const lastSignature = goingDown
    ? (state.lastSignature ?? null)
    : (page.newestSignature ?? state.lastSignature ?? null);

  let pendingBefore = state.pendingBefore ?? null;

  if (page.exhausted) {
    // Дочитали до дна — но только в том направлении, куда шли
    pendingBefore = goingDown ? null : pendingBefore;
  } else if (page.oldestSignature) {
    pendingBefore = page.oldestSignature;
  }

  return {
    transfers: mine,
    syncState: { ...state, lastSignature, pendingBefore },
    hasMore: pendingBefore !== null,
  };
}

/**
 * Баланс адреса: SOL и токены.
 *
 * В отличие от EVM, здесь список токенов доступен одним запросом —
 * getTokenAccountsByOwner отдаёт все счета владельца сразу.
 *
 * @param {string} networkKey
 * @param {string} addr
 */
export async function fetchBalance(networkKey, addr) {
  const network = getNetwork(networkKey);

  const [lamports, accounts] = await Promise.all([
    callRpc('getBalance', [addr]),
    callRpc('getTokenAccountsByOwner', [
      addr,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' },
    ]),
  ]);

  // Складываем ПО ТОКЕНУ, а не по счёту.
  //
  // У владельца может быть несколько токен-аккаунтов одного и того же
  // токена — биржи заводят их десятками. Замерено на кошельке Binance:
  // USDT встретился 15 раз, USDC 17. Без сложения интерфейс показывал бы
  // полтора десятка строк «USDT» с разными суммами вместо одной.
  const byMint = new Map();

  for (const account of accounts?.value ?? []) {
    const info = account.account?.data?.parsed?.info ?? {};
    const amount = info.tokenAmount?.amount ?? '0';

    // Пустые счета остаются после переводов и только засоряют баланс
    if (amount === '0' || !info.mint) continue;

    // Суммы складываем как BigInt: у токенов с девятью знаками они
    // выходят за предел точного целого в JavaScript
    const previous = byMint.get(info.mint) ?? 0n;
    byMint.set(info.mint, previous + BigInt(amount));
  }

  const tokens = [...byMint.entries()].map(([contractAddress, balance]) => ({
    contractAddress,
    balance: balance.toString(),
  }));

  return {
    native: {
      balance: String(lamports?.value ?? 0),
      // Аренды и стейкинга в понимании Tron здесь нет
      frozen: '0',
      decimals: network.nativeDecimals,
      symbol: network.nativeSymbol,
    },
    tokens,
  };
}

export const provider = {
  family: 'solana',
  fetchTransfers,
  fetchBalance,
};

export const __testing = {
  parseTokenTransfers,
  parseNativeTransfers,
  exactAmounts,
  fetchPages,
  fetchTokenMeta,
  evictTokenMeta,
  horizonSeconds,
  TOKEN_META_LIMIT,
  toDate,
  tokenMetaCache,
  PAGE_SIZE,
};

export default provider;
