/**
 * Форматирование значений для показа.
 *
 * Суммы приходят с сервера СТРОКАМИ в минимальных единицах — так они
 * переживают путь через JSON без потери точности. Превращать их в число
 * нельзя: 26-значное значение потеряет младшие разряды молча.
 * Поэтому делим строкой, а не арифметикой.
 */

/**
 * Сумма в человеческом виде: "1 500", "35.56".
 *
 * @param {string|number|null|undefined} value минимальные единицы
 * @param {number|null|undefined} decimals
 * @param {{ maxFraction?: number }} [options]
 */
export function formatAmount(value, decimals, { maxFraction = 2 } = {}) {
  if (value === null || value === undefined) return '—';

  const raw = String(value);

  // decimals неизвестны — показываем сырое значение и говорим об этом
  // отдельно. Подставить 6 или 18 наугад значит исказить сумму в миллион раз.
  if (decimals === null || decimals === undefined) return raw;

  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(decimals + 1, '0');

  const whole = padded.slice(0, padded.length - decimals) || '0';
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : '';

  // Разделитель разрядов — U+202F, узкий неразрывный пробел. Обычный
  // (U+0020) переносится на новую строку и разрывает число пополам,
  // а обычный неразрывный (U+00A0) слишком широк для группировки цифр.
  //
  // Символ невидим в коде: при сравнении вывода в тестах берите
  // именно  , иначе получите ложное расхождение.
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const shortFraction = fraction.slice(0, maxFraction).replace(/0+$/, '');

  return `${negative ? '−' : ''}${grouped}${shortFraction ? `.${shortFraction}` : ''}`;
}

/**
 * Сокращение адреса: TWS1on…Hh7PV
 * Хвост информативнее начала — у Tron-адресов оно у всех похоже.
 */
export function shortenAddress(address) {
  if (!address) return '';
  if (address.startsWith('__')) return 'группа адресов';
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}

/**
 * Дата и время в местном поясе.
 *
 * С сервера всё приходит в UTC — так оно и хранится в базе. Показываем
 * в поясе пользователя: расследование ведётся в его времени, а не в UTC.
 */
export function formatDateTime(value) {
  if (!value) return '—';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Сколько времени прошло: «5 минут назад», «3 дня назад».
 * Для колонки «когда» в таблице — там точная дата менее важна, чем давность.
 */
export function formatAge(value) {
  if (!value) return '—';

  const date = value instanceof Date ? value : new Date(value);
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));

  if (seconds < 60) return 'только что';

  const units = [
    { limit: 3600, size: 60, forms: ['минуту', 'минуты', 'минут'] },
    { limit: 86400, size: 3600, forms: ['час', 'часа', 'часов'] },
    { limit: 2592000, size: 86400, forms: ['день', 'дня', 'дней'] },
    { limit: Infinity, size: 2592000, forms: ['месяц', 'месяца', 'месяцев'] },
  ];

  for (const unit of units) {
    if (seconds < unit.limit) {
      const count = Math.floor(seconds / unit.size);
      return `${count} ${plural(count, unit.forms)} назад`;
    }
  }

  return '—';
}

/**
 * Согласование числительного с существительным.
 * @param {number} count
 * @param {[string, string, string]} forms [1, 2-4, 5-20]
 */
export function plural(count, forms) {
  const lastTwo = count % 100;
  const last = count % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}
