/**
 * Нормализация адресов Solana.
 *
 * Адрес — это 32 байта в base58. Ни префикса, ни версии, ни контрольной
 * суммы: просто открытый ключ ed25519 (или производный от программы).
 *
 *   GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ   обычный кошелёк
 *   11111111111111111111111111111111               System Program
 *
 * ФОРМА ОДНА, ПРИВОДИТЬ НЕ К ЧЕМУ. В отличие от Tron с его тремя
 * представлениями и EVM с регистром, здесь канонизация сводится к обрезке
 * пробелов. Поэтому файл маленький — и это правильно, а не недоделка.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ — ЗАЩИТЫ ОТ ОПЕЧАТКИ.
 * У Tron контрольная сумма base58check ловит испорченный адрес. У EVM
 * помогает EIP-55, если адрес записан смешанным регистром. Здесь нет
 * ничего: любые 32 байта — валидный адрес. Испорченный адрес не будет
 * отвергнут, он просто окажется чужим и пустым.
 *
 * РЕГИСТР ЗНАЧИМ, как и в Tron: base58 использует заглавные и строчные как
 * разные символы. toLowerCase() уничтожает адрес.
 *
 * ДЛИНА ПЛАВАЕТ. 32 байта дают 43–44 символа, но ведущие нулевые байты
 * кодируются единицами и укорачивают запись: у System Program адрес из
 * 32 нулей записан 32 символами. Поэтому проверяем длину В БАЙТАХ после
 * декодирования, а не длину строки.
 */

import bs58 from 'bs58';

/** У пакета bs58 есть и ESM-, и CJS-сборка — берём то, что пришло */
const base58 = bs58.default ?? bs58;

/** Длина адреса Solana в байтах */
const ADDRESS_BYTES = 32;

/**
 * Алфавит base58 без 0, O, I, l. Regex отсекает явный мусор до
 * декодирования — оно дороже.
 *
 * Нижняя граница длины взята с запасом: у адреса из одних нулевых байтов
 * запись короткая, но не короче 32 символов.
 */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Длина адреса Tron в байтах после декодирования base58.
 * Нужна, чтобы отличить его от адреса Solana и сказать об этом человеку.
 */
const TRON_BYTES = 25;

/** Адрес EVM: 20 байт в hex с префиксом */
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Декодировать адрес в байты.
 *
 * @param {string} value
 * @returns {Buffer|null} null — не base58 или мусор
 */
function decode(value) {
  if (!BASE58_RE.test(value)) return null;

  try {
    return Buffer.from(base58.decode(value));
  } catch {
    return null;
  }
}

/**
 * Привести адрес к канонической форме.
 *
 * Канонизировать нечего — форма одна. Функция существует ради единого
 * контракта провайдеров: chainData вызывает normalizeAddress для любой
 * сети, не зная, много ли там форм записи.
 *
 * @param {string} raw
 * @returns {string} тот же адрес без окружающих пробелов
 * @throws {Error} если это не адрес Solana
 */
export function toCanonical(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const bytes = decode(value);

  if (!bytes || bytes.length !== ADDRESS_BYTES) {
    throw new Error(`Не похоже на адрес Solana: "${truncate(raw)}"`);
  }

  return value;
}

/**
 * Проверка без выброса ошибки — для разбора ответов API.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isValid(raw) {
  try {
    toCanonical(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Проверка пользовательского ввода.
 *
 * Совпадает с isValid: в отличие от Tron и EVM, здесь нет форматов,
 * допустимых внутри API, но опасных от человека. Отдельная функция нужна
 * для единого контракта семейств в chainData.js.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidUserInput(raw) {
  return isValid(raw);
}

/**
 * Разобрать пользовательский ввод с внятным сообщением об ошибке.
 *
 * Отдельно узнаём адреса других сетей: человек, вставивший адрес Tron,
 * ошибся сетью, а не форматом, и сказать об этом полезнее, чем «неверный
 * адрес».
 *
 * @param {string} raw
 * @returns {string} канонический адрес
 * @throws {Error} с сообщением, пригодным для показа пользователю
 */
export function parseUserInput(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value) throw new Error('Адрес не указан');

  if (EVM_RE.test(value)) {
    throw new Error(
      'Это адрес EVM-сети — он начинается с 0x. Выберите Ethereum, Polygon ' +
        'или Arbitrum, либо введите адрес Solana',
    );
  }

  const bytes = decode(value);

  if (bytes && bytes.length === TRON_BYTES) {
    throw new Error(
      'Это адрес Tron — он начинается с T. Выберите сеть Tron, ' +
        'либо введите адрес Solana',
    );
  }

  if (!bytes) {
    throw new Error(
      'Неверный формат адреса. Адрес Solana записан в base58 — ' +
        'латинские буквы и цифры без нуля, O, I и l',
    );
  }

  if (bytes.length !== ADDRESS_BYTES) {
    throw new Error(
      `Неверная длина адреса: ${bytes.length} байт вместо ${ADDRESS_BYTES}`,
    );
  }

  return value;
}

/** Обрезка длинного значения для сообщений об ошибках */
function truncate(value, max = 50) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
