/**
 * Бизнес-логика кошелька: кэш, сохранение, построение графа.
 *
 * Здесь живёт ответ на вопрос «идти во внешний API или хватит того, что в
 * базе». Контроллер выше занимается только HTTP, провайдеры ниже — только
 * своими эндпоинтами.
 *
 * Ключевой принцип: граф ВСЕГДА строится из базы, даже если данные только
 * что оттуда записаны. Причины:
 *
 *   - при попадании в кэш ответа от API просто нет, а граф нужен;
 *   - в базе уже лежит то, что мы знали об адресе раньше — например
 *     переводы, увиденные при разборе соседнего адреса;
 *   - при раскрытии узлов граф накапливается, а не перезаписывается.
 *
 * Иначе кэш был бы бессмысленным, а граф — забывчивым.
 */

import { Op } from 'sequelize';
import { sequelize, Address, Transaction } from '../models/index.js';
import { config } from '../config/env.js';
import { getNetwork } from '../config/networks.js';
import {
  fetchAddressActivity,
  fetchBalance,
  fetchTokenBalances,
  collectAddresses,
} from './chainData.js';
import { detectStructuring } from './heuristics.js';

/**
 * Сколько строк вставляем за один запрос.
 *
 * У Postgres предел в 65535 параметров на запрос. При 14 колонках это около
 * 4600 строк, но дробим сильно раньше: большие пачки дольше держат блокировки
 * и хуже диагностируются при ошибке.
 */
const INSERT_CHUNK_SIZE = 500;

/**
 * Поля, которые обновляются при повторной вставке того же перевода.
 *
 * Первичный ключ (network, hash, transferIndex) в список не входит — по нему
 * идёт сопоставление. Обновление нужно из-за перезапроса последних блоков:
 * при реорганизации цепи данные могли измениться.
 */
const TRANSACTION_UPDATE_FIELDS = [
  'fromAddress',
  'toAddress',
  'value',
  'decimals',
  'tokenSymbol',
  'tokenContractAddress',
  'transferType',
  'blockNumber',
  'blockTimestamp',
];

/**
 * Разбить массив на куски.
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Свежий ли кэш адреса.
 *
 * Отвечает НЕ на вопрос «данные ещё верны» — транзакции неизменяемы и верны
 * всегда. Отвечает на «стоит ли идти проверять, не появилось ли новых».
 * Внутри TTL мы сознательно отдаём возможно неполные данные, экономя лимит
 * внешнего API.
 *
 * @param {import('../models/Address.js').Address | null} addressRow
 * @returns {boolean}
 */
function isCacheFresh(addressRow) {
  if (!addressRow?.lastFetchedAt) return false;

  const ageMinutes = (Date.now() - new Date(addressRow.lastFetchedAt).getTime()) / 60_000;
  return ageMinutes < config.app.cacheTtlMinutes;
}

/**
 * Сохранить переводы и отметить встреченные адреса.
 *
 * Всё в одной транзакции БД: если упадём на середине, не останется состояния
 * «переводы записаны, а отметка синхронизации нет» — при следующем запросе
 * мы бы решили, что данные свежие, и потеряли бы хвост.
 *
 * @param {string} networkKey
 * @param {string} address запрошенный адрес
 * @param {object[]} transfers
 * @param {object} syncState
 * @returns {Promise<{ saved: number, knownAddresses: number }>}
 */
async function persistActivity(networkKey, address, transfers, syncState) {
  return sequelize.transaction(async (dbTransaction) => {
    // 1. Переводы. upsert, а не insert: при перезапросе последних блоков
    //    те же записи приходят повторно, а при реорганизации цепи могли
    //    измениться.
    for (const part of chunk(transfers, INSERT_CHUNK_SIZE)) {
      await Transaction.bulkCreate(part, {
        updateOnDuplicate: TRANSACTION_UPDATE_FIELDS,
        transaction: dbTransaction,
      });
    }

    // 2. Адреса-участники. ignoreDuplicates обязателен: среди них есть уже
    //    известные нам адреса, и обычный upsert затёр бы им lastFetchedAt
    //    и syncState — то есть мы бы «забыли», что выкачивали их целиком.
    const participants = collectAddresses(transfers)
      .filter((participant) => participant !== address)
      .map((participant) => ({ network: networkKey, address: participant }));

    for (const part of chunk(participants, INSERT_CHUNK_SIZE)) {
      await Address.bulkCreate(part, {
        ignoreDuplicates: true,
        transaction: dbTransaction,
      });
    }

    // 3. Сам запрошенный адрес: отмечаем, что выкачивали его целиком,
    //    и сохраняем состояние синхронизации провайдеров.
    await Address.upsert(
      {
        network: networkKey,
        address,
        lastFetchedAt: new Date(),
        syncState,
      },
      { transaction: dbTransaction },
    );

    return { saved: transfers.length, knownAddresses: participants.length };
  });
}

/**
 * Синхронизировать адрес с внешними источниками, если это нужно.
 *
 * @param {string} networkKey
 * @param {string} address канонический адрес
 * @param {{ force?: boolean, loadMore?: boolean }} [options]
 *   force    — игнорировать TTL (кнопка «обновить»)
 *   loadMore — догрузить более старые переводы (кнопка «загрузить ещё»)
 * @returns {Promise<{ fetched: boolean, saved: number, hasMore: boolean, partial: string[] }>}
 */
export async function syncAddress(networkKey, address, { force = false, loadMore = false } = {}) {
  getNetwork(networkKey); // упадёт раньше сетевых запросов, если сеть неизвестна

  const existing = await Address.findOne({ where: { network: networkKey, address } });

  // Догрузка и принудительное обновление кэш игнорируют: пользователь
  // явно попросил сходить за данными
  if (!force && !loadMore && isCacheFresh(existing)) {
    return {
      fetched: false,
      saved: 0,
      // Состояние прошлой синхронизации помнит, остался ли непрочитанный хвост
      hasMore: hasPendingTail(existing?.syncState),
      partial: [],
    };
  }

  const activity = await fetchAddressActivity(networkKey, address, existing?.syncState, {
    loadMore,
  });

  const { saved } = await persistActivity(
    networkKey,
    address,
    activity.transfers,
    activity.syncState,
  );

  // Эвристика — после сохранения: она смотрит на ВСЮ накопленную историю
  // адреса, а не только на то, что пришло сейчас. Серия могла начаться
  // в прошлой порции и продолжиться в этой.
  await analyzeAddress(networkKey, address);

  return {
    fetched: true,
    saved,
    hasMore: activity.hasMore,
    partial: activity.partial ?? [],
  };
}

/**
 * Прогнать эвристику по адресу и сохранить результат.
 *
 * Считаем при синхронизации, а не при каждом запросе графа: данные меняются
 * только когда приходят новые переводы, а перебирать тысячи записей на
 * каждое открытие страницы незачем.
 *
 * Ошибка здесь не должна ронять синхронизацию: эвристика — дополнение
 * к данным, а не условие их сохранения.
 *
 * @param {string} networkKey
 * @param {string} address
 */
export async function analyzeAddress(networkKey, address) {
  try {
    // Берём всю историю адреса, без ограничения по числу строк: серия
    // могла случиться в любой момент, а не только среди свежих переводов
    const transfers = await readTransfers(networkKey, address, { days: 0, limit: 0 });
    const result = detectStructuring(transfers, address);

    await Address.update(
      {
        isSuspicious: result.suspicious,
        suspicionReason: result.reason,
      },
      { where: { network: networkKey, address } },
    );

    return result;
  } catch (error) {
    console.warn(`[heuristics] не удалось проанализировать ${address}: ${error.message}`);
    return { suspicious: false, reason: null, series: [] };
  }
}

/**
 * Остался ли непрочитанный хвост хотя бы у одного источника.
 * @param {object|null|undefined} syncState
 */
function hasPendingTail(syncState) {
  if (!syncState) return false;

  return Object.values(syncState).some(
    (source) => source && source.pendingMaxTimestamp != null,
  );
}

/**
 * Предел строк на один запрос графа.
 *
 * Нужен именно как значение ПО УМОЛЧАНИЮ, а не как необязательная опция:
 * без него запрос вернул бы все переводы адреса, а их накапливается по
 * ~300 за каждый клик «загрузить ещё». Несколько тысяч рёбер не отрисуются
 * вменяемо и поедут на фронт мегабайтами JSON.
 *
 * Берём самые свежие: сортировка по времени убывает.
 */
const DEFAULT_READ_LIMIT = 1000;

/**
 * Дополнить балансы токенов символом и точностью.
 *
 * TronGrid отдаёт баланс токена как { адрес_контракта: сумма } — без
 * символа и без decimals. Без них число бессмысленно: 266664000000 это
 * 266 тысяч или 0.26, зависит от точности.
 *
 * Берём метаданные из СВОИХ транзакций: мы их сохраняем при каждой
 * синхронизации, и для токенов, которыми адрес реально пользовался, они
 * уже есть. Внешних запросов не требуется.
 *
 * Токены без метаданных отдаём как есть, но помеченными: это чаще всего
 * спам-рассылки, которых на Tron у любого активного адреса десятки.
 * Решение, показывать их или нет, принимает интерфейс — сервер не должен
 * молча выбрасывать данные.
 *
 * @param {string} networkKey
 * @param {Array<{ contractAddress: string, balance: string }>} tokens
 */
async function describeTokens(networkKey, tokens = []) {
  if (tokens.length === 0) return [];

  const contracts = tokens.map((token) => token.contractAddress).filter(Boolean);

  // Одна запись на контракт: DISTINCT ON берёт первую строку в группе,
  // а сортировка по времени даёт самые свежие метаданные
  const rows = await Transaction.findAll({
    where: {
      network: networkKey,
      tokenContractAddress: { [Op.in]: contracts },
    },
    attributes: [
      'tokenContractAddress',
      'tokenSymbol',
      'decimals',
      [sequelize.fn('COUNT', sequelize.col('hash')), 'transferCount'],
    ],
    group: ['tokenContractAddress', 'tokenSymbol', 'decimals'],
    raw: true,
  });

  const meta = new Map();
  for (const row of rows) {
    const previous = meta.get(row.tokenContractAddress);
    const transferCount = Number(row.transferCount);

    // У одного контракта метаданные не меняются, но на всякий случай
    // берём вариант с наибольшим числом переводов
    if (!previous || transferCount > previous.transferCount) {
      meta.set(row.tokenContractAddress, {
        symbol: row.tokenSymbol,
        decimals: row.decimals,
        transferCount,
      });
    }
  }

  return tokens.map((token) => {
    const info = meta.get(token.contractAddress);

    return {
      ...token,
      symbol: info?.symbol ?? null,
      decimals: info?.decimals ?? null,
      // Сколько раз токен участвовал в переводах этого адреса.
      //
      // Главный признак мусора. Спам-рассылки на Tron массовы: у активного
      // адреса на балансе висят десятки токенов, которые он никогда не
      // использовал. У настоящего токена переводов десятки и сотни,
      // у спама — один, тот самый, которым его и прислали.
      //
      // Совпадение символов тоже встречается: у тестового адреса нашлось
      // два разных контракта с символом «ip292» — подделки под что-то.
      // Поэтому решает не название, а активность.
      transferCount: info?.transferCount ?? 0,
      known: Boolean(info),
    };
  });
}

/**
 * Прочитать переводы адреса из базы.
 *
 * Фильтр по времени применяется ЗДЕСЬ, а не при сохранении: храним максимум,
 * показываем срез. Пользователь может передумать и попросить больший период,
 * и данные для этого уже лежат — повторно качать не придётся.
 *
 * @param {string} networkKey
 * @param {string} address
 * @param {{ days?: number, limit?: number, counterparty?: string, token?: string }} [options]
 *   limit        — 0 снимает ограничение (для выгрузки и эвристики)
 *   counterparty — только переводы с этим адресом (в обе стороны).
 *                  Нужен панели деталей ребра: ребро графа — это все
 *                  переводы между парой адресов в одном токене
 *   token        — адрес контракта токена; null-строка 'native' означает
 *                  нативную монету, у неё контракта нет
 * @returns {Promise<object[]>}
 */
export async function readTransfers(
  networkKey,
  address,
  { days, limit, counterparty, token } = {},
) {
  const graphDays = days ?? config.app.graphDays;
  const rowLimit = limit === undefined ? DEFAULT_READ_LIMIT : limit;

  const where = buildTransferWhere(networkKey, address, { graphDays, counterparty, token });

  return Transaction.findAll({
    where,
    order: [['blockTimestamp', 'DESC']],
    ...(rowLimit > 0 ? { limit: rowLimit } : {}),
  });
}

/**
 * Собрать условие выборки переводов.
 *
 * Вынесено отдельно, потому что нужно и чтению, и подсчёту: разъехавшиеся
 * условия дали бы «показано 20 из 5» — счётчик считал бы одно, а список
 * возвращал другое.
 */
function buildTransferWhere(networkKey, address, { graphDays, counterparty, token }) {
  /** @type {Record<string, unknown>} */
  const where = { network: networkKey };

  if (counterparty) {
    // Переводы строго между двумя адресами, в обе стороны.
    // Op.and, а не два Op.or подряд: второй перезаписал бы первый — в
    // объекте не может быть двух одинаковых ключей.
    where[Op.and] = [
      { [Op.or]: [{ fromAddress: address }, { toAddress: address }] },
      { [Op.or]: [{ fromAddress: counterparty }, { toAddress: counterparty }] },
    ];
  } else {
    where[Op.or] = [{ fromAddress: address }, { toAddress: address }];
  }

  if (token) {
    // Ключ токена совпадает с тем, что использует построитель графа:
    // адрес контракта либо 'native' для монеты сети
    where.tokenContractAddress = token === 'native' ? null : token;
  }

  if (graphDays > 0) {
    where.blockTimestamp = {
      [Op.gte]: new Date(Date.now() - graphDays * 24 * 60 * 60 * 1000),
    };
  }

  return where;
}

/**
 * Сколько всего переводов лежит в базе за период.
 *
 * Нужно, чтобы отличить «это все данные» от «показаны только первые N»:
 * без этого пользователь не поймёт, почему список выглядит урезанным.
 *
 * @param {string} networkKey
 * @param {string} address
 * @param {{ days?: number, counterparty?: string, token?: string }} [options]
 * @returns {Promise<number>}
 */
export async function countTransfers(
  networkKey,
  address,
  { days, counterparty, token } = {},
) {
  const graphDays = days ?? config.app.graphDays;

  return Transaction.count({
    where: buildTransferWhere(networkKey, address, { graphDays, counterparty, token }),
  });
}

/**
 * Пометки известных нам адресов: выкачивали ли мы их целиком и есть ли метка.
 *
 * Нужны графу, чтобы отличить раскрытый узел от нераскрытого. Без этого
 * пользователь не понимает, где данные полные, а где видна только связь
 * с уже открытым адресом.
 *
 * @param {string} networkKey
 * @param {string[]} addresses
 * @returns {Promise<Map<string, { fetched: boolean, label: string|null, isSuspicious: boolean }>>}
 */
export async function readAddressMeta(networkKey, addresses) {
  if (addresses.length === 0) return new Map();

  const rows = await Address.findAll({
    where: { network: networkKey, address: { [Op.in]: addresses } },
    attributes: ['address', 'lastFetchedAt', 'label', 'isSuspicious', 'suspicionReason'],
  });

  return new Map(
    rows.map((row) => [
      row.address,
      {
        fetched: row.lastFetchedAt != null,
        label: row.label,
        isSuspicious: row.isSuspicious,
        suspicionReason: row.suspicionReason,
      },
    ]),
  );
}

/**
 * Кэш балансов в памяти.
 *
 * Замер показал: при попадании в кэш переводов всё локальное укладывается
 * в 91 мс, а запрос баланса занимает от 500 мс до 8 секунд — TronGrid без
 * ключа отвечает непредсказуемо. То есть время ответа определял именно он.
 *
 * В базе баланс не храним (он устаревает в момент записи), но держать его
 * минуту в памяти безопасно: за это время он меняется только если адрес
 * совершил транзакцию, а такие данные и так подтянутся при следующей
 * синхронизации.
 *
 * @type {Map<string, { value: object, expiresAt: number }>}
 */
const balanceCache = new Map();

/** Сколько живёт запись кэша баланса */
const BALANCE_TTL_MS = 60_000;

/**
 * Чтобы карта не росла бесконечно при большом числе адресов.
 * При переполнении выбрасываем самую старую запись.
 */
const BALANCE_CACHE_LIMIT = 500;

/**
 * Сколько токенов без единого перевода отдаём наружу.
 *
 * Столько же показывает интерфейс, свернув их за кнопку «ещё N токенов»,
 * — присылать больше бессмысленно.
 */
const SPAM_TOKENS_LIMIT = 50;

/**
 * Отрезать хвост спам-токенов.
 *
 * У биржевого адреса в Solana нашлось 3812 токен-аккаунтов, из которых
 * осмысленных — 37. Полный список весил 615 КБ из 642 КБ всего ответа:
 * мы гнали по сети полмегабайта мусора, чтобы показать три десятка строк.
 *
 * Токены с переводами оставляем ВСЕ: их мало, и именно они интересны.
 * Остальные обрезаем, но сохраняем общее число — интерфейс честно
 * покажет, сколько всего висит на балансе.
 *
 * @param {object[]} tokens
 * @returns {{ tokens: object[], hiddenTokenCount: number }}
 */
function trimTokens(tokens) {
  const meaningful = tokens.filter((token) => token.transferCount > 0);
  const rest = tokens.filter((token) => !token.transferCount);

  return {
    tokens: [...meaningful, ...rest.slice(0, SPAM_TOKENS_LIMIT)],
    hiddenTokenCount: rest.length,
  };
}

/**
 * Сколько контрактов спрашиваем поимённо.
 *
 * Каждый — отдельный запрос, идущий последовательно. Двадцать самых
 * активных токенов покрывают осмысленную часть баланса; хвост из
 * одноразовых спам-рассылок всё равно был бы отброшен при показе.
 */
const TOKEN_BALANCE_LIMIT = 20;

/**
 * Контракты токенов, которыми адрес реально пользовался.
 *
 * Берём из наших же сохранённых переводов и сортируем по числу
 * упоминаний: у настоящего токена переводов десятки, у спама — один,
 * тот самый, которым его и прислали.
 *
 * @param {string} networkKey
 * @param {string} address
 * @returns {Promise<string[]>}
 */
async function knownTokenContracts(networkKey, address) {
  const rows = await Transaction.findAll({
    where: {
      network: networkKey,
      tokenContractAddress: { [Op.ne]: null },
      [Op.or]: [{ fromAddress: address }, { toAddress: address }],
    },
    attributes: [
      'tokenContractAddress',
      [sequelize.fn('COUNT', sequelize.col('hash')), 'transferCount'],
    ],
    group: ['tokenContractAddress'],
    order: [[sequelize.literal('"transferCount"'), 'DESC']],
    limit: TOKEN_BALANCE_LIMIT,
    raw: true,
  });

  return rows.map((row) => row.tokenContractAddress);
}

/**
 * Баланс адреса. Отдельный запрос к API, из переводов не выводится:
 * мимо списка транзакций проходят комиссии, заморозка под ресурсы и награды.
 *
 * @param {string} networkKey
 * @param {string} address
 * @param {{ force?: boolean }} [options]
 */
export async function getBalance(networkKey, address, { force = false } = {}) {
  const key = `${networkKey}|${address}`;
  const cached = balanceCache.get(key);

  if (!force && cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }

  const raw = await fetchBalance(networkKey, address);

  // У EVM-сетей список токенов на балансе платный, поэтому провайдер
  // отдаёт только нативную монету. Контракты берём из уже сохранённых
  // переводов адреса и спрашиваем балансы поимённо
  const tokens = raw.tokens.length > 0
    ? raw.tokens
    : await fetchTokenBalances(networkKey, address, await knownTokenContracts(networkKey, address));

  const value = { ...raw, ...trimTokens(await describeTokens(networkKey, tokens)) };

  if (balanceCache.size >= BALANCE_CACHE_LIMIT) {
    // Map перебирает ключи в порядке вставки — первый и есть самый старый
    const oldest = balanceCache.keys().next().value;
    balanceCache.delete(oldest);
  }

  balanceCache.set(key, { value, expiresAt: Date.now() + BALANCE_TTL_MS });
  return { ...value, cached: false };
}
