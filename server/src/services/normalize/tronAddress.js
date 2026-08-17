/**
 * Нормализация Tron-адресов.
 *
 * Один и тот же адрес приходит из API в ТРЁХ разных форматах:
 *
 *   TCC2TzYDec2MknUUXLL1LveDWocceC19Qb            base58check, 34 симв.  — /trc20, TronScan
 *   41185cdd47b644f6eb30405570bfa3dfdbefe307be    hex, 21 байт           — raw_data (префикс 41)
 *   0x185cdd47b644f6eb30405570bfa3dfdbefe307be    hex, 20 байт           — /events (EVM-стиль)
 *
 * Без приведения к одной форме в графе появятся три узла вместо одного.
 *
 * Каноническая форма — base58: её показывает Tronscan и видит пользователь.
 *
 * ВАЖНО: base58 РЕГИСТРОЗАВИСИМ. Заглавные и строчные — разные символы.
 * toLowerCase() превращает валидный адрес в мусор. Это не то же самое, что
 * Ethereum, где hex-адреса регистро-независимы.
 */

import bs58check from 'bs58check';

/** Префикс Tron-адреса в hex-виде: 0x41 = 65 */
const TRON_ADDRESS_PREFIX = 0x41;

/** Длина адреса в байтах: префикс + 20 байт хэша публичного ключа */
const TRON_ADDRESS_BYTES = 21;

/**
 * Алфавит base58 не содержит 0, O, I, l — они исключены как визуально
 * неотличимые. Regex это учитывает, поэтому отсекает часть опечаток
 * ещё до проверки контрольной суммы.
 */
const BASE58_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** hex с префиксом 41, 21 байт */
const HEX41_RE = /^41[0-9a-fA-F]{40}$/;

/** hex в EVM-стиле, 20 байт — так отдаёт /events */
const HEX0X_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Определить формат записи адреса.
 * Только по внешнему виду, без проверки контрольной суммы.
 *
 * @param {string} raw
 * @returns {'base58' | 'hex41' | 'hex0x' | 'unknown'}
 */
export function detectFormat(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.trim();
  if (BASE58_RE.test(s)) return 'base58';
  if (HEX41_RE.test(s)) return 'hex41';
  if (HEX0X_RE.test(s)) return 'hex0x';
  return 'unknown';
}

/**
 * Привести адрес к канонической форме (base58check).
 *
 * Принимает любой из трёх форматов. Бросает ошибку на мусоре и на адресах
 * с битой контрольной суммой — молча вернуть неверный адрес хуже, чем упасть.
 *
 * @param {string} raw
 * @returns {string} адрес в base58, например TCC2TzYDec2MknUUXLL1LveDWocceC19Qb
 * @throws {Error} если адрес невалиден
 */
export function toBase58(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const format = detectFormat(s);

  switch (format) {
    case 'base58':
      // Уже канонический, но контрольную сумму всё равно проверяем:
      // regex ловит только форму, а не опечатку в середине.
      assertValidChecksum(s);
      return s;

    case 'hex41':
      return bs58check.encode(Buffer.from(s, 'hex'));

    case 'hex0x':
      // 20 байт без префикса сети -> дописываем 0x41 спереди
      return bs58check.encode(
        Buffer.concat([Buffer.from([TRON_ADDRESS_PREFIX]), Buffer.from(s.slice(2), 'hex')]),
      );

    default:
      throw new Error(`Не похоже на Tron-адрес: "${truncate(raw)}"`);
  }
}

/**
 * Привести адрес к hex-форме с префиксом 41 (21 байт).
 * Нужна там, где этого требует протокол — например при сборке параметров
 * вызова контракта.
 *
 * @param {string} raw
 * @returns {string} например 41185cdd47b644f6eb30405570bfa3dfdbefe307be
 * @throws {Error} если адрес невалиден
 */
export function toHex41(raw) {
  const base58 = toBase58(raw);
  return Buffer.from(bs58check.decode(base58)).toString('hex');
}

/**
 * Проверка адреса в ЛЮБОМ из трёх форматов, без выброса ошибки.
 * Для внутреннего использования — при разборе ответов API.
 *
 * НЕ ГОДИТСЯ для пользовательского ввода: формат 0x... неотличим от адреса
 * Ethereum. См. isValidUserInput().
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isValid(raw) {
  try {
    toBase58(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Проверка ПОЛЬЗОВАТЕЛЬСКОГО ввода: принимает только каноническую base58-форму.
 *
 * Почему отдельная функция. Формат 0x... (20 байт) физически неотличим от
 * адреса Ethereum — это одинаковые последовательности байт. Внутри разбора
 * ответов API двусмысленности нет: в /events могут прийти только Tron-адреса.
 * А вот человек, вставивший в поле ввода адрес Ethereum, иначе получил бы
 * граф ЧУЖОГО, существующего Tron-кошелька — и не понял бы, почему данные
 * не те. Молча подставить не тот адрес хуже, чем отказать.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidUserInput(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (detectFormat(s) !== 'base58') return false;
  try {
    assertValidChecksum(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Разобрать пользовательский ввод с внятным сообщением об ошибке.
 * Отдельно распознаёт частый случай — вставленный адрес Ethereum.
 *
 * @param {string} raw
 * @returns {string} канонический base58
 * @throws {Error} с сообщением, пригодным для показа пользователю
 */
export function parseUserInput(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';

  if (!s) throw new Error('Адрес не указан');

  const format = detectFormat(s);

  if (format === 'hex0x' || format === 'hex41') {
    throw new Error(
      'Похоже на адрес другой сети или на внутренний формат. ' +
        'Введите адрес Tron в обычном виде — он начинается с T, например ' +
        'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    );
  }

  if (format !== 'base58') {
    throw new Error(
      'Неверный формат адреса Tron. Адрес начинается с T и состоит из 34 символов',
    );
  }

  assertValidChecksum(s);
  return s;
}

/**
 * Проверить контрольную сумму base58check и то, что это адрес Tron,
 * а не какая-то другая сущность в том же кодировании.
 *
 * @param {string} base58
 * @throws {Error}
 */
function assertValidChecksum(base58) {
  let bytes;
  try {
    bytes = bs58check.decode(base58);
  } catch {
    // bs58check сам проверяет контрольную сумму и бросает при несовпадении
    throw new Error(`Неверная контрольная сумма адреса: "${truncate(base58)}"`);
  }

  if (bytes.length !== TRON_ADDRESS_BYTES) {
    throw new Error(
      `Неверная длина адреса: ${bytes.length} байт вместо ${TRON_ADDRESS_BYTES}`,
    );
  }

  if (bytes[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error(
      `Неверный префикс адреса: 0x${bytes[0].toString(16)} вместо 0x41`,
    );
  }
}

/** Обрезка длинного значения для сообщений об ошибках */
function truncate(value, max = 50) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
