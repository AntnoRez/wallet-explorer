/**
 * Справочник поддерживаемых сетей.
 *
 * Живёт в коде, а не в БД: это конфигурация, а не данные. В базу летит только
 * строковый ключ сети (поле `network`).
 *
 * Ключ — строка, а не числовой chainId, потому что chainId существует только
 * у EVM-сетей. У Tron его в этом смысле нет, и для не-EVM пришлось бы
 * выдумывать фиктивные номера.
 *
 * Поле `family` определяет, какой провайдер добывает данные. Именно оно, а не
 * ключ сети: Ethereum, Polygon и BSC обслуживаются одним провайдером
 * (family: 'evm'), различаясь только chainId.
 */

/**
 * @typedef {Object} Network
 * @property {string}      key            Ключ, он же значение колонки `network` в БД
 * @property {string}      name           Человекочитаемое название
 * @property {string}      family         Семейство: определяет провайдера ('tron' | 'evm' | ...)
 * @property {number|null} chainId        Только для EVM. Для остальных null
 * @property {string}      nativeSymbol   Символ нативной монеты
 * @property {number}      nativeDecimals Знаков после запятой у нативной монеты
 * @property {string}      addressFormat  Формат канонической записи адреса
 * @property {number}      reorgBufferSec Насколько отступать назад при догрузке
 * @property {Object}      explorer       Ссылки на публичный обозреватель
 * @property {Object}      api            Базовые URL внешних API
 */

/** @type {Record<string, Network>} */
export const NETWORKS = {
  tron: {
    key: 'tron',
    name: 'Tron',
    family: 'tron',
    chainId: null,

    // ВНИМАНИЕ: у TRX 6 знаков, не 18 как в Ethereum. Единица — SUN.
    nativeSymbol: 'TRX',
    nativeDecimals: 6,

    // base58check, регистрозависимый. НИКОГДА не применять toLowerCase().
    addressFormat: 'base58',

    // Блок необратим после ~19 подтверждений SR (~57 сек). Берём с запасом:
    // при инкрементальной догрузке отступаем на столько секунд назад и
    // перезапрашиваем отрезок. Upsert перезапишет изменившееся.
    reorgBufferSec: 60,

    explorer: {
      base: 'https://tronscan.org',
      tx: (hash) => `https://tronscan.org/#/transaction/${hash}`,
      address: (address) => `https://tronscan.org/#/address/${address}`,
    },

    api: {
      // Основной источник: TRX-переводы, TRC-20, события.
      // Курсорная пагинация (fingerprint), потолка глубины нет.
      tronGrid: 'https://api.trongrid.io',

      // Дополнительный источник ТОЛЬКО для внутренних переводов —
      // TronGrid их не отдаёт вовсе. Офсетная пагинация,
      // жёсткий потолок start + limit <= 10000.
      tronScan: 'https://apilist.tronscanapi.com',
    },
  },

  /*
   * EVM-СЕТИ.
   *
   * Все три обслуживаются ОДНИМ провайдером (providers/evmEtherscan.js):
   * у Etherscan V2 общий эндпоинт и общий ключ, сеть задаётся chainId.
   * Поэтому добавить четвёртую — это дописать блок ниже, и всё.
   *
   * ПОЧЕМУ ЗДЕСЬ НЕТ BSC, Base, Optimism и Avalanche. Они закрыты на
   * бесплатном тарифе Etherscan: "Free API access is not supported for
   * this chain". Проверено живыми запросами, подробности в README.
   */

  polygon: {
    key: 'polygon',
    name: 'Polygon',
    family: 'evm',
    chainId: 137,

    nativeSymbol: 'POL',
    nativeDecimals: 18,

    // hex, регистр не значим. Каноническая форма — СТРОЧНАЯ,
    // см. services/normalize/evmAddress.js
    addressFormat: 'hex-lowercase',

    // Блок раз в ~2 секунды. Отступ при инкрементальной догрузке считается
    // в блоках: reorgBufferSec / blockTimeSec
    blockTimeSec: 2,
    reorgBufferSec: 300,

    explorer: {
      base: 'https://polygonscan.com',
      tx: (hash) => `https://polygonscan.com/tx/${hash}`,
      address: (address) => `https://polygonscan.com/address/${address}`,
    },

    api: {
      // Домен один на все EVM-сети, различает их chainid в параметрах
      etherscan: 'https://api.etherscan.io/v2/api',
    },
  },

  ethereum: {
    key: 'ethereum',
    name: 'Ethereum',
    family: 'evm',
    chainId: 1,

    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    addressFormat: 'hex-lowercase',

    blockTimeSec: 12,
    reorgBufferSec: 180,

    explorer: {
      base: 'https://etherscan.io',
      tx: (hash) => `https://etherscan.io/tx/${hash}`,
      address: (address) => `https://etherscan.io/address/${address}`,
    },

    api: { etherscan: 'https://api.etherscan.io/v2/api' },
  },

  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    family: 'evm',
    chainId: 42161,

    // Нативная валюта L2 — тот же ETH
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    addressFormat: 'hex-lowercase',

    // Блоки идут гораздо чаще секунды, но округление вверх нам на руку:
    // лишний запас на реорганизацию дешевле пропущенной транзакции
    blockTimeSec: 1,
    reorgBufferSec: 60,

    explorer: {
      base: 'https://arbiscan.io',
      tx: (hash) => `https://arbiscan.io/tx/${hash}`,
      address: (address) => `https://arbiscan.io/address/${address}`,
    },

    api: { etherscan: 'https://api.etherscan.io/v2/api' },
  },

  // Как добавить сеть — на примере Ethereum:
  //
  // 'eth-mainnet': {
  //   key: 'eth-mainnet',
  //   name: 'Ethereum',
  //   family: 'evm',            // <- потребует providers/evmEtherscan.js
  //   chainId: 1,               // <- Etherscan V2: один эндпоинт на все EVM-сети
  //   nativeSymbol: 'ETH',
  //   nativeDecimals: 18,
  //   addressFormat: 'hex-lowercase',
  //   reorgBufferSec: 180,
  //   explorer: { base: 'https://etherscan.io', ... },
  //   api: { etherscan: 'https://api.etherscan.io/v2/api' },
  // },
  //
  // Схема БД менять не придётся: `network` — обычная строка.
};

/** Сеть по умолчанию, если в запросе не указана явно. */
export const DEFAULT_NETWORK = process.env.DEFAULT_NETWORK || 'tron';

/**
 * Достать описание сети по ключу.
 * Бросает ошибку, а не возвращает undefined: молча продолжить работу
 * с неизвестной сетью хуже, чем упасть на входе.
 *
 * @param {string} key
 * @returns {Network}
 */
export function getNetwork(key) {
  const network = NETWORKS[key];
  if (!network) {
    throw new Error(
      `Неизвестная сеть: "${key}". Доступные: ${listNetworkKeys().join(', ')}`,
    );
  }
  return network;
}

/** @returns {string[]} ключи всех поддерживаемых сетей */
export function listNetworkKeys() {
  return Object.keys(NETWORKS);
}

/** @param {string} key @returns {boolean} */
export function isSupportedNetwork(key) {
  return Object.hasOwn(NETWORKS, key);
}
