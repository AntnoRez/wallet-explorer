/**
 * Провайдер данных Etherscan V2 — все EVM-сети.
 *
 * ОДИН ПРОВАЙДЕР НА МНОГО СЕТЕЙ. В отличие от tronGrid.js, который жёстко
 * привязан к Tron, здесь сеть приходит параметром: у Etherscan V2 один
 * эндпоинт и один ключ на все цепи, а различает их chainid. Поэтому каждая
 * экспортируемая функция первым аргументом получает ключ сети.
 *
 * Три источника, все в одном API:
 *
 *   txlist          нативные переводы (ETH, MATIC...)
 *   tokentx         переводы ERC-20
 *   txlistinternal  внутренние переводы (то, что контракт двигает внутри себя)
 *
 * Здесь легче, чем в Tron: там ради внутренних переводов пришлось подключать
 * второй сервис (TronScan), потому что TronGrid их не отдаёт вовсе.
 *
 * ЧТО ЗДЕСЬ НЕПРИЯТНО — и почему код ниже сложнее наивного «взять 1000 штук»:
 *
 *   1. У tokentx НЕТ logIndex. Одна транзакция с десятком переводов даёт
 *      десяток записей с одинаковым (hash, transactionIndex), причём среди
 *      них встречаются полные дубли. Различить их нечем — см. решение
 *      в assignTransferIndexes().
 *   2. offset молча режется до 1000: запросил больше — получил 1000 без
 *      всякой ошибки.
 *   3. Потолок глубины page * offset <= 10000. За ним приходит пустой
 *      result и status != 1, БЕЗ сообщения об ошибке. Поэтому пагинация
 *      здесь по диапазону блоков, а не по номеру страницы.
 *   4. timeStamp в СЕКУНДАХ. В Tron — в миллисекундах. Перепутать легко,
 *      результат — транзакции в 1970 году.
 */

import axios from 'axios';

import { config } from '../../config/env.js';
import { getNetwork } from '../../config/networks.js';
import { toCanonical } from '../normalize/evmAddress.js';

/** Единый вход Etherscan V2 — домен один для всех сетей */
const API_BASE = 'https://api.etherscan.io/v2/api';

/**
 * Записей за один запрос.
 *
 * Больше просить бессмысленно: API молча режет до 1000. Проверено —
 * запрос с offset=10000 вернул ровно 1000 записей и status=1.
 */
const PAGE_SIZE = 1000;

/**
 * Сколько балансов токенов запрашиваем одновременно.
 *
 * Замерено на девяти токенах: последовательно 3.9 с, тройками 3.3 с.
 * Выигрыш скромный, но лимит не даёт больше — залп из пяти запросов
 * получает два отказа из пяти (проверено), а увеличение паузы только
 * замедляет.
 *
 * Если понадобится радикально быстрее — выносить балансы токенов из
 * основного ответа и догружать отдельным запросом с фронта.
 */
const BALANCE_BATCH = 3;
const BALANCE_PAUSE_MS = 250;

/** Повторы при временных сбоях. Логика та же, что в tronGrid.js */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

/**
 * Признаки временной ошибки в ТЕЛЕ ответа.
 *
 * Etherscan умеет вернуть HTTP 200 со status "0" — и это может означать как
 * «данных нет» (нормально), так и «превышен лимит» (надо повторить).
 * Различаем по тексту result.
 */
const RATE_LIMIT_MARKERS = ['rate limit', 'max calls per sec', 'too many'];

/**
 * Тексты, означающие «данных нет» — это НЕ ошибка.
 * Etherscan отвечает так на пустой список, и падать здесь неправильно.
 */
const EMPTY_MARKERS = ['no transactions found', 'no records found'];

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30_000,
});

/* --------------------------------- Транспорт ------------------------------ */

/**
 * Запрос к API с повторами.
 *
 * @param {object} network описание сети из config/networks.js
 * @param {object} params параметры запроса (module, action, address...)
 * @returns {Promise<any>} поле result из ответа
 */
async function get(network, params) {
  // Ключ обязателен, в отличие от TronGrid: V2 без него не отвечает вовсе.
  // Проверяем явно, иначе получим невнятное NOTOK на каждый запрос
  if (!config.api.etherscanKey) {
    throw new Error(
      'Не задан ETHERSCAN_API_KEY — Etherscan V2 без ключа не отвечает. ' +
        'Получить: https://etherscan.io/myapikey',
    );
  }

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await client.get('', {
        params: {
          chainid: network.chainId,
          apikey: config.api.etherscanKey,
          ...params,
        },
      });

      const body = response.data ?? {};
      const result = body.result;

      if (body.status === '1') return result;

      // Пустой список при status "0" — это «данных нет», а не сбой.
      // Проверять надо ДО разбора текста: у адреса без истории приходит
      // {"status":"0","message":"No transactions found","result":[]},
      // и String([]) даёт пустую строку, в которой маркеров не найти
      if (Array.isArray(result)) return result;

      // Текст ошибки бывает и в result, и в message — смотрим оба
      const text = `${result ?? ''} ${body.message ?? ''}`.toLowerCase();

      // «Ничего не найдено» — это пустой ответ, а не сбой
      if (EMPTY_MARKERS.some((marker) => text.includes(marker))) return [];

      // Пустота за потолком page * offset > 10000 приходит без текста вовсе.
      // Считаем её концом данных: выше по коду мы туда и не должны заходить
      if (result === null || result === undefined) return [];

      if (RATE_LIMIT_MARKERS.some((marker) => text.includes(marker))) {
        throw new Error(`превышен лимит запросов: ${text.slice(0, 120)}`);
      }

      // Платный тариф, неверный ключ и подобное — повторять бессмысленно
      throw Object.assign(
        new Error(
          `Etherscan вернул ошибку: ${String(result ?? body.message).slice(0, 200)}`,
        ),
        { permanent: true },
      );
    } catch (error) {
      if (error.permanent) throw error;

      lastError = error;

      const status = error.response?.status;
      const retriable = status === 429 || status === undefined || status >= 500;

      if (!retriable || attempt === MAX_RETRIES) break;

      // Нарастающая пауза: 0.5 с, 1 с, 2 с
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }

  throw new Error(
    `Запрос к Etherscan не удался (${params.action}, chainid=${network.chainId}): ` +
      `${lastError?.message ?? 'неизвестная ошибка'}`,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Тот же запрос, но результат гарантированно массив — для списков переводов */
async function getRows(network, params) {
  const result = await get(network, params);
  return Array.isArray(result) ? result : [];
}

/* ------------------------------ Разбор ответов ---------------------------- */

/**
 * timeStamp приходит в СЕКУНДАХ — главное отличие от Tron, где
 * block_timestamp в миллисекундах.
 *
 * @param {string} seconds
 */
function toDate(seconds) {
  const value = Number(seconds);
  return Number.isFinite(value) ? new Date(value * 1000) : null;
}

/** Адрес из ответа API к нашей канонической форме. Пустая строка — это null */
function address(raw) {
  if (!raw) return null;
  try {
    return toCanonical(raw);
  } catch {
    // Мусор в поле адреса — не повод ронять весь заход
    return null;
  }
}

/**
 * Нативные переводы из txlist.
 *
 * ФИЛЬТР ОБЯЗАТЕЛЕН. txlist отдаёт транзакции целиком, включая вызовы
 * контрактов с нулевой суммой: сам перевод токена лежит в tokentx, а здесь
 * от него остаётся оболочка со значением "0". Один в один
 * TriggerSmartContract в Tron. Без фильтра граф зарастает нулевыми рёбрами.
 *
 * @param {object[]} rows
 * @param {object} network
 */
function parseNativeTransfers(rows, network) {
  const transfers = [];

  for (const row of rows) {
    // Неуспешные транзакции денег не двигают
    if (row.isError === '1' || row.txreceipt_status === '0') continue;

    const value = String(row.value ?? '0');
    if (value === '0') continue;

    const from = address(row.from);
    const to = address(row.to);
    if (!from || !to) continue;

    transfers.push({
      network: network.key,
      hash: row.hash,
      // В одной транзакции ровно один нативный перевод — уточнять нечем
      transferIndex: 'n',
      transferType: 'native',
      fromAddress: from,
      toAddress: to,
      value,
      tokenSymbol: network.nativeSymbol,
      tokenContractAddress: null,
      decimals: network.nativeDecimals,
      blockNumber: Number(row.blockNumber),
      blockTimestamp: toDate(row.timeStamp),
    });
  }

  return transfers;
}

/**
 * Переводы ERC-20 из tokentx.
 *
 * transferIndex здесь НЕ финальный — его проставляет assignTransferIndexes()
 * после сбора всей пачки: он зависит от соседей по транзакции.
 *
 * @param {object[]} rows
 * @param {object} network
 */
function parseTokenTransfers(rows, network) {
  const transfers = [];

  for (const row of rows) {
    const from = address(row.from);
    const to = address(row.to);
    if (!from || !to) continue;

    // Нулевые переводы токенов — это «отравление адресной книги»: шлют
    // 0 USDC с адреса, похожего на настоящий, чтобы жертва скопировала его
    // из истории и отправила деньги не туда. Замерено на живом кошельке:
    // 12 таких записей из 1373. Движения средств в них нет, в графе они
    // дают только ложные рёбра
    const value = String(row.value ?? '0');
    if (value === '0') continue;

    // tokenDecimal приходит строкой и иногда пустой — тогда «неизвестно»,
    // а не 0: показать сырое число честнее, чем сдвинуть запятую наугад
    const raw = row.tokenDecimal;
    const decimals = raw === '' || raw === undefined || raw === null ? null : Number(raw);

    transfers.push({
      network: network.key,
      hash: row.hash,
      transferIndex: null,
      transferType: 'token',
      fromAddress: from,
      toAddress: to,
      value,
      tokenSymbol: row.tokenSymbol || null,
      tokenContractAddress: address(row.contractAddress),
      decimals: Number.isFinite(decimals) ? decimals : null,
      blockNumber: Number(row.blockNumber),
      blockTimestamp: toDate(row.timeStamp),
    });
  }

  return transfers;
}

/**
 * Внутренние переводы из txlistinternal.
 *
 * ВНИМАНИЕ: traceId ключом НЕ ГОДИТСЯ, хотя выглядит именно так. Проверено
 * на живых данных — он повторяется внутри одной транзакции:
 *
 *   i:0_1_1_1_1   ETH 165500000000
 *   i:0_1_1_1_1   ETH 993000000000   <- тот же traceId, другая сумма
 *   i:0_1_1_1_1   ETH 198600000000
 *
 * Три записи схлопнулись бы в базе в одну. Поэтому индекс здесь такой же
 * позиционный, как у токенов.
 *
 * @param {object[]} rows
 * @param {object} network
 */
function parseInternalTransfers(rows, network) {
  const transfers = [];

  for (const row of rows) {
    if (row.isError === '1') continue;

    const value = String(row.value ?? '0');
    if (value === '0') continue;

    const from = address(row.from);
    const to = address(row.to);
    if (!from || !to) continue;

    transfers.push({
      network: network.key,
      hash: row.hash,
      // Проставляется в assignTransferIndexes(), как у токенов
      transferIndex: null,
      transferType: 'internal',
      fromAddress: from,
      toAddress: to,
      value,
      tokenSymbol: network.nativeSymbol,
      tokenContractAddress: null,
      decimals: network.nativeDecimals,
      blockNumber: Number(row.blockNumber),
      blockTimestamp: toDate(row.timeStamp),
    });
  }

  return transfers;
}

/**
 * Проставить transferIndex токенным переводам.
 *
 * ЗАЧЕМ. Первичный ключ у нас (network, hash, transferIndex). У tokentx НЕТ
 * logIndex, а transactionIndex — это номер транзакции в блоке, общий для
 * всех переводов внутри неё. Реальный пример с Uniswap V3:
 *
 *   одна транзакция = 11 переводов, у всех transactionIndex = 2,
 *   причём DAI 3708913829464557701320 встречается ДВАЖДЫ — записи
 *   совпадают целиком, до последней цифры суммы
 *
 * Значит ни transactionIndex, ни хэш от содержимого ключом быть не могут.
 * Остаётся позиция в ответе: Etherscan отдаёт переводы транзакции подряд и
 * в стабильном порядке (по logIndex), поэтому порядковый номер внутри
 * транзакции воспроизводим от запроса к запросу.
 *
 * ЭТО РАБОТАЕТ ТОЛЬКО ПОТОМУ, ЧТО ПАГИНАЦИЯ У НАС ПО БЛОКАМ. Пачка всегда
 * содержит блок целиком, значит транзакция не разрывается между заходами и
 * нумерация не съезжает. См. fetchChunk().
 *
 * @param {object[]} transfers переводы одной пачки, в порядке ответа API
 */
function assignTransferIndexes(transfers, prefix) {
  const seen = new Map();

  for (const transfer of transfers) {
    const position = seen.get(transfer.hash) ?? 0;
    seen.set(transfer.hash, position + 1);
    transfer.transferIndex = `${prefix}:${position}`;
  }

  return transfers;
}

/* -------------------------------- Пагинация ------------------------------- */

/**
 * Запас на реорганизацию цепи, в блоках.
 *
 * В конфиге запас задан в секундах (так удобнее думать), а Etherscan
 * фильтрует по номерам блоков — переводим через среднее время блока сети.
 *
 * @param {object} network
 */
function reorgBufferBlocks(network) {
  const blockTime = network.blockTimeSec || 12;
  return Math.ceil(network.reorgBufferSec / blockTime);
}

/**
 * Кэш горизонта: chainId -> { block, expiresAt }.
 *
 * Горизонт сдвигается со скоростью цепи, то есть медленно в масштабе
 * запроса. Держим 10 минут, чтобы не тратить обращение к API на каждый
 * из трёх источников и на каждый адрес.
 */
const horizonCache = new Map();
const HORIZON_TTL_MS = 10 * 60 * 1000;

/**
 * Запросы горизонта, которые сейчас в полёте: chainId -> Promise.
 *
 * Три источника стартуют через Promise.all и упираются в пустой кэш
 * одновременно — без этого получалось три одинаковых запроса вместо
 * одного. Кэшируем не результат, а обещание.
 */
const horizonInflight = new Map();

/**
 * Нижняя граница выборки: глубже горизонта графа не копаем.
 *
 * Показываем мы последние GRAPH_DAYS дней — значит и догонять хвост глубже
 * бессмысленно. Без этого «загрузить ещё» тянет историю до самого первого
 * перевода адреса: запросы, трафик и строки в базе ради данных, которые
 * граф всё равно отфильтрует при чтении. В tronGrid.js это applyHorizon().
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ЗАПРОС, А НЕ ОЦЕНКА ЧЕРЕЗ СРЕДНЕЕ ВРЕМЯ БЛОКА.
 * Оценка врёт, и сильно: для Arbitrum со средним временем блока около
 * секунды расчёт даёт вчетверо меньшую глубину, чем есть на самом деле, —
 * горизонт в 30 дней превратился бы в 7. Эндпоинт getblocknobytime
 * отвечает точным номером и на бесплатном тарифе открыт.
 *
 * GRAPH_DAYS=0 — без ограничения.
 *
 * @param {object} network
 * @returns {Promise<number>} номер блока, ниже которого не опускаемся
 */
async function horizonBlock(network) {
  if (config.app.graphDays <= 0) return 0;

  const cached = horizonCache.get(network.chainId);
  if (cached && cached.expiresAt > Date.now()) return cached.block;

  const inflight = horizonInflight.get(network.chainId);
  if (inflight) return inflight;

  const request = requestHorizon(network).finally(() => {
    horizonInflight.delete(network.chainId);
  });

  horizonInflight.set(network.chainId, request);
  return request;
}

/**
 * Собственно запрос горизонта. Вынесен отдельно, чтобы horizonBlock()
 * занимался только кэшированием.
 *
 * @param {object} network
 * @returns {Promise<number>}
 */
async function requestHorizon(network) {
  const timestamp = Math.floor(Date.now() / 1000) - config.app.graphDays * 24 * 60 * 60;

  let block = 0;

  try {
    const result = await get(network, {
      module: 'block',
      action: 'getblocknobytime',
      timestamp,
      closest: 'before',
    });

    const parsed = Number(result);
    if (Number.isFinite(parsed) && parsed > 0) block = parsed;
  } catch (error) {
    // Горизонт — оптимизация, а не корректность. Не смогли узнать —
    // работаем без него, но повторим попытку после истечения кэша
    console.warn(
      `[evmEtherscan] горизонт для chainid=${network.chainId} недоступен: ${error.message}`,
    );
    return 0;
  }

  horizonCache.set(network.chainId, { block, expiresAt: Date.now() + HORIZON_TTL_MS });
  return block;
}

/**
 * Забрать одну пачку записей источника и отрезать её по границе блока.
 *
 * ПОЧЕМУ ГРАНИЦА ИМЕННО ПО БЛОКУ. Если оборвать пачку на произвольной
 * записи, транзакция с несколькими переводами окажется разорванной между
 * заходами — и нумерация transferIndex поедет: при следующем заходе те же
 * переводы получат другие номера и лягут в базу ВТОРОЙ раз, задвоив суммы.
 *
 * Поэтому: пачка полная -> отбрасываем самый старый блок целиком и
 * возвращаемся к нему в следующий заход.
 *
 * Вырожденный случай: один блок дал записей больше, чем помещается в пачку.
 * Тогда отбрасывать нечего — иначе зациклимся на нём навсегда. Берём как
 * есть, теряя гарантию целостности транзакций.
 *
 * @param {object} network
 * @param {string} action txlist | tokentx | txlistinternal
 * @param {string} addr адрес
 * @param {{ startBlock: number, endBlock: number }} range
 * @returns {Promise<{ rows: object[], oldestBlock: number|null, complete: boolean }>}
 */
async function fetchChunk(network, action, addr, { startBlock, endBlock }) {
  const rows = await getRows(network, {
    module: 'account',
    action,
    address: addr,
    startblock: startBlock,
    endblock: endBlock,
    page: 1,
    offset: PAGE_SIZE,
    // desc — свежие первыми: нас интересует последнее, а не история с нуля
    sort: 'desc',
  });

  if (rows.length === 0) {
    return { rows: [], oldestBlock: null, complete: true };
  }

  // Пачка неполная — значит диапазон вычерпан до дна, резать не нужно
  if (rows.length < PAGE_SIZE) {
    const oldest = Math.min(...rows.map((row) => Number(row.blockNumber)));
    return { rows, oldestBlock: oldest, complete: true };
  }

  const oldest = Math.min(...rows.map((row) => Number(row.blockNumber)));
  const trimmed = rows.filter((row) => Number(row.blockNumber) > oldest);

  if (trimmed.length === 0) {
    // Один блок не влез в пачку целиком — редчайший случай, берём как есть
    // и продолжаем ниже него, иначе зациклимся на этом блоке навсегда
    return { rows, oldestBlock: oldest - 1, complete: false };
  }

  return {
    rows: trimmed,
    // Самый старый блок остался непрочитанным — вернёмся к нему
    oldestBlock: oldest,
    complete: false,
  };
}

/**
 * Забрать данные одного источника с учётом состояния синхронизации.
 *
 * Состояние устроено как в tronGrid.js — ДВЕ НЕЗАВИСИМЫЕ ГРАНИЦЫ, но
 * в номерах блоков, а не в метках времени:
 *
 *   lastBlock       самый свежий известный блок — точка отсчёта вверх
 *   pendingMinBlock докуда дочитано вниз; не null означает, что ниже
 *                   остался непрочитанный промежуток
 *
 * Зачем две: наивная схема «всегда берём свежие и двигаем отметку» теряет
 * середину, если между обращениями случилось больше переводов, чем влезает
 * в лимит. Подробное объяснение — в tronGrid.js, здесь та же механика.
 *
 * @param {object} network
 * @param {string} action
 * @param {string} addr
 * @param {{ lastBlock?: number|null, pendingMinBlock?: number|null }} [rawState]
 * @param {{ loadMore?: boolean }} [options]
 */
async function fetchSource(network, action, addr, rawState, { loadMore = false } = {}) {
  const state = rawState ?? {};
  const isFirstFetch = !state.lastBlock;

  // Просят догрузить вниз, а хвоста нет — источник вычерпан. Запрос не
  // делаем вовсе: иначе ушли бы вверх и вернули уже известное
  if (loadMore && !isFirstFetch && !state.pendingMinBlock) {
    return { rows: [], nextState: { ...state, pendingMinBlock: null } };
  }

  const maxPages = isFirstFetch
    ? config.app.firstFetchPages
    : config.app.maxPagesPerFetch;

  // Глубже горизонта не копаем ни в одном из режимов, включая первый заход
  let startBlock = await horizonBlock(network);
  let endBlock = 99_999_999;

  if (loadMore && state.pendingMinBlock) {
    // Вниз: от места, где остановились в прошлый раз
    endBlock = state.pendingMinBlock;
  } else if (!isFirstFetch) {
    // Вверх: с запасом на реорганизацию — последние блоки не окончательны,
    // и перезапрос этого отрезка (с upsert) исправит данные, если цепь
    // откатилась
    startBlock = Math.max(startBlock, state.lastBlock - reorgBufferBlocks(network));
  }

  const collected = [];
  let oldestReached = null;
  let exhausted = false;

  for (let page = 0; page < maxPages; page += 1) {
    const chunk = await fetchChunk(network, action, addr, { startBlock, endBlock });

    collected.push(...chunk.rows);

    if (chunk.complete) {
      exhausted = true;
      break;
    }

    oldestReached = chunk.oldestBlock;
    // Следующая пачка начинается С ЭТОГО ЖЕ блока, а не ниже него:
    // fetchChunk() вернул границу как «первый НЕпрочитанный блок».
    // Минус единица здесь пропускала бы его навсегда
    endBlock = chunk.oldestBlock;

    if (endBlock < startBlock) {
      exhausted = true;
      break;
    }
  }

  const newestBlock = collected.length
    ? Math.max(...collected.map((row) => Number(row.blockNumber)))
    : null;

  // Верхняя граница только растёт: догрузка вниз не должна её сбивать
  const lastBlock = Math.max(state.lastBlock ?? 0, newestBlock ?? 0) || null;

  let pendingMinBlock = state.pendingMinBlock ?? null;

  if (exhausted) {
    // Дочитали до дна ЗАПРОШЕННОГО диапазона. Но обнулять хвост можно
    // только если шли вниз: заход вверх вычерпывает лишь свежий отрезок
    // [lastBlock - буфер, ...], а непрочитанный промежуток НИЖЕ от этого
    // никуда не делся. Обнуление здесь гасило бы кнопку «загрузить ещё»
    // и делало старые переводы недостижимыми навсегда
    pendingMinBlock = loadMore ? null : (state.pendingMinBlock ?? null);
  } else if (oldestReached !== null) {
    // Уперлись в потолок страниц: запоминаем, где встали. Выше не поднимаем,
    // иначе следующая догрузка заново прошла бы уже прочитанное
    pendingMinBlock = pendingMinBlock
      ? Math.min(pendingMinBlock, oldestReached)
      : oldestReached;
  }

  return { rows: collected, nextState: { lastBlock, pendingMinBlock } };
}

/* --------------------------- Публичный интерфейс -------------------------- */

/**
 * Забрать переводы адреса.
 *
 * Контракт, общий для всех провайдеров: получает состояние синхронизации,
 * возвращает переводы и НОВОЕ состояние. Что внутри syncState — дело
 * провайдера, вызывающий код только хранит его и отдаёт обратно.
 *
 * @param {string} networkKey ключ сети из config/networks.js
 * @param {string} addr адрес в канонической форме (строчный hex)
 * @param {object} [rawSyncState] предыдущее состояние из БД
 * @param {{ loadMore?: boolean }} [options]
 * @returns {Promise<{ transfers: object[], syncState: object, hasMore: boolean }>}
 */
export async function fetchTransfers(networkKey, addr, rawSyncState, options = {}) {
  const network = getNetwork(networkKey);
  // Из БД может прийти null — значение по умолчанию его не перехватывает
  const syncState = rawSyncState ?? {};

  // Три источника независимы — запрашиваем параллельно. Лимит 5 запросов
  // в секунду это выдерживает: три запроса разом проходят
  const [native, token, internal] = await Promise.all([
    fetchSource(network, 'txlist', addr, syncState.native, options),
    fetchSource(network, 'tokentx', addr, syncState.token, options),
    fetchSource(network, 'txlistinternal', addr, syncState.internal, options),
  ]);

  const transfers = [
    ...parseNativeTransfers(native.rows, network),
    // Префиксы t и i не дают источникам столкнуться: у одной транзакции
    // бывает и нативный перевод, и токенные, и внутренние — все с одним hash
    ...assignTransferIndexes(parseTokenTransfers(token.rows, network), 't'),
    ...assignTransferIndexes(parseInternalTransfers(internal.rows, network), 'i'),
  ];

  return {
    transfers,
    syncState: {
      ...syncState,
      native: native.nextState,
      token: token.nextState,
      internal: internal.nextState,
    },
    // Ниже остался непрочитанный промежуток — фронт покажет «загрузить ещё»
    hasMore:
      native.nextState.pendingMinBlock !== null ||
      token.nextState.pendingMinBlock !== null ||
      internal.nextState.pendingMinBlock !== null,
  };
}

/**
 * Текущий баланс адреса.
 *
 * ТОЛЬКО НАТИВНЫЙ. Список токенов на балансе одним запросом отдаёт
 * addresstokenbalance — это PRO-эндпоинт, на бесплатном тарифе закрыт
 * ("Sorry, it looks like you are trying to access an API Pro endpoint").
 *
 * Баланс КОНКРЕТНОГО токена доступен бесплатно (action=tokenbalance), но
 * требует адрес контракта. Список контрактов у нас есть — он собирается из
 * уже сохранённых переводов адреса, поэтому догрузка токенных балансов
 * вынесена в fetchTokenBalances(): провайдер не ходит в базу сам.
 *
 * @param {string} networkKey
 * @param {string} addr
 */
export async function fetchBalance(networkKey, addr) {
  const network = getNetwork(networkKey);

  const result = await get(network, {
    module: 'account',
    action: 'balance',
    address: addr,
    tag: 'latest',
  });

  // У action=balance result — строка, а не массив
  const balance = typeof result === 'string' ? result : '0';

  return {
    // Ключ native, а не trx: поле называется по смыслу, а не по сети.
    // tronGrid.js приведён к тому же имени
    native: {
      balance,
      // Заморозки под ресурсы, как в Tron, в EVM нет
      frozen: '0',
      decimals: network.nativeDecimals,
      symbol: network.nativeSymbol,
    },
    tokens: [],
  };
}

/**
 * Балансы конкретных токенов — по адресам контрактов.
 *
 * Каждый токен это отдельный запрос, поэтому список приходит снаружи и
 * заведомо коротким: контракты, которые реально встречались в переводах
 * адреса. Запросы идут последовательно — при 5 rps параллельный залп
 * отбивается целиком, это уже проходили с метками TronScan.
 *
 * @param {string} networkKey
 * @param {string} addr
 * @param {string[]} contractAddresses
 * @returns {Promise<Array<{ contractAddress: string, balance: string }>>}
 */
export async function fetchTokenBalances(networkKey, addr, contractAddresses) {
  const network = getNetwork(networkKey);
  const balances = [];

  for (let i = 0; i < contractAddresses.length; i += BALANCE_BATCH) {
    const batch = contractAddresses.slice(i, i + BALANCE_BATCH);

    const results = await Promise.all(
      batch.map(async (contractAddress) => {
        try {
          const result = await get(network, {
            module: 'account',
            action: 'tokenbalance',
            contractaddress: contractAddress,
            address: addr,
            tag: 'latest',
          });

          const balance = typeof result === 'string' ? result : '0';
          return balance === '0' ? null : { contractAddress, balance };
        } catch (error) {
          // Один нечитаемый токен не должен ронять весь баланс
          console.warn(
            `[evmEtherscan] баланс токена ${contractAddress} недоступен: ${error.message}`,
          );
          return null;
        }
      }),
    );

    balances.push(...results.filter(Boolean));

    // Пауза между пачками держит нас в пределах лимита: три запроса
    // отрабатывают примерно за 430 мс, плюс пауза — выходит около
    // 4.5 запроса в секунду при разрешённых пяти
    if (i + BALANCE_BATCH < contractAddresses.length) await sleep(BALANCE_PAUSE_MS);
  }

  return balances;
}

export const provider = {
  family: 'evm',
  fetchTransfers,
  fetchBalance,
  fetchTokenBalances,
};

export const __testing = {
  parseNativeTransfers,
  parseTokenTransfers,
  parseInternalTransfers,
  assignTransferIndexes,
  fetchChunk,
  fetchSource,
  reorgBufferBlocks,
  horizonBlock,
  toDate,
  PAGE_SIZE,
};

export default provider;
