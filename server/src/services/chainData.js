/**
 * Единая точка доступа к данным блокчейна.
 *
 * Всё, что выше по стеку — контроллер, построитель графа, эвристика —
 * работает только с этим модулем. Ни одна из этих частей не знает, что
 * данные собираются из трёх разных эндпоинтов двух разных сервисов, что у
 * одного курсорная пагинация, а у другого офсетная, и что адреса приходят
 * в трёх форматах.
 *
 * Провайдер выбирается по полю family из справочника сетей, а НЕ по ключу
 * сети: Ethereum, Polygon и BSC будут обслуживаться одним провайдером
 * (family: 'evm'), различаясь только chainId.
 */

import { getNetwork } from '../config/networks.js';
import * as tronGrid from './providers/tronGrid.js';
import * as tronScan from './providers/tronScan.js';
import * as tronAddress from './normalize/tronAddress.js';

/**
 * Реализации по семействам сетей.
 *
 * Добавление EVM-сетей: сюда добавляется ключ 'evm' с провайдером
 * providers/evmEtherscan.js и нормализатором normalize/evmAddress.js.
 * Ни схема БД, ни код выше не меняются.
 */
const FAMILIES = {
  tron: {
    /**
     * Собрать переводы из всех источников семейства.
     *
     * TronGrid даёт нативные TRX и токены TRC-20, TronScan — внутренние
     * переводы, которых TronGrid не отдаёт вовсе.
     */
    async fetchTransfers(address, syncState = {}, options = {}) {
      // allSettled, а не all: внутренние переводы — дополнение к основной
      // картине. Если TronScan недоступен, отдать граф без них лучше, чем
      // не отдать ничего. Обратное неверно — без TronGrid показывать нечего.
      const [gridResult, scanResult] = await Promise.allSettled([
        tronGrid.fetchTransfers(address, syncState ?? {}, options),
        // ?? undefined обязательно: значение по умолчанию у параметра
        // срабатывает только для undefined, а null прошёл бы насквозь.
        // В syncState.internal null попадает после сбоя TronScan — и без
        // этой замены один временный сбой делал бы адрес навсегда
        // неработоспособным.
        tronScan.fetchTransfers(address, syncState?.internal ?? undefined, options),
      ]);

      if (gridResult.status === 'rejected') {
        throw gridResult.reason;
      }

      const grid = gridResult.value;

      if (scanResult.status === 'rejected') {
        console.warn(
          `[chainData] внутренние переводы недоступны для ${address}: ${scanResult.reason?.message}`,
        );
        return {
          transfers: grid.transfers,
          syncState: { ...grid.syncState, internal: syncState?.internal ?? null },
          hasMore: grid.hasMore,
          // Явный признак неполноты — контроллер может сообщить об этом
          // пользователю, вместо того чтобы молча показать частичный граф
          partial: ['internal'],
        };
      }

      const scan = scanResult.value;

      return {
        transfers: [...grid.transfers, ...scan.transfers],
        syncState: { ...grid.syncState, internal: scan.syncState },
        hasMore: grid.hasMore || scan.hasMore,
        partial: [],
      };
    },

    fetchBalance: (address) => tronGrid.fetchBalance(address),

    normalizeAddress: (raw) => tronAddress.toBase58(raw),
    parseUserInput: (raw) => tronAddress.parseUserInput(raw),
    isValidUserInput: (raw) => tronAddress.isValidUserInput(raw),
  },
};

/**
 * Достать реализацию для сети.
 * @param {string} networkKey
 */
function familyOf(networkKey) {
  const network = getNetwork(networkKey);
  const family = FAMILIES[network.family];

  if (!family) {
    throw new Error(
      `Для сети "${networkKey}" (family: ${network.family}) нет провайдера. ` +
        `Реализованы: ${Object.keys(FAMILIES).join(', ')}`,
    );
  }

  return family;
}

/**
 * Убрать повторы по первичному ключу.
 *
 * НЕ перестраховка: Postgres при вставке пачкой с ON CONFLICT падает с
 * ошибкой «cannot affect row a second time», если в одной пачке встретились
 * две строки с одинаковым ключом. То есть дубль в массиве — это не лишняя
 * строка в базе, а сломанный запрос целиком.
 *
 * Источники между собой не пересекаются (USDT приходит только из /trc20,
 * нативный TRX только из /transactions, внутренние только из TronScan),
 * но полагаться на это нельзя: одна и та же транзакция может попасть в
 * выборку дважды на границе страниц при догрузке.
 *
 * Из совпадающих оставляем ПОСЛЕДНЮЮ: при догрузке более поздние записи
 * приходят из источника с более полными данными (события против /trc20).
 *
 * @param {object[]} transfers
 */
function dedupeTransfers(transfers) {
  const byKey = new Map();

  for (const transfer of transfers) {
    byKey.set(`${transfer.network}|${transfer.hash}|${transfer.transferIndex}`, transfer);
  }

  return [...byKey.values()];
}

/**
 * Все адреса, встреченные в переводах.
 *
 * Нужны, чтобы завести для них записи в таблице addresses с
 * lastFetchedAt = null — пометкой «адрес известен косвенно». Без этого
 * различия граф врал бы: клик по соседнему узлу показывал бы два ребра
 * вместо двадцати, потому что мы приняли бы неполные данные за полные.
 *
 * @param {object[]} transfers
 * @returns {string[]}
 */
export function collectAddresses(transfers) {
  const addresses = new Set();

  for (const transfer of transfers) {
    if (transfer.fromAddress) addresses.add(transfer.fromAddress);
    if (transfer.toAddress) addresses.add(transfer.toAddress);
  }

  return [...addresses];
}

/**
 * Забрать активность адреса из всех источников сети.
 *
 * @param {string} networkKey ключ сети из config/networks.js
 * @param {string} address адрес в канонической форме
 * @param {object} [syncState] состояние синхронизации из БД
 * @param {{ loadMore?: boolean }} [options]
 *   loadMore — догрузить более старые переводы вместо проверки новых
 * @returns {Promise<{
 *   transfers: object[],
 *   syncState: object,
 *   hasMore: boolean,
 *   partial: string[],
 * }>}
 */
export async function fetchAddressActivity(networkKey, address, syncState = {}, options = {}) {
  const family = familyOf(networkKey);
  const result = await family.fetchTransfers(address, syncState, options);

  return {
    ...result,
    transfers: dedupeTransfers(result.transfers),
  };
}

/**
 * Текущий баланс адреса. Отдельный запрос, а не сумма переводов —
 * см. пояснение в models/Address.js.
 *
 * @param {string} networkKey
 * @param {string} address
 */
export async function fetchBalance(networkKey, address) {
  return familyOf(networkKey).fetchBalance(address);
}

/**
 * Привести адрес к канонической форме сети.
 * Для данных из API — принимает все форматы, которые эта сеть использует.
 *
 * @param {string} networkKey
 * @param {string} raw
 */
export function normalizeAddress(networkKey, raw) {
  return familyOf(networkKey).normalizeAddress(raw);
}

/**
 * Разобрать адрес, введённый пользователем.
 *
 * Строже, чем normalizeAddress: отвергает форматы, которые внутри API
 * однозначны, а от человека почти наверняка означают ошибку — например
 * вставленный адрес Ethereum, неотличимый от 20-байтовой формы Tron.
 *
 * @param {string} networkKey
 * @param {string} raw
 * @returns {string} канонический адрес
 * @throws {Error} с сообщением, пригодным для показа пользователю
 */
export function parseUserAddress(networkKey, raw) {
  return familyOf(networkKey).parseUserInput(raw);
}

/**
 * @param {string} networkKey
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidUserAddress(networkKey, raw) {
  try {
    return familyOf(networkKey).isValidUserInput(raw);
  } catch {
    // Неизвестная сеть — адрес для неё валидным быть не может
    return false;
  }
}

export const __testing = { dedupeTransfers, familyOf, FAMILIES };
