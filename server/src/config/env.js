/**
 * Единственная точка чтения переменных окружения.
 *
 * Зачем отдельный модуль, а не process.env по месту:
 *
 *  1. Приведение типов. process.env всегда отдаёт СТРОКИ: DB_PORT === "5433",
 *     CACHE_TTL_MINUTES === "60". Арифметика над ними молча ломается.
 *  2. Дефолты в одном месте, а не россыпью `|| 60` по всему коду.
 *  3. Обязательные переменные проверяются при старте — падаем сразу
 *     с внятным сообщением, а не при первом запросе к БД.
 *  4. Порядок загрузки. В ESM все импорты выполняются раньше тела модуля,
 *     поэтому dotenv.config() в app.js опоздал бы: database.js успел бы
 *     прочитать пустой process.env. Этот модуль импортируется первым
 *     в цепочке и грузит .env как побочный эффект импорта.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Путь к .env считаем ОТ РАСПОЛОЖЕНИЯ ЭТОГО ФАЙЛА, а не от process.cwd():
// cwd зависит от того, откуда запустили процесс, и легко оказывается другим
// (npm-скрипт, systemd, докер, запуск из IDE).
//
//   server/src/config/env.js  ->  ../../../.env  ->  <корень проекта>/.env
const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, '../../../.env');

dotenv.config({ path: ENV_PATH, quiet: true });

/**
 * Обязательная переменная. Отсутствует — падаем на старте.
 * @param {string} name
 * @returns {string}
 */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Переменная окружения ${name} не задана. ` +
        `Проверь файл ${ENV_PATH} (см. .env.example)`,
    );
  }
  return value;
}

/**
 * Строка с значением по умолчанию.
 * @param {string} name
 * @param {string} fallback
 */
function str(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Число с значением по умолчанию. Нечисловое значение — ошибка на старте,
 * а не NaN, всплывающий где-то в арифметике через час работы.
 * @param {string} name
 * @param {number} fallback
 */
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Переменная ${name} должна быть числом, получено: "${raw}"`);
  }
  return value;
}

/**
 * Булево значение. Истиной считаются только "true"/"1"/"yes" —
 * чтобы DB_LOGGING=false не оказалось истиной (непустая строка!).
 * @param {string} name
 * @param {boolean} fallback
 */
function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export const config = {
  /** Путь к прочитанному .env — пригодится в сообщениях об ошибках */
  envPath: ENV_PATH,

  server: {
    port: num('PORT', 4000),
    nodeEnv: str('NODE_ENV', 'development'),

    /**
     * Разрешённые источники для CORS, через запятую.
     * Пусто = разрешено всем (удобно в разработке, опасно на проде:
     * чужой сайт сможет жечь наш лимит внешних API).
     */
    corsOrigins: str('CORS_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    get isDev() {
      return this.nodeEnv !== 'production';
    },
  },

  db: {
    host: str('DB_HOST', 'localhost'),
    port: num('DB_PORT', 5433),
    name: str('DB_NAME', 'wallet_explorer'),
    user: str('DB_USER', 'wallet'),
    // Единственная обязательная переменная: дефолтный пароль у базы —
    // самая массовая уязвимость в подобных проектах.
    password: required('DB_PASSWORD'),

    /** Печатать каждый SQL-запрос в консоль. Полезно при отладке, шумно всегда */
    logging: bool('DB_LOGGING', false),
  },

  api: {
    // Оба ключа не обязательны: TronGrid и TronScan отвечают и без них,
    // просто с низким лимитом. Разработку это не блокирует.
    tronGridKey: str('TRONGRID_API_KEY', ''),
    tronScanKey: str('TRONSCAN_API_KEY', ''),

    /**
     * Ключ Etherscan V2 — один на все EVM-сети.
     *
     * В ОТЛИЧИЕ от ключей Tron этот обязателен: V2 без него не отвечает
     * вовсе. Но required() здесь не ставим — иначе сервер не поднимется
     * у того, кто работает только с Tron. Провайдер проверяет ключ сам
     * и объясняет, где его взять.
     */
    etherscanKey: str('ETHERSCAN_API_KEY', ''),

    /**
     * Ключ Helius — Solana.
     *
     * Тоже обязателен: публичный узел Solana отдаёт только недавнюю
     * историю (замерено: 14 транзакций из 30) и отбивает запросы после
     * восьми подряд. Проверяется провайдером, а не здесь, — иначе сервер
     * не поднялся бы у того, кто работает без Solana.
     */
    heliusKey: str('HELIUS_API_KEY', ''),
  },

  app: {
    defaultNetwork: str('DEFAULT_NETWORK', 'tron'),

    /** Сколько минут данные адреса считаются достаточно свежими */
    cacheTtlMinutes: num('CACHE_TTL_MINUTES', 60),

    /** Записей за один запрос к TronGrid. Потолок самого API — 200 */
    fetchLimit: num('FETCH_LIMIT', 200),

    /** Записей внутренних переводов за запрос (TronScan) */
    internalFetchLimit: num('INTERNAL_FETCH_LIMIT', 200),

    /**
     * Сколько страниц тянем при ДОГРУЗКЕ и инкременте.
     * Пользователь в этот момент не ждёт первого показа графа.
     */
    maxPagesPerFetch: num('MAX_PAGES_PER_FETCH', 5),

    /**
     * Сколько страниц тянем при ПЕРВОМ обращении к адресу.
     * Здесь важна скорость ответа: 1 страница ≈ 3 сек, 5 страниц ≈ 26 сек.
     * Остальное подгружается по кнопке «загрузить ещё».
     */
    firstFetchPages: num('FIRST_FETCH_PAGES', 1),

    /** Глубина графа по умолчанию, дней. 0 = отдавать всё */
    graphDays: num('GRAPH_DAYS', 30),
  },
};

export default config;
