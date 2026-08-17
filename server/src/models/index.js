/**
 * Сборка моделей и создание схемы в базе.
 *
 * Про отсутствие ассоциаций (belongsTo / hasMany).
 *
 * Их нет намеренно, по двум причинам:
 *
 *  1. Ключи составные. Связь Transaction -> Address идёт по паре
 *     (network, fromAddress); Sequelize умеет только один foreignKey.
 *
 *  2. Внешний ключ здесь мешал бы. Разбирая транзакции адреса A, мы узнаём
 *     адреса B и C. При FK пришлось бы вставлять их в addresses ДО вставки
 *     переводов — иначе нарушение ограничения. То есть база диктовала бы
 *     порядок операций там, где он не важен.
 *
 * Связь выражается в запросах: WHERE network = ? AND fromAddress = ?.
 * По индексам это работает так же быстро, а гибкости больше.
 */

import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/database.js';
import { Address } from './Address.js';
import { Transaction } from './Transaction.js';

export { Address, Transaction, sequelize };

/**
 * Создать/обновить таблицы по описанию моделей.
 *
 * Для MVP этого достаточно. Как только на схеме появятся реальные данные,
 * которые жалко потерять, sync() надо заменить на миграции (umzug или
 * sequelize-cli): sync умеет добавлять таблицы и колонки, но не умеет
 * переносить данные при изменении типа или переименовании.
 *
 * @param {{ alter?: boolean }} [options]
 *   alter: приводить существующие таблицы к описанию моделей.
 *          Удобно при разработке, ОПАСНО на проде — может дропнуть колонку.
 * @returns {Promise<void>}
 */
export async function syncModels({ alter = false } = {}) {
  await sequelize.sync({ alter });
}

/**
 * Список созданных таблиц — для проверки после sync.
 *
 * Читаем pg_tables, а НЕ information_schema.tables: у последней колонка
 * table_name имеет специальный тип sql_identifier, который драйвер pg
 * разбирает как массив, а не строку. Результат — [["addresses"]] вместо
 * [{table_name: "addresses"}], и тихий undefined при обращении к полю.
 *
 * @returns {Promise<string[]>}
 */
export async function listTables() {
  const rows = await sequelize.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.tablename);
}
