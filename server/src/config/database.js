/**
 * Подключение к PostgreSQL через Sequelize.
 *
 * Экземпляр создаётся один на весь процесс: Sequelize держит внутри пул
 * соединений, и заводить второй — значит удвоить количество коннектов к базе
 * без всякой пользы.
 */

import { Sequelize } from 'sequelize';
import { config } from './env.js';

export const sequelize = new Sequelize({
  dialect: 'postgres',
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  username: config.db.user,
  password: config.db.password,

  // false отключает логирование полностью. Иначе печатаем SQL —
  // при отладке провайдеров это единственный способ увидеть,
  // какой именно запрос ушёл в базу.
  logging: config.db.logging ? (sql) => console.log('[sql]', sql) : false,

  // ВСЁ ВРЕМЯ В UTC.
  //
  // Транзакции блокчейна не привязаны к часовому поясу, а смешение поясов
  // в базе даёт transactions "из будущего" и ломает группировку по
  // временным окнам в эвристике. Конвертация в локальное время —
  // только при отображении на фронте.
  timezone: '+00:00',
  dialectOptions: {
    useUTC: true,
  },

  pool: {
    // Больше и не нужно: запросы к базе у нас короткие, а узкое место —
    // внешние API, а не Postgres.
    max: 10,
    min: 0,
    // Сколько ждать свободного соединения, прежде чем упасть с ошибкой
    acquire: 30_000,
    // Через сколько простоя закрывать лишние соединения
    idle: 10_000,
  },

  define: {
    // createdAt / updatedAt во всех таблицах.
    // Для транзакций это ответ на вопрос "когда МЫ это загрузили" —
    // не путать с timestamp самой транзакции в блокчейне.
    timestamps: true,

    // Имена колонок как в моделях (fromAddress), а не snake_case.
    // Одно соглашение на весь проект: то, что видно в JS, то и в базе.
    underscored: false,
  },
});

/**
 * Проверить, что база доступна.
 *
 * Вызывается при старте сервера: упасть сразу с понятным текстом лучше,
 * чем отвечать 500 на первый же запрос пользователя.
 *
 * @returns {Promise<void>}
 * @throws {Error} с диагностикой, если подключиться не удалось
 */
export async function assertDatabaseConnection() {
  try {
    await sequelize.authenticate();
  } catch (error) {
    throw new Error(
      `Не удалось подключиться к PostgreSQL ` +
        `(${config.db.host}:${config.db.port}/${config.db.name}).\n` +
        `Причина: ${error.message}\n` +
        `Проверь, что база поднята: docker compose ps`,
      { cause: error },
    );
  }
}

/**
 * Закрыть пул соединений. Нужно при остановке сервера, чтобы процесс
 * завершился, а не висел с открытыми коннектами.
 *
 * @returns {Promise<void>}
 */
export async function closeDatabaseConnection() {
  await sequelize.close();
}

export default sequelize;
