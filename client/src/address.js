/**
 * Определение семейства сети по виду адреса.
 *
 * ЗАЧЕМ ЭТО НА ФРОНТЕ, ЕСЛИ ЕСТЬ НА СЕРВЕРЕ. Пользователь вставляет адрес
 * и жмёт «Показать» — к этому моменту уже надо знать, в какую сеть идти,
 * иначе первый запрос уйдёт не туда и вернёт ошибку. Спрашивать сервер
 * ради регулярного выражения — лишний круг по сети.
 *
 * Сознательное упрощение: здесь проверяется только ФОРМА записи, без
 * контрольной суммы. Полная проверка остаётся на сервере — он всё равно
 * разбирает адрес заново и отвечает внятной ошибкой. Продублировать
 * base58check и EIP-55 на клиенте значило бы держать две реализации
 * одного правила и следить, чтобы они не разъехались. У Solana проверять
 * и вовсе нечего: контрольной суммы там нет в принципе.
 *
 * ГЛАВНОЕ: по адресу определяется СЕМЕЙСТВО, а не сеть. Адрес EVM
 * выводится из приватного ключа одинаково в Ethereum, Polygon и
 * Arbitrum, поэтому один и тот же 0x… существует во всех этих сетях
 * сразу, с разной историей в каждой. Какую показывать — вопрос выбора,
 * а не распознавания.
 */

/** base58check с префиксом T — так выглядит адрес Tron */
const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** 20 байт в hex — так выглядит адрес любой EVM-сети */
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 32 байта в base58 — адрес Solana.
 *
 * Длина плавает: обычный кошелёк занимает 43–44 символа, но ведущие
 * нулевые байты кодируются единицами и укорачивают запись — у системных
 * адресов бывает 32.
 *
 * С Tron пересекается только на бумаге: тот всегда ровно 34 символа и
 * начинается с T, а 34 символа для 32 байт означали бы девять ведущих
 * нулей подряд. Поэтому Tron проверяем первым и на этом успокаиваемся.
 */
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @param {string} raw адрес из поля ввода
 * @returns {'tron' | 'evm' | 'solana' | null} null — не похоже ни на что
 */
export function detectFamily(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';

  // Порядок важен: Tron проверяем до Solana, потому что его форма —
  // частный случай base58, и общий шаблон поглотил бы её
  if (TRON_RE.test(value)) return 'tron';
  if (EVM_RE.test(value)) return 'evm';
  if (SOLANA_RE.test(value)) return 'solana';

  return null;
}

/**
 * Выбрать сеть для адреса.
 *
 * Если текущая сеть подходит по семейству — остаёмся в ней: пользователь
 * смотрел Ethereum, вставил другой адрес EVM и должен остаться в Ethereum,
 * а не улететь в Polygon. Иначе берём первую сеть подходящего семейства.
 *
 * @param {string} address
 * @param {string} currentNetwork ключ текущей сети
 * @param {Array<{key: string, family: string}>} networks справочник с сервера
 * @returns {string|null} ключ сети, null — адрес не распознан
 */
export function pickNetwork(address, currentNetwork, networks) {
  const family = detectFamily(address);
  if (!family) return null;

  const current = networks.find((network) => network.key === currentNetwork);
  if (current && current.family === family) return current.key;

  return networks.find((network) => network.family === family)?.key ?? null;
}

/**
 * Подставить значение в шаблон ссылки на обозреватель.
 *
 * Шаблоны приходят с сервера в виде `https://polygonscan.com/tx/{hash}`,
 * потому что путь у каждого обозревателя свой: у Tronscan это
 * `/#/transaction/`, у остальных `/tx/`.
 *
 * @param {string|undefined} template
 * @param {Record<string, string>} values
 * @returns {string|null} null — шаблона нет, ссылку показывать не надо
 */
export function explorerLink(template, values) {
  if (!template) return null;

  return Object.entries(values).reduce(
    (link, [key, value]) => link.replace(`{${key}}`, encodeURIComponent(value)),
    template,
  );
}
