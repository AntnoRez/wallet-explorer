/**
 * Нормализация адресов TON.
 *
 * Один и тот же адрес существует в ТРЁХ формах — ровно та же беда, что
 * в Tron, только устроена иначе:
 *
 *   0:4317566082f7afe0ce2dc97b26c08799a903e4c3808b0a7758f6508a334b4fb0  raw
 *   EQBDF1Zggvev4M4tyXsmwIeZqQPkw4CLCndY9lCKM0tPsOLS                    bounceable
 *   UQBDF1Zggvev4M4tyXsmwIeZqQPkw4CLCndY9lCKM0tPsL8X                    non-bounceable
 *
 * ЭТО ОДИН АДРЕС. EQ и UQ различаются единственным байтом-флагом, который
 * говорит, вернутся ли деньги отправителю, если контракт не смог принять
 * платёж. К тому, ЧЕЙ это кошелёк, флаг отношения не имеет. Кошельки
 * показывают UQ, обозреватели и API — чаще EQ или raw.
 *
 * Без приведения к одной форме в графе появятся три узла вместо одного.
 *
 * КАНОНИЧЕСКАЯ ФОРМА — RAW. Причины две. Во-первых, она однозначна: из
 * трёх форм только она не несёт лишнего флага. Во-вторых, именно её
 * отдаёт API, а значит на разборе ответов конверсия не нужна вовсе.
 *
 * Для показа человеку есть toUserFriendly(): в кошельках принято UQ.
 */

/** raw: рабочая цепь, двоеточие, 32 байта в hex */
const RAW_RE = /^(-?\d+):([0-9a-fA-F]{64})$/;

/** user-friendly: 36 байт в base64url, всегда 48 символов */
const FRIENDLY_RE = /^[A-Za-z0-9_+/=-]{48}$/;

/** Длина декодированного user-friendly адреса: флаг + цепь + хэш + CRC */
const FRIENDLY_BYTES = 36;

/** Флаг «non-bounceable»: деньги вернутся, если контракт не принял платёж */
const FLAG_NON_BOUNCEABLE = 0x51;

/** Флаг «bounceable» */
const FLAG_BOUNCEABLE = 0x11;

/** Добавляется к флагу у тестовой сети */
const FLAG_TESTNET = 0x80;

/**
 * CRC16-CCITT (XMODEM) — им подписаны user-friendly адреса.
 *
 * Пишем руками, а не тянем зависимость: восемь строк против пакета,
 * который придётся обновлять.
 *
 * @param {Buffer} data
 * @returns {number}
 */
function crc16(data) {
  let crc = 0;

  for (const byte of data) {
    crc ^= byte << 8;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc;
}

/**
 * Определить формат записи адреса — только по внешнему виду.
 *
 * @param {string} raw
 * @returns {'raw' | 'friendly' | 'unknown'}
 */
export function detectFormat(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const value = raw.trim();

  if (RAW_RE.test(value)) return 'raw';
  if (FRIENDLY_RE.test(value)) return 'friendly';

  return 'unknown';
}

/**
 * Разобрать user-friendly адрес в рабочую цепь и хэш.
 *
 * @param {string} value 48 символов base64url
 * @returns {{ workchain: number, hash: Buffer }}
 * @throws {Error} если длина, контрольная сумма или флаг не те
 */
function parseFriendly(value) {
  // base64url отличается от base64 двумя символами; Buffer понимает оба,
  // но заменить надёжнее, чем полагаться на его снисходительность
  const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  if (bytes.length !== FRIENDLY_BYTES) {
    throw new Error(
      `Неверная длина адреса: ${bytes.length} байт вместо ${FRIENDLY_BYTES}`,
    );
  }

  const payload = bytes.subarray(0, 34);
  const checksum = bytes.readUInt16BE(34);

  if (crc16(payload) !== checksum) {
    throw new Error(`Неверная контрольная сумма адреса: "${truncate(value)}"`);
  }

  // Флаг тестовой сети снимаем: адреса тестнета мы не обслуживаем,
  // но и падать на них с непонятной ошибкой ни к чему
  const flag = payload[0] & ~FLAG_TESTNET;

  if (flag !== FLAG_BOUNCEABLE && flag !== FLAG_NON_BOUNCEABLE) {
    throw new Error(`Неизвестный тип адреса: 0x${payload[0].toString(16)}`);
  }

  // Рабочая цепь: 0 — основная, 0xff означает -1 (мастерчейн)
  const workchain = payload[1] === 0xff ? -1 : payload[1];

  return { workchain, hash: payload.subarray(2, 34) };
}

/**
 * Привести адрес к канонической форме: `рабочая_цепь:хэш` строчными.
 *
 * Принимает обе формы. Бросает ошибку на мусоре и на адресе с битой
 * контрольной суммой — молча вернуть неверный адрес хуже, чем упасть.
 *
 * @param {string} raw
 * @returns {string} например 0:4317566082f7afe0...
 * @throws {Error}
 */
export function toCanonical(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const format = detectFormat(value);

  if (format === 'raw') {
    const [, workchain, hash] = value.match(RAW_RE);
    return `${Number(workchain)}:${hash.toLowerCase()}`;
  }

  if (format === 'friendly') {
    const { workchain, hash } = parseFriendly(value);
    return `${workchain}:${hash.toString('hex')}`;
  }

  throw new Error(`Не похоже на адрес TON: "${truncate(raw)}"`);
}

/**
 * Привести адрес к виду, принятому в кошельках (UQ…).
 *
 * @param {string} raw
 * @param {{ bounceable?: boolean }} [options]
 *   bounceable — форма EQ…, для контрактов; по умолчанию UQ…, для кошельков
 * @returns {string} 48 символов base64url
 * @throws {Error}
 */
export function toUserFriendly(raw, { bounceable = false } = {}) {
  const canonical = toCanonical(raw);
  const [workchain, hash] = canonical.split(':');

  const payload = Buffer.alloc(34);
  payload[0] = bounceable ? FLAG_BOUNCEABLE : FLAG_NON_BOUNCEABLE;
  // -1 (мастерчейн) записывается как 0xff
  payload[1] = Number(workchain) === -1 ? 0xff : Number(workchain);
  Buffer.from(hash, 'hex').copy(payload, 2);

  const full = Buffer.alloc(FRIENDLY_BYTES);
  payload.copy(full, 0);
  full.writeUInt16BE(crc16(payload), 34);

  return full.toString('base64url');
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
 * Совпадает с isValid: в отличие от Tron, здесь нет формы, которая внутри
 * API однозначна, а от человека означала бы ошибку. Обе формы TON —
 * законный ввод: raw копируют из обозревателя, UQ — из кошелька.
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
 * @param {string} raw
 * @returns {string} канонический адрес
 * @throws {Error} с сообщением, пригодным для показа пользователю
 */
export function parseUserInput(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value) throw new Error('Адрес не указан');

  if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      'Это адрес EVM-сети — он начинается с 0x. Выберите Ethereum, Polygon ' +
        'или Arbitrum, либо введите адрес TON',
    );
  }

  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
    throw new Error('Это адрес Tron — он начинается с T. Выберите сеть Tron');
  }

  if (detectFormat(value) === 'unknown') {
    throw new Error(
      'Неверный формат адреса TON. Ожидается либо вид из кошелька ' +
        '(48 символов, начинается с UQ или EQ), либо необработанный ' +
        'вид с двоеточием (0:abc…)',
    );
  }

  // Здесь ошибку бросит уже разбор: битая контрольная сумма, чужая длина
  return toCanonical(value);
}

/** Обрезка длинного значения для сообщений об ошибках */
function truncate(value, max = 50) {
  const s = String(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
