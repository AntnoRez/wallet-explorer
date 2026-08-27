/**
 * Предохранитель на запросы к внешним API.
 *
 * ЗАЧЕМ ОН, ЕСЛИ ЕСТЬ ЛИМИТ НА IP. Лимит на IP защищает от одного
 * нарушителя. Он не защищает ключи: десяток адресов или один человек
 * с прокси выберут суточную квоту Etherscan, оставаясь каждый в рамках
 * своего лимита. И он совсем не защищает от НАС САМИХ — цикл с ошибкой
 * в коде сожжёт квоту за минуты, не сделав ни одного HTTP-запроса
 * снаружи.
 *
 * Поэтому считаем ИСХОДЯЩИЕ запросы, по счётчику на каждый ключ.
 *
 * Два окна:
 *
 *   сутки    защита квоты: у Etherscan 100 000 запросов, у Helius
 *            100 000 кредитов. Исчерпав её к обеду, мы останемся
 *            без сети до утра
 *   минута   защита от разгона: любой цикл упирается в неё за секунды,
 *            и суточная квота остаётся цела
 *
 * ЧТО ДЕЛАЕМ ПРИ ИСЧЕРПАНИИ. Бросаем ошибку с признаком budget — выше
 * по стеку она превращается в понятный ответ «сеть временно недоступна»,
 * а не в пустой граф. Молча отдать неполные данные хуже: пользователь
 * решит, что у адреса нет переводов.
 *
 * Счётчики живут в памяти процесса. При перезапуске обнуляются — это
 * осознанный размен: постоянное хранилище означало бы запись в базу на
 * каждый запрос ради защиты, которая срабатывает раз в месяц.
 */

import { config } from '../config/env.js';

/** Окна учёта */
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько запросов в сутки допускаем для каждого источника.
 *
 * Берём с запасом от заявленной квоты: счётчик у провайдера свой, и
 * упереться в его предел ровно на последнем запросе — значит получить
 * отказ вместо внятного сообщения.
 *
 *   etherscan  заявлено 100 000/сутки
 *   helius     заявлено 100 000 кредитов, но запрос стоит НЕ ОДИН кредит,
 *              поэтому берём вчетверо меньше — точную цену узнаем
 *              по расходу в личном кабинете
 *   tonapi     суточная квота не объявлена; ограничиваем разумным числом
 *   trongrid,
 *   tronscan   работают и без ключа, квота не объявлена
 */
const DEFAULT_DAILY = {
  etherscan: 90_000,
  helius: 25_000,
  tonapi: 20_000,
  trongrid: 50_000,
  tronscan: 20_000,
};

/**
 * Сколько запросов в минуту допускаем.
 *
 * Это не про вежливость к провайдеру — за интервалами следят сами
 * провайдеры. Это про разгон: столько запросов подряд означает, что
 * что-то пошло не так, и лучше остановиться самим.
 */
const DEFAULT_PER_MINUTE = {
  etherscan: 300,
  helius: 300,
  tonapi: 60,
  trongrid: 300,
  tronscan: 200,
};

/** @type {Map<string, { minute: {count: number, resetAt: number}, day: {count: number, resetAt: number} }>} */
const counters = new Map();

/** Сколько раз предохранитель срабатывал — для наблюдения за проблемой */
const blocked = new Map();

function windowFor(source) {
  let entry = counters.get(source);

  if (!entry) {
    const now = Date.now();
    entry = {
      minute: { count: 0, resetAt: now + MINUTE_MS },
      day: { count: 0, resetAt: now + DAY_MS },
    };
    counters.set(source, entry);
  }

  const now = Date.now();
  if (now >= entry.minute.resetAt) {
    entry.minute = { count: 0, resetAt: now + MINUTE_MS };
  }
  if (now >= entry.day.resetAt) {
    entry.day = { count: 0, resetAt: now + DAY_MS };
  }

  return entry;
}

/** Предел для источника с учётом настроек из окружения */
function limitsFor(source) {
  const overrides = config.app.apiBudget ?? {};

  return {
    perMinute: overrides[`${source}PerMinute`] ?? DEFAULT_PER_MINUTE[source] ?? 300,
    perDay: overrides[`${source}PerDay`] ?? DEFAULT_DAILY[source] ?? 50_000,
  };
}

/**
 * Учесть запрос к источнику. Вызывается ПЕРЕД обращением к API.
 *
 * @param {string} source ключ источника: etherscan, helius, tonapi, …
 * @throws {Error} с признаком budget, если квота исчерпана
 */
export function consume(source) {
  const entry = windowFor(source);
  const limits = limitsFor(source);

  if (entry.day.count >= limits.perDay) {
    blocked.set(source, (blocked.get(source) ?? 0) + 1);

    throw Object.assign(
      new Error(
        `Суточный запас запросов к ${source} исчерпан ` +
          `(${entry.day.count} из ${limits.perDay}). ` +
          `Обновится через ${Math.ceil((entry.day.resetAt - Date.now()) / 60000)} мин.`,
      ),
      { budget: true, source, window: 'day' },
    );
  }

  if (entry.minute.count >= limits.perMinute) {
    blocked.set(source, (blocked.get(source) ?? 0) + 1);

    throw Object.assign(
      new Error(
        `Слишком много запросов к ${source} за минуту ` +
          `(${entry.minute.count} из ${limits.perMinute}). ` +
          'Похоже на разгон — подождите минуту.',
      ),
      { budget: true, source, window: 'minute' },
    );
  }

  entry.minute.count += 1;
  entry.day.count += 1;
}

/**
 * Текущий расход — для эндпоинта состояния и отладки.
 *
 * @returns {Record<string, { minute: number, day: number, limits: object, blocked: number }>}
 */
export function snapshot() {
  const result = {};

  for (const [source, entry] of counters) {
    const limits = limitsFor(source);
    const now = Date.now();

    result[source] = {
      minute: now >= entry.minute.resetAt ? 0 : entry.minute.count,
      day: now >= entry.day.resetAt ? 0 : entry.day.count,
      limits,
      blocked: blocked.get(source) ?? 0,
    };
  }

  return result;
}

/** Сброс — только для тестов */
export function reset() {
  counters.clear();
  blocked.clear();
}

export const __testing = { DEFAULT_DAILY, DEFAULT_PER_MINUTE, MINUTE_MS, DAY_MS };
