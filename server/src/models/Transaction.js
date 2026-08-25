/**
 * Перевод средств — одно ребро графа.
 *
 * Слово «транзакция» здесь неточно и это стоит держать в голове: одна
 * транзакция блокчейна может породить НЕСКОЛЬКО строк этой таблицы.
 * Реальный пример из живых данных: мультисенд с 22 переводами USDT под
 * одним хэшем.
 *
 * Строки складываются из трёх источников, различаемых полем transferType:
 *   native   — переводы TRX          (TronGrid /transactions, TransferContract)
 *   token    — переводы TRC-20       (TronGrid /transactions/trc20)
 *   internal — внутренние переводы   (TronScan /api/internal-transaction)
 */

import { DataTypes } from 'sequelize';
import { sequelize } from '../config/database.js';

export const Transaction = sequelize.define(
  'Transaction',
  {
    /** Ключ сети. Часть составного первичного ключа */
    network: {
      type: DataTypes.STRING(32),
      primaryKey: true,
      allowNull: false,
    },

    /** Хэш транзакции блокчейна. У нескольких переводов он может совпадать */
    hash: {
      /*
       * 96 символов — с запасом под самую длинную известную нам форму.
       * Замерено на живых данных:
       *
       *   Tron       64   hex
       *   EVM        66   hex с префиксом 0x
       *   Solana     88   подпись, 64 байта в base58
       *
       * Восьмидесяти не хватало: Solana не влезала, и сохранение падало
       * с «value too long for type character varying(80)».
       */
      type: DataTypes.STRING(96),
      primaryKey: true,
      allowNull: false,
    },

    /**
     * Различает переводы внутри одной транзакции.
     *
     * В Ethereum для этого есть logIndex. В ответе TronGrid /trc20 такого
     * поля НЕТ, поэтому выкручиваемся:
     *
     *   "h:" + sha256(from|to|token|value)  обычный случай, 0 доп. запросов
     *   "e:" + event_index                  при коллизии хэшей, из /events
     *   "e:0"                               переводы TRX (один на транзакцию)
     *   "i:" + internal_hash                внутренние переводы
     *
     * Префикс показывает, каким способом получен ключ — видно прямо в базе.
     *
     * Почему не порядковый номер: он привязан к позиции в ответе API, а
     * стабильность этого порядка не гарантирована. event_index приходит
     * из блокчейна и не может измениться.
     */
    transferIndex: {
      type: DataTypes.STRING(80),
      primaryKey: true,
      allowNull: false,
    },

    /** Отправитель, каноническая форма (для Tron — base58) */
    fromAddress: {
      /*
       * 80 символов — с запасом под самую длинную известную форму.
       * Замерено на живых данных:
       *
       *   Tron       34   base58
       *   EVM        42   hex с префиксом 0x
       *   Solana     44   base58
       *   TON        66   рабочая цепь, двоеточие и 32 байта в hex
       *
       * Шестидесяти четырёх не хватало: TON не влезал, и сохранение
       * падало с «value too long for type character varying(64)».
       */
      type: DataTypes.STRING(80),
      allowNull: false,
    },

    /** Получатель. null возможен, например при деплое контракта */
    toAddress: {
      /** Та же длина, что у fromAddress — см. пояснение выше */
      type: DataTypes.STRING(80),
      allowNull: true,
    },

    /**
     * Сумма в МИНИМАЛЬНЫХ единицах, целое число.
     *
     *   5 TRX      -> "5000000"              decimals 6
     *   1500 USDT  -> "1500000000"           decimals 6
     *   5 ETH      -> "5000000000000000000"  decimals 18
     *
     * NUMERIC(78, 0) вмещает uint256 целиком. Драйвер pg отдаёт такие
     * значения СТРОКОЙ — и это правильно: в Number надёжны лишь 15-16
     * значащих цифр, всё остальное потерялось бы молча.
     *
     * Никакой арифметики над этим полем в JS без BigInt.
     */
    value: {
      type: DataTypes.DECIMAL(78, 0),
      allowNull: false,
    },

    /**
     * Знаков после запятой у токена. Обязательно хранить ЗДЕСЬ, а не брать
     * из справочника: у TRX и USDT-TRC20 их 6, у ETH 18, у разных токенов
     * по-разному.
     *
     * null означает «неизвестно»: у TronGrid встречается пустой token_info
     * (замерено — до 21% записей на адресах контрактов). В этом случае
     * подставлять 6 или 18 по умолчанию НЕЛЬЗЯ — это тихо исказит сумму.
     * Фронт должен показать сырое значение с пометкой.
     */
    decimals: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    /** Символ токена. null = нативная монета сети (TRX) */
    tokenSymbol: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },

    /** Адрес контракта токена. null = нативная монета */
    tokenContractAddress: {
      /*
       * 80 символов — как у адресов кошельков: контракт токена это тот же
       * адрес. Самый длинный у TON — 66 символов (жетон-мастер в raw-форме).
       */
      type: DataTypes.STRING(80),
      allowNull: true,
    },

    /**
     * Источник и характер перевода. Нужен и для отладки («почему это ребро
     * тут взялось»), и для фильтрации на фронте.
     */
    transferType: {
      type: DataTypes.ENUM('native', 'token', 'internal'),
      allowNull: false,
    },

    /** Номер блока. BIGINT: у Tron уже за 85 миллионов */
    blockNumber: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },

    /**
     * Время блока, UTC.
     *
     * Названо blockTimestamp, а не timestamp, чтобы не путать с createdAt —
     * временем, когда МЫ загрузили запись. Это разные вещи: транзакция
     * могла произойти год назад, а в нашей базе появиться сегодня.
     *
     * Источник — block_timestamp в МИЛЛИСЕКУНДАХ (13 цифр). Многие
     * блокчейн-API отдают секунды; перепутать — получить 1970 год.
     */
    blockTimestamp: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    tableName: 'transactions',
    indexes: [
      // Основной запрос графа:
      //   WHERE network = ? AND (fromAddress = ? OR toAddress = ?)
      //     AND blockTimestamp >= ?
      //
      // Время ВХОДИТ в составной индекс намеренно. Проверено через EXPLAIN:
      // с индексами только по (network, address) планировщик брал индекс по
      // времени и фильтровал адрес ПЕРЕБОРОМ — то есть на большой таблице
      // читал бы всё за 30 дней ради сотни нужных строк.
      //
      // Порядок колонок важен: сначала равенства, потом диапазон. Обратный
      // порядок сделал бы индекс бесполезным для фильтра по адресу.
      { fields: ['network', 'fromAddress', 'blockTimestamp'] },
      { fields: ['network', 'toAddress', 'blockTimestamp'] },

      // Группировка по временным окнам в эвристике дробления —
      // там выборка идёт по времени без привязки к адресу
      { fields: ['blockTimestamp'] },

      // Выборка всех переводов одной транзакции — для панели деталей
      { fields: ['network', 'hash'] },
    ],
  },
);

export default Transaction;
