/**
 * Метки адресов: «Binance-Hot 1», «Kucoin 4» и теги риска.
 *
 * ПОЧЕМУ ОТДЕЛЬНО ОТ ГРАФА.
 * Запрос метки занимает 150–1100 мс и делается на ОДИН адрес. Для двадцати
 * узлов графа это до двадцати секунд — в основной путь такое ставить нельзя.
 * Поэтому фронт сначала получает и рисует граф (~800 мс), а метки
 * подтягивает следом, отдельным запросом, и просто обновляет подписи.
 *
 * ПОЧЕМУ КЭШ В БАЗЕ, А НЕ В ПАМЯТИ, КАК У БАЛАНСА.
 * Баланс меняется после каждой транзакции — держать его дольше минуты
 * бессмысленно. Метка «Binance-Hot 1» не меняется годами, а биржевые адреса
 * встречаются в каждом втором графе: один раз узнали — переиспользуем везде.
 *
 * Источник: TronScan /api/account/tag, работает без ключа.
 */

import axios from 'axios';
import { Op } from 'sequelize';
import { Address } from '../models/index.js';
import { config } from '../config/env.js';
import { getNetwork } from '../config/networks.js';

/**
 * Сколько живёт метка, прежде чем спросим заново.
 *
 * Неделя, а не вечность: метки — чужие данные, и адрес могут пометить как
 * скам после инцидента. Такое обновление нам нужно, но не срочно.
 */
const LABEL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Минимальный интервал между запросами к TronScan.
 *
 * Лимит без ключа — 3 запроса в секунду, и сервис говорит об этом прямым
 * текстом: "request rate exceeded the allowed_rps(3)". Замерено: пять
 * параллельных запросов дают 429 на ВСЕХ пяти, а не на лишних двух.
 *
 * 350 мс ≈ 2.8 запроса в секунду — с запасом под лимит. Двадцать адресов
 * разбираются за ~7 секунд, но это фоновая догрузка: граф уже нарисован,
 * и метки просто уточняют подписи. Повторно те же адреса берутся из базы.
 *
 * С ключом TRONSCAN_API_KEY лимит выше, и интервал можно уменьшить.
 */
const REQUEST_INTERVAL_MS = 350;

/** Сколько раз повторяем при 429 */
const MAX_RETRIES = 3;

/** Ограничение на размер одного запроса — защита от гигантских списков */
const MAX_ADDRESSES_PER_CALL = 100;

/**
 * Сколько НЕИЗВЕСТНЫХ адресов догружаем за один вызов.
 *
 * Из кэша отдаём сколько угодно — это быстро. А вот походы в TronScan
 * ограничены его лимитом в 3 запроса в секунду: замер на 21 адресе дал
 * 29 секунд ожидания. Восемь новых адресов укладываются в ~3 секунды.
 *
 * Остальные подтянутся при следующем вызове: фронт повторяет запрос, пока
 * в ответе stats.pending больше нуля. Так метки появляются порциями, а не
 * все разом после долгой паузы.
 */
const MAX_FETCH_PER_CALL = 8;

const REQUEST_TIMEOUT_MS = 8_000;

const client = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    ...(config.api.tronScanKey ? { 'TRON-PRO-API-KEY': config.api.tronScanKey } : {}),
  },
});

/**
 * Спросить метку одного адреса.
 *
 * Ошибки НЕ пробрасываем: метка — украшение поверх готового графа.
 * Не ответили — узел останется подписан сокращённым адресом, и это
 * приемлемо. Ронять из-за этого весь запрос нельзя.
 *
 * @param {string} baseUrl
 * @param {string} address
 * @returns {Promise<{ label: string|null, tags: object|null } | null>}
 *   null означает «спросить не удалось» — в отличие от { label: null },
 *   которое значит «спросили, метки нет»
 */
async function fetchLabel(baseUrl, address) {
  try {
    let data;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        ({ data } = await client.get(`${baseUrl}/api/account/tag`, { params: { address } }));
        break;
      } catch (error) {
        const status = error.response?.status;
        // 429 — превышен лимит: ждём дольше и пробуем снова.
        // Прочие ошибки повторять бессмысленно.
        if (status !== 429 || attempt === MAX_RETRIES) throw error;
        await sleep(REQUEST_INTERVAL_MS * 2 ** (attempt + 1));
      }
    }

    // Для контрактов эндпоинт отвечает { msg, code } вместо разметки
    if (!data || data.code !== undefined) {
      return { label: null, tags: null };
    }

    const chainTags = collectChainTags(data.chainTags);

    const tags = {
      ...(data.redTag ? { redTag: data.redTag } : {}),
      ...(data.greyTag ? { greyTag: data.greyTag } : {}),
      ...(data.blueTag ? { blueTag: data.blueTag } : {}),
      ...(chainTags.length > 0 ? { chainTags } : {}),
    };

    return {
      label: data.publicTag || null,
      tags: Object.keys(tags).length > 0 ? tags : null,
    };
  } catch {
    return null;
  }
}

/**
 * Вытащить названия поведенческих тегов из вложенной структуры TronScan.
 *
 * Приходит так: { Assets: [{ tagName: 'High Balance', ... }], Activity: [...] }
 * Нам нужны только названия.
 *
 * @param {object|undefined} chainTags
 * @returns {string[]}
 */
function collectChainTags(chainTags) {
  if (!chainTags || typeof chainTags !== 'object') return [];

  return Object.values(chainTags)
    .flat()
    .map((tag) => tag?.tagName)
    .filter(Boolean);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Выполнить задачи последовательно, выдерживая интервал между запросами.
 *
 * Именно последовательно, а не пачками: замер показал, что при превышении
 * лимита TronScan отбивает ВСЕ параллельные запросы разом, а не только
 * лишние. То есть параллелизм здесь не ускоряет, а обнуляет результат.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Promise<void>} worker
 */
async function runThrottled(items, worker) {
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) await sleep(REQUEST_INTERVAL_MS);
    await worker(items[i]);
  }
}

/**
 * Свежая ли метка.
 * @param {Date|null} labelFetchedAt
 */
function isLabelFresh(labelFetchedAt) {
  if (!labelFetchedAt) return false;
  return Date.now() - new Date(labelFetchedAt).getTime() < LABEL_TTL_MS;
}

/**
 * Получить метки для списка адресов.
 *
 * Известные отдаёт из базы мгновенно, недостающие догружает с ограничением
 * параллелизма и сохраняет.
 *
 * @param {string} networkKey
 * @param {string[]} addresses
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<{
 *   labels: Record<string, { label: string|null, tags: object|null, isSuspicious: boolean }>,
 *   stats: { requested: number, fromCache: number, fetched: number, failed: number },
 * }>}
 */
export async function getLabels(networkKey, addresses, { force = false } = {}) {
  const network = getNetwork(networkKey);

  const unique = [...new Set(addresses.filter(Boolean))].slice(0, MAX_ADDRESSES_PER_CALL);
  if (unique.length === 0) {
    return { labels: {}, stats: { requested: 0, fromCache: 0, fetched: 0, failed: 0 } };
  }

  const rows = await Address.findAll({
    where: { network: networkKey, address: { [Op.in]: unique } },
    attributes: ['address', 'label', 'labelFetchedAt', 'tags', 'isSuspicious', 'suspicionReason'],
  });

  const byAddress = new Map(rows.map((row) => [row.address, row]));

  /** @type {Record<string, object>} */
  const labels = {};
  const toFetch = [];

  for (const address of unique) {
    const row = byAddress.get(address);

    if (!force && row && isLabelFresh(row.labelFetchedAt)) {
      labels[address] = {
        label: row.label,
        tags: row.tags,
        isSuspicious: row.isSuspicious,
        suspicionReason: row.suspicionReason,
      };
      continue;
    }

    toFetch.push(address);
  }

  const fromCache = unique.length - toFetch.length;
  let failed = 0;

  // Догружаем только первую порцию, остальные оставляем на следующий вызов
  const batch = toFetch.slice(0, MAX_FETCH_PER_CALL);
  const deferred = toFetch.slice(MAX_FETCH_PER_CALL);

  // Отложенные отдаём с тем, что уже есть в базе: подпись узла останется
  // сокращённым адресом, но ответ придёт быстро
  for (const address of deferred) {
    const row = byAddress.get(address);
    labels[address] = {
      label: row?.label ?? null,
      tags: row?.tags ?? null,
      isSuspicious: row?.isSuspicious ?? false,
      suspicionReason: row?.suspicionReason ?? null,
      pending: true,
    };
  }

  // У сетей без TronScan разметки нет: адрес `${undefined}/api/account/tag`
  // ушёл бы в никуда, и на каждый узел графа тратилась бы пауза
  // троттлинга — 350 мс на адрес впустую. Возвращаем то, что в базе
  if (!network.api?.tronScan) {
    // Заполняем тем, что есть в базе. Через этот же ответ уходит результат
    // НАШЕЙ эвристики — isSuspicious и suspicionReason, — поэтому просто
    // пропустить адреса нельзя: пропала бы подсветка подозрительных узлов
    for (const address of batch) {
      const row = byAddress.get(address);
      labels[address] = {
        label: row?.label ?? null,
        tags: row?.tags ?? null,
        isSuspicious: row?.isSuspicious ?? false,
        suspicionReason: row?.suspicionReason ?? null,
      };
    }

    return {
      labels,
      stats: {
        requested: unique.length,
        fromCache: unique.length,
        fetched: 0,
        failed: 0,
        // Нулевой pending важен: фронт повторяет запрос, пока это
        // значение больше нуля, — иначе получили бы вечный цикл
        pending: 0,
      },
    };
  }

  await runThrottled(batch, async (address) => {
    const result = await fetchLabel(network.api.tronScan, address);

    if (result === null) {
      // Спросить не удалось: отдаём то, что есть в базе, и НЕ обновляем
      // labelFetchedAt — иначе запомнили бы неудачу на неделю
      failed += 1;
      const row = byAddress.get(address);
      labels[address] = {
        label: row?.label ?? null,
        tags: row?.tags ?? null,
        isSuspicious: row?.isSuspicious ?? false,
        suspicionReason: row?.suspicionReason ?? null,
      };
      return;
    }

    const row = byAddress.get(address);

    labels[address] = {
      label: result.label,
      tags: result.tags,
      isSuspicious: row?.isSuspicious ?? false,
      suspicionReason: row?.suspicionReason ?? null,
    };

    // upsert, а не update: адрес мог не встречаться нам раньше
    await Address.upsert({
      network: networkKey,
      address,
      label: result.label,
      tags: result.tags,
      labelFetchedAt: new Date(),
    });
  });

  return {
    labels,
    stats: {
      requested: unique.length,
      fromCache,
      fetched: batch.length - failed,
      failed,
      // Сколько адресов осталось на следующий вызов. Фронт повторяет
      // запрос, пока значение больше нуля
      pending: deferred.length,
    },
  };
}
