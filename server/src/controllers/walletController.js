/**
 * HTTP-слой для кошельков.
 *
 * Здесь только разбор запроса, вызов сервисов и формирование ответа.
 * Ни обращений к API, ни SQL, ни знания о том, что источников три.
 */

import { config } from '../config/env.js';
import { listNetworkKeys, getNetwork, NETWORKS } from '../config/networks.js';
import { parseUserAddress, isValidUserAddress } from '../services/chainData.js';
import {
  syncAddress,
  readTransfers,
  readAddressMeta,
  countTransfers,
  getBalance,
} from '../services/walletService.js';
import { buildGraph } from '../services/graphBuilder.js';
import { getLabels } from '../services/labelService.js';

/**
 * Жёсткий потолок на объём ответа.
 *
 * В walletService значение limit = 0 означает «без ограничения» — так
 * эвристике нужна вся выборка. Но наружу это открывать нельзя: запрос
 * ?limit=0&topNodes=0 вернул 1.26 МБ и 1208 узлов, а при росте базы вернёт
 * десятки мегабайт. Поэтому HTTP-слой подменяет 0 на потолок.
 */
const HTTP_MAX_TRANSFERS = 5000;

/** То же для количества узлов графа */
const HTTP_MAX_NODES = 300;

/**
 * Ошибка, которую можно показать пользователю.
 *
 * Обычные исключения наружу не выносим: в них бывают внутренние детали,
 * а текст не рассчитан на чтение человеком.
 */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {object} [details]
   */
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Прочитать число из строки запроса.
 *
 * Пустое значение — не ошибка, а «параметр не задан»: вернём undefined,
 * и ниже подставится значение по умолчанию.
 *
 * @param {unknown} raw
 * @param {string} name
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number|undefined}
 */
function numberParam(raw, name, bounds = {}) {
  if (raw === undefined || raw === '') return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ApiError(400, `Параметр ${name} должен быть числом, получено: "${raw}"`);
  }
  if (bounds.integer && !Number.isInteger(value)) {
    throw new ApiError(400, `Параметр ${name} должен быть целым числом, получено: "${raw}"`);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new ApiError(400, `Параметр ${name} не может быть меньше ${bounds.min}`);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new ApiError(400, `Параметр ${name} не может быть больше ${bounds.max}`);
  }
  return value;
}

/**
 * Прочитать флаг: ?refresh=1, ?refresh=true, ?refresh
 * @param {unknown} raw
 */
function flagParam(raw) {
  if (raw === undefined) return false;
  if (raw === '') return true; // ?refresh без значения
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * Подменить 0 («без ограничения») на потолок.
 * @param {number|undefined} value
 * @param {number} ceiling
 */
function clampToCeiling(value, ceiling) {
  if (value === undefined) return undefined;
  return value === 0 ? ceiling : Math.min(value, ceiling);
}

/**
 * Проверить сеть и вернуть её ключ.
 * @param {string} raw
 */
function resolveNetwork(raw) {
  const key = raw || config.app.defaultNetwork;

  try {
    getNetwork(key);
    return key;
  } catch {
    throw new ApiError(400, `Сеть "${key}" не поддерживается`, {
      supported: listNetworkKeys(),
    });
  }
}

/**
 * GET /api/wallet/:network/:address
 *
 * Возвращает граф переводов, баланс и сведения о состоянии загрузки.
 *
 * Параметры строки запроса:
 *   days      глубина выборки в днях (0 — всё, что есть в базе)
 *   topNodes  сколько контрагентов показать поимённо (0 — всех)
 *   minShare  порог значимости, доля от объёма токена (0 — не фильтровать)
 *   limit     максимум переводов, читаемых из базы
 *   refresh   игнорировать TTL кэша — кнопка «обновить»
 *   loadMore  догрузить более старые переводы — кнопка «загрузить ещё»
 */
export async function getWallet(req, res) {
  const networkKey = resolveNetwork(req.params.network);

  // Адрес разбираем СТРОГО: формат 0x... неотличим от адреса Ethereum,
  // и молча показать чужой кошелёк хуже, чем отказать
  let address;
  try {
    address = parseUserAddress(networkKey, req.params.address);
  } catch (error) {
    throw new ApiError(400, error.message);
  }

  const days = numberParam(req.query.days, 'days', { min: 0, max: 3650, integer: true });
  const minShare = numberParam(req.query.minShare, 'minShare', { min: 0, max: 1 });

  // 0 снаружи означает «максимум», а не «без ограничения»:
  // безлимитный ответ доступен только внутреннему коду
  const topNodes = clampToCeiling(
    numberParam(req.query.topNodes, 'topNodes', { min: 0, max: HTTP_MAX_NODES, integer: true }),
    HTTP_MAX_NODES,
  );
  const limit = clampToCeiling(
    numberParam(req.query.limit, 'limit', { min: 0, max: HTTP_MAX_TRANSFERS, integer: true }),
    HTTP_MAX_TRANSFERS,
  );

  const force = flagParam(req.query.refresh);
  const loadMore = flagParam(req.query.loadMore);

  // 1. Синхронизация: сходит во внешние API, если кэш устарел или
  //    пользователь попросил явно
  let sync;
  try {
    sync = await syncAddress(networkKey, address, { force, loadMore });
  } catch (error) {
    // Внешний сервис недоступен — это 502, а не 500: наша часть исправна
    throw new ApiError(502, 'Источник данных блокчейна недоступен, попробуйте позже', {
      reason: error.message,
    });
  }

  // 2. Чтение ИЗ БАЗЫ. Именно из базы, а не из ответа API: при попадании
  //    в кэш ответа нет вовсе, а в базе лежит и то, что мы узнали об этом
  //    адресе раньше — при разборе соседей.
  const [transfers, totalTransfers, balance] = await Promise.all([
    readTransfers(networkKey, address, { days, limit }),
    countTransfers(networkKey, address, { days }),
    // Баланс — отдельный запрос к API, из переводов он не выводится.
    // Если не ответил, граф всё равно показываем.
    getBalance(networkKey, address).catch((error) => ({ error: error.message })),
  ]);

  // 3. Пометки адресов: раскрыт узел или известен косвенно
  const addresses = [
    ...new Set(transfers.flatMap((t) => [t.fromAddress, t.toAddress]).filter(Boolean)),
  ];
  const meta = await readAddressMeta(networkKey, addresses);

  // 4. Граф
  const graph = buildGraph(transfers, address, meta, { topNodes, minShare });

  const network = getNetwork(networkKey);

  res.json({
    network: {
      key: network.key,
      name: network.name,
      nativeSymbol: network.nativeSymbol,
      explorerAddress: network.explorer.address(address),
    },
    address,
    balance: balance?.error ? { unavailable: true, reason: balance.error } : balance,
    graph,
    sync: {
      // Ходили ли во внешний API или ответили из кэша
      fetched: sync.fetched,
      saved: sync.saved,
      // Остались ли более старые переводы — фронт показывает
      // кнопку «загрузить ещё»
      hasMore: sync.hasMore,
      // Источники, которые не ответили: данные показаны неполные
      partial: sync.partial,
    },
    query: {
      days: days ?? config.app.graphDays,
      topNodes: graph.stats.applied.topNodes,
      minShare: graph.stats.applied.minShare,
      // Сколько переводов лежит в базе за период и сколько показано:
      // без этого непонятно, почему граф выглядит урезанным
      transfersInDb: totalTransfers,
      transfersUsed: transfers.length,
    },
  });
}

/**
 * GET /api/wallet/:network/:address/balance
 *
 * Отдельно от графа: баланс — единственная часть ответа, которая всегда
 * требует внешнего запроса. Фронт может показать граф сразу, а баланс
 * подтянуть следом, не задерживая отрисовку.
 */
export async function getWalletBalance(req, res) {
  const networkKey = resolveNetwork(req.params.network);

  let address;
  try {
    address = parseUserAddress(networkKey, req.params.address);
  } catch (error) {
    throw new ApiError(400, error.message);
  }

  try {
    const balance = await getBalance(networkKey, address, {
      force: flagParam(req.query.refresh),
    });
    res.json({ address, network: networkKey, balance });
  } catch (error) {
    throw new ApiError(502, 'Не удалось получить баланс', { reason: error.message });
  }
}

/**
 * GET /api/wallet/:network/:address/transfers
 *
 * Плоский список переводов — для таблицы и выгрузки. Граф не строится.
 */
export async function getTransfers(req, res) {
  const networkKey = resolveNetwork(req.params.network);

  let address;
  try {
    address = parseUserAddress(networkKey, req.params.address);
  } catch (error) {
    throw new ApiError(400, error.message);
  }

  const days = numberParam(req.query.days, 'days', { min: 0, max: 3650, integer: true });
  const limit = clampToCeiling(
    numberParam(req.query.limit, 'limit', { min: 0, max: HTTP_MAX_TRANSFERS, integer: true }),
    HTTP_MAX_TRANSFERS,
  );

  // Контрагент — для панели деталей ребра: ребро графа это все переводы
  // между парой адресов. Адрес проверяем так же строго, как основной
  let counterparty;
  if (req.query.counterparty) {
    try {
      counterparty = parseUserAddress(networkKey, req.query.counterparty);
    } catch (error) {
      throw new ApiError(400, `Параметр counterparty: ${error.message}`);
    }
  }

  const token = req.query.token ? String(req.query.token) : undefined;

  const [transfers, total] = await Promise.all([
    readTransfers(networkKey, address, { days, limit, counterparty, token }),
    countTransfers(networkKey, address, { days, counterparty, token }),
  ]);

  res.json({
    address,
    network: networkKey,
    counterparty: counterparty ?? null,
    token: token ?? null,
    total,
    count: transfers.length,
    transfers,
  });
}

/**
 * POST /api/labels
 *
 * Метки адресов: «Binance-Hot 1», теги риска.
 *
 * Отдельно от графа намеренно: запрос метки занимает 150–1100 мс и делается
 * на ОДИН адрес. Двадцать узлов графа — до двадцати секунд ожидания.
 * Поэтому фронт рисует граф сразу, а подписи обновляет, когда придут метки.
 *
 * Тело: { "addresses": ["T...", "T..."] }
 */
export async function postLabels(req, res) {
  const networkKey = resolveNetwork(req.params.network);
  const addresses = req.body?.addresses;

  if (!Array.isArray(addresses)) {
    throw new ApiError(400, 'Ожидается поле addresses со списком адресов');
  }

  // Адреса из графа уже нормализованы нами, но тело запроса приходит
  // от клиента — доверять ему нельзя
  const valid = addresses.filter(
    (address) => typeof address === 'string' && isValidUserAddress(networkKey, address),
  );

  const result = await getLabels(networkKey, valid, {
    force: flagParam(req.query.refresh),
  });

  res.json({
    network: networkKey,
    ...result,
    skipped: addresses.length - valid.length,
  });
}

/**
 * GET /api/networks — что мы вообще умеем.
 * Фронт заполняет этим селектор сетей, а не хранит список у себя.
 */
export async function getNetworks(_req, res) {
  res.json({
    default: config.app.defaultNetwork,
    networks: Object.values(NETWORKS).map((network) => ({
      key: network.key,
      name: network.name,
      family: network.family,
      nativeSymbol: network.nativeSymbol,
      nativeDecimals: network.nativeDecimals,
      addressFormat: network.addressFormat,
      explorer: network.explorer.base,
    })),
  });
}
