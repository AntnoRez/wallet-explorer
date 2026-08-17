/**
 * Нормализация адресов EVM-сетей.
 *
 * Здесь всё проще, чем у Tron: формат ровно один — 20 байт в hex с префиксом
 * 0x. Ни base58, ни второго представления, ни префикса сети.
 *
 * Но появляется своя сложность, которой у Tron не было: РЕГИСТР.
 *
 *   0x28c6c06298d514db089934071355e5743bf21d60   всё строчными
 *   0x28C6C06298D514DB089934071355E5743BF21D60   всё заглавными
 *   0x28C6c06298d514Db089934071355E5743bf21d60   смешанный — EIP-55
 *
 * Это ОДИН И ТОТ ЖЕ адрес. Первые две записи — просто hex, третья несёт
 * контрольную сумму: регистр каждой буквы выбран не произвольно, а по
 * keccak256 от строчной формы. Подробнее — в assertChecksum().
 *
 * ВАЖНОЕ ОТЛИЧИЕ ОТ TRON. Там base58check означал, что опечатка почти
 * наверняка не пройдёт проверку. Здесь любые 40 hex-символов — формально
 * валидный адрес. Опечатку ловит только EIP-55, и только если адрес
 * скопирован в смешанном регистре. Из обозревателей копируют именно так,
 * поэтому проверка окупается.
 *
 * ОДИН АДРЕС ЖИВЁТ ВО ВСЕХ EVM-СЕТЯХ СРАЗУ. Адрес выводится из приватного
 * ключа одинаково в Ethereum, BSC, Polygon и остальных, поэтому по самому
 * адресу сеть определить НЕВОЗМОЖНО — только семейство. Этим модуль и
 * ограничивается: он ничего не знает про chainId.
 */

import { keccak256 } from 'js-sha3';

/**
 * Каноническая форма адреса, 20 байт в hex.
 *
 * Заглавные буквы допускаются: это тот же адрес, просто записанный иначе.
 * Смешанный регистр дополнительно проверяется по EIP-55.
 */
const HEX_RE = /^0x[0-9a-fA-F]{40}$/;

/** Тот же формат, но без обязательного префикса — так отдают некоторые API */
const HEX_NO_PREFIX_RE = /^[0-9a-fA-F]{40}$/;

/**
 * Формат Tron в base58. Нужен ровно для одного: узнать чужой адрес во
 * вводе и сказать об этом человеку, а не «неверный формат».
 */
const TRON_BASE58_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * Определить формат записи адреса — только по внешнему виду,
 * без проверки контрольной суммы.
 *
 * @param {string} raw
 * @returns {'hex' | 'hex-bare' | 'unknown'}
 */
export function detectFormat(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.trim();
  if (HEX_RE.test(s)) return 'hex';
  if (HEX_NO_PREFIX_RE.test(s)) return 'hex-bare';
  return 'unknown';
}

/**
 * Привести адрес к канонической форме: строчный hex с префиксом 0x.
 *
 * ПОЧЕМУ СТРОЧНЫЙ, А НЕ EIP-55. Каноническая форма — это то, по чему мы
 * сравниваем и что кладём в первичный ключ. Если хранить смешанный регистр,
 * один адрес, пришедший от разных источников в разной записи, даст в графе
 * два узла. Etherscan в ответах отдаёт строчный вид, обозреватель показывает
 * EIP-55, а логи событий — как придётся. Строчный вид приводит их к одному.
 *
 * Для показа человеку есть toChecksum(). Ссылки в обозреватель работают
 * с любым регистром, так что для них конверсия не нужна.
 *
 * @param {string} raw
 * @returns {string} например 0x28c6c06298d514db089934071355e5743bf21d60
 * @throws {Error} если это не адрес или контрольная сумма не сходится
 */
export function toCanonical(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const format = detectFormat(s);

  if (format === 'unknown') {
    throw new Error(`Не похоже на адрес EVM-сети: "${truncate(raw)}"`);
  }

  const withPrefix = format === 'hex-bare' ? `0x${s}` : s;

  assertChecksum(withPrefix);

  return withPrefix.toLowerCase();
}

/**
 * Привести адрес к виду EIP-55 — со смешанным регистром.
 *
 * Алгоритм: берём keccak256 от адреса без 0x в НИЖНЕМ регистре. Для каждой
 * буквы адреса смотрим соответствующий ей символ хэша: если его значение
 * 8 или больше — букву делаем заглавной. Цифры остаются как есть.
 *
 * Смысл в том, что случайная опечатка почти наверняка сломает соответствие
 * между буквами и хэшем, и такой адрес можно отвергнуть до всякого запроса
 * в сеть. Проверка не криптографическая, но опечатки ловит.
 *
 * @param {string} raw
 * @returns {string} например 0x28C6c06298d514Db089934071355E5743bf21d60
 * @throws {Error} если это не адрес
 */
export function toChecksum(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const format = detectFormat(s);

  if (format === 'unknown') {
    throw new Error(`Не похоже на адрес EVM-сети: "${truncate(raw)}"`);
  }

  const body = (format === 'hex-bare' ? s : s.slice(2)).toLowerCase();
  const hash = keccak256(body);

  let result = '0x';

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    // Цифры регистра не имеют — трогать их нечем
    result += parseInt(hash[i], 16) >= 8 ? char.toUpperCase() : char;
  }

  return result;
}

/**
 * Проверка адреса в любом принимаемом виде, без выброса ошибки.
 * Для разбора ответов API.
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
 * Проверка ПОЛЬЗОВАТЕЛЬСКОГО ввода.
 *
 * Строже, чем isValid: требует префикс 0x. Внутри ответов API голый hex
 * однозначен, а от человека 40 символов без префикса — почти наверняка
 * обрезанная при копировании строка.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidUserInput(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (detectFormat(s) !== 'hex') return false;
  try {
    assertChecksum(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * Разобрать пользовательский ввод с внятным сообщением об ошибке.
 *
 * @param {string} raw
 * @returns {string} канонический строчный адрес
 * @throws {Error} с сообщением, пригодным для показа пользователю
 */
export function parseUserInput(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';

  if (!s) throw new Error('Адрес не указан');

  // Адрес Tron во вводе — не ошибка пользователя, а выбор не той сети.
  // Сказать об этом прямо полезнее, чем «неверный формат»
  if (TRON_BASE58_RE.test(s)) {
    throw new Error(
      'Это адрес Tron — он начинается с T. Выберите сеть Tron, ' +
        'либо введите адрес EVM-сети: он начинается с 0x',
    );
  }

  if (HEX_NO_PREFIX_RE.test(s)) {
    throw new Error(
      'Адрес без префикса 0x. Возможно, строка скопирована не полностью',
    );
  }

  if (detectFormat(s) !== 'hex') {
    throw new Error(
      'Неверный формат адреса. Адрес EVM-сети начинается с 0x ' +
        'и состоит из 40 шестнадцатеричных символов',
    );
  }

  assertChecksum(s);

  return s.toLowerCase();
}

/**
 * Проверить контрольную сумму EIP-55.
 *
 * Проверяем ТОЛЬКО адреса со смешанным регистром. Запись целиком строчными
 * или целиком заглавными контрольной суммы не несёт — так адрес отдаёт
 * половина API, и отвергать его было бы неверно.
 *
 * @param {string} address адрес с префиксом 0x
 * @throws {Error} если регистр не соответствует хэшу
 */
function assertChecksum(address) {
  const body = address.slice(2);

  const hasUpper = /[A-F]/.test(body);
  const hasLower = /[a-f]/.test(body);

  // Регистр однороден — проверять нечего
  if (!hasUpper || !hasLower) return;

  if (toChecksum(address) !== address) {
    throw new Error(
      `Неверная контрольная сумма адреса: "${truncate(address)}". ` +
        'Проверьте, что адрес скопирован целиком и без опечаток',
    );
  }
}

/** Обрезка длинного значения для сообщений об ошибках */
function truncate(value, max = 50) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
