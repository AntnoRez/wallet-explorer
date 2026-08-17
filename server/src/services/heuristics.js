/**
 * Эвристика дробления средств.
 *
 * Дробление (structuring) — приём, когда крупную сумму разбивают на много
 * мелких переводов, чтобы не привлекать внимания и затруднить отслеживание.
 * На графе это выглядит как звезда: один адрес, из которого веером расходятся
 * почти одинаковые суммы за короткий срок.
 *
 * ЧЕСТНО О ГРАНИЦАХ МЕТОДА.
 * Это пороговое правило, а не доказательство. Оно ловит характерный ПАТТЕРН,
 * а не намерение: точно так же выглядят выплаты зарплат, раздачи наград и
 * работа платёжных шлюзов. Поэтому результат — повод посмотреть внимательнее,
 * а не обвинение, и в интерфейсе он подписан причиной, которую можно
 * проверить самому.
 */

/** Окно, внутри которого переводы считаются одной серией */
const WINDOW_MS = 60 * 60 * 1000;

/** Сколько переводов в окне делают серию подозрительной */
const MIN_TRANSFERS = 3;

/**
 * Допустимый разброс сумм, доля от среднего.
 *
 * 0.15 означает: каждая сумма отличается от средней не больше чем на 15%.
 * Строже — упустим дробление с округлением «на глаз», мягче — начнём ловить
 * обычную торговую активность.
 */
const MAX_DEVIATION = 0.15;

/**
 * Сколько разных получателей должно быть в серии.
 *
 * Три перевода одному адресу — это просто три перевода. Дробление
 * подразумевает расхождение по РАЗНЫМ адресам, иначе смысл приёма теряется.
 */
const MIN_RECIPIENTS = 3;

/**
 * Минимальная средняя сумма серии, в сотых долях единицы токена.
 *
 * Пылевые переводы формально подходят под все признаки: равные суммы,
 * много получателей, короткий срок. Но рассылка долей копейки — это
 * реклама или спам, а не движение средств. На живых данных такое
 * срабатывание нашлось: «12 переводов почти равными суммами (~0 TRX)».
 *
 * Порог в 0.01 единицы токена: ниже начинается пыль.
 */
const MIN_AVERAGE_UNITS = 1n;

/**
 * Найти признаки дробления среди переводов адреса.
 *
 * @param {object[]} transfers переводы из базы (в любом порядке)
 * @param {string} address адрес, который проверяем
 * @returns {{ suspicious: boolean, reason: string|null, series: object[] }}
 */
export function detectStructuring(transfers, address) {
  // Дробление — это про ИСХОДЯЩИЕ переводы: деньги уводят, разбивая на части
  const outgoing = transfers.filter(
    (transfer) => transfer.fromAddress === address && transfer.toAddress,
  );

  if (outgoing.length < MIN_TRANSFERS) {
    return { suspicious: false, reason: null, series: [] };
  }

  // Токены не смешиваем: 100 USDT и 100 TRX — разные величины, и «равные
  // суммы» между ними ничего не значат
  const byToken = new Map();
  for (const transfer of outgoing) {
    const key = transfer.tokenContractAddress ?? transfer.tokenSymbol ?? 'native';
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key).push(transfer);
  }

  const series = [];

  for (const group of byToken.values()) {
    series.push(...findSeries(group));
  }

  if (series.length === 0) {
    return { suspicious: false, reason: null, series: [] };
  }

  // Самая крупная серия — по ней и формулируем причину
  series.sort((a, b) => b.count - a.count);
  const top = series[0];

  return {
    suspicious: true,
    reason: describe(top),
    series,
  };
}

/**
 * Найти серии равных переводов внутри одного токена.
 *
 * Скользящее окно: для каждого перевода смотрим, что происходило в течение
 * следующего часа. Окно фиксированной сетки (например, «каждый час с нуля»)
 * пропустило бы серию, разорванную границей часа.
 *
 * @param {object[]} transfers переводы одного токена
 */
function findSeries(transfers) {
  const sorted = [...transfers].sort(
    (a, b) => new Date(a.blockTimestamp) - new Date(b.blockTimestamp),
  );

  const found = [];
  const used = new Set();

  for (let start = 0; start < sorted.length; start += 1) {
    if (used.has(start)) continue;

    const windowStart = new Date(sorted[start].blockTimestamp).getTime();
    const window = [];

    for (let i = start; i < sorted.length; i += 1) {
      if (used.has(i)) continue;
      const time = new Date(sorted[i].blockTimestamp).getTime();
      if (time - windowStart > WINDOW_MS) break;
      window.push({ index: i, transfer: sorted[i] });
    }

    if (window.length < MIN_TRANSFERS) continue;

    // Ищем однородную группу ВНУТРИ окна, а не проверяем окно целиком.
    //
    // Проверка окна целиком — ошибка, которая делала эвристику
    // бесполезной: рядом с серией почти всегда есть переводы других сумм,
    // и один такой сосед ронял всю находку. На живых данных это давало
    // ноль срабатываний при пятнадцати адресах с явными сериями.
    const group = findUniformGroup(window);
    if (!group) continue;

    const uniform = checkUniform(group.map((item) => item.transfer));
    if (!uniform) continue;

    found.push(uniform);
    // Переводы, вошедшие в серию, не начинают новую: иначе одна и та же
    // рассылка порождала бы десяток пересекающихся находок
    for (const item of group) used.add(item.index);
  }

  return found;
}

/**
 * Найти в окне самую большую группу переводов с близкими суммами.
 *
 * Каждый перевод по очереди берём за образец и собираем все, чья сумма
 * укладывается в допустимый разброс от него. Побеждает самая многочисленная
 * группа — она и есть предполагаемая серия.
 *
 * Перебор квадратичный, но окна маленькие: это переводы одного адреса
 * за один час.
 *
 * @param {{index: number, transfer: object}[]} window
 * @returns {{index: number, transfer: object}[]|null}
 */
function findUniformGroup(window) {
  let best = null;

  for (const anchor of window) {
    const base = BigInt(anchor.transfer.value ?? '0');
    if (base === 0n) continue;

    const limit = BigInt(Math.round(MAX_DEVIATION * 100));

    const group = window.filter((item) => {
      const amount = BigInt(item.transfer.value ?? '0');
      const diff = amount > base ? amount - base : base - amount;
      return (diff * 100n) / base <= limit;
    });

    if (group.length < MIN_TRANSFERS) continue;

    const recipients = new Set(group.map((item) => item.transfer.toAddress));
    if (recipients.size < MIN_RECIPIENTS) continue;

    if (!best || group.length > best.length) best = group;
  }

  return best;
}

/**
 * Проверить, что переводы образуют серию: равные суммы, разные получатели.
 *
 * @param {object[]} transfers
 * @returns {object|null} описание серии либо null
 */
function checkUniform(transfers) {
  const recipients = new Set(transfers.map((transfer) => transfer.toAddress));
  if (recipients.size < MIN_RECIPIENTS) return null;

  // Суммы — целые в минимальных единицах, легко выходят за пределы Number
  const amounts = transfers.map((transfer) => BigInt(transfer.value ?? '0'));
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);

  if (total === 0n) return null;

  const average = total / BigInt(amounts.length);
  if (average === 0n) return null;

  // Отсекаем пыль: средняя сумма должна быть заметной в единицах токена.
  // Точность неизвестна — пропускаем проверку, иначе отбросили бы всё
  const decimals = transfers[0].decimals;
  if (decimals !== null && decimals !== undefined) {
    const hundredth = 10n ** BigInt(Math.max(0, decimals - 2));
    if (average < hundredth * MIN_AVERAGE_UNITS) return null;
  }

  // Отклонение считаем в процентах, целочисленно: (|a - avg| * 100) / avg
  const limit = BigInt(Math.round(MAX_DEVIATION * 100));

  for (const amount of amounts) {
    const diff = amount > average ? amount - average : average - amount;
    if ((diff * 100n) / average > limit) return null;
  }

  const times = transfers.map((transfer) => new Date(transfer.blockTimestamp).getTime());

  return {
    count: transfers.length,
    recipients: recipients.size,
    tokenSymbol: transfers[0].tokenSymbol ?? null,
    decimals: transfers[0].decimals ?? null,
    total: total.toString(),
    average: average.toString(),
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
    hashes: transfers.slice(0, 10).map((transfer) => transfer.hash),
  };
}

/**
 * Человеческое описание находки — оно попадёт в подсказку на узле.
 *
 * Формулируем как наблюдение, а не приговор: пользователь должен понять,
 * что именно сработало, и суметь это перепроверить.
 *
 * @param {object} series
 */
function describe(series) {
  const amount = formatUnits(series.average, series.decimals);
  const symbol = series.tokenSymbol ?? '';
  const minutes = Math.max(1, Math.round((series.to - series.from) / 60000));

  return (
    `${series.count} ${plural(series.count, ['перевод', 'перевода', 'переводов'])} ` +
    `почти равными суммами (~${amount} ${symbol}) ` +
    `на ${series.recipients} ${plural(series.recipients, ['адрес', 'адреса', 'адресов'])} ` +
    `за ${minutes} мин.`
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Согласование числительного: 1 перевод, 2 перевода, 5 переводов */
function plural(count, forms) {
  const lastTwo = count % 100;
  const last = count % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

/**
 * Минимальные единицы в человеческий вид. Делим строкой: значение может не
 * поместиться в Number.
 */
function formatUnits(value, decimals) {
  if (decimals === null || decimals === undefined) return value;

  const padded = String(value).padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals, padded.length - decimals + 2) : '';
  const trimmed = fraction.replace(/0+$/, '');

  return trimmed ? `${whole}.${trimmed}` : whole;
}

export const __testing = { findSeries, checkUniform, WINDOW_MS, MAX_DEVIATION };
