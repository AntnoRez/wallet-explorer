/**
 * Запросы к нашему API.
 *
 * Абсолютных URL здесь нет: в разработке Vite проксирует /api на
 * localhost:4000, на проде оба будут за одним nginx. Значит и переменной
 * окружения с адресом сервера не нужно.
 */

/**
 * Ошибка запроса с кодом и деталями от сервера.
 *
 * Наш API отвечает на ошибки телом { error, details } — это готовый текст
 * для пользователя, и терять его, превращая всё в «что-то пошло не так»,
 * было бы расточительно.
 */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }

  /** Виноват пользователь (неверный адрес), а не сервер */
  get isUserError() {
    return this.status >= 400 && this.status < 500;
  }

  /** Внешний источник данных недоступен — имеет смысл повторить */
  get isUpstreamError() {
    return this.status === 502 || this.status === 504;
  }
}

/**
 * Выполнить запрос и разобрать ответ.
 *
 * @param {string} path
 * @param {RequestInit & { signal?: AbortSignal }} [options]
 */
async function request(path, options = {}) {
  let response;

  try {
    response = await fetch(path, {
      // Порядок важен: ...options идёт ПЕРВЫМ, иначе он затирает
      // собранный ниже объект headers целиком, и Accept теряется.
      // Поймано тестом: при POST с Content-Type заголовок Accept исчезал.
      ...options,
      headers: { Accept: 'application/json', ...options.headers },
    });
  } catch (error) {
    // Сеть недоступна или запрос отменён. Отмену пробрасываем как есть —
    // вызывающий код должен уметь отличить её от настоящей ошибки
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, 'Сервер недоступен. Проверь, запущен ли backend');
  }

  // 204 и подобные — тела нет, парсить нечего
  if (response.status === 204) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      `Сервер вернул не JSON (${response.status})`,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error ?? `Ошибка ${response.status}`,
      body?.details,
    );
  }

  return body;
}

/**
 * Собрать строку запроса, отбрасывая пустые значения.
 *
 * Важно не отбрасывать 0 и false: days=0 означает «за всё время»,
 * а не «параметр не задан».
 *
 * @param {Record<string, unknown>} params
 */
function query(params) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }

  const string = search.toString();
  return string ? `?${string}` : '';
}

/**
 * Граф переводов адреса.
 *
 * @param {string} network
 * @param {string} address
 * @param {{
 *   days?: number, topNodes?: number, minShare?: number, limit?: number,
 *   refresh?: boolean, loadMore?: boolean, signal?: AbortSignal,
 * }} [options]
 */
export function fetchWallet(network, address, options = {}) {
  const { signal, ...params } = options;

  return request(
    `/api/wallet/${network}/${encodeURIComponent(address)}${query(params)}`,
    { signal },
  );
}

/**
 * Метки адресов: «Binance-Hot 1», теги риска.
 *
 * Отдельным запросом после графа: метка запрашивается на один адрес и
 * занимает до секунды, для двадцати узлов это слишком долго в основном пути.
 *
 * За вызов сервер догружает не больше восьми новых адресов, остальные
 * помечает pending. Поэтому вызывать нужно повторно, пока stats.pending > 0.
 *
 * @param {string} network
 * @param {string[]} addresses
 * @param {{ signal?: AbortSignal }} [options]
 */
export function fetchLabels(network, addresses, { signal } = {}) {
  return request(`/api/labels/${network}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses }),
    signal,
  });
}

/**
 * Плоский список переводов — для таблицы и для панели деталей ребра.
 *
 * @param {string} network
 * @param {string} address
 * @param {{
 *   days?: number, limit?: number,
 *   counterparty?: string, token?: string,
 *   signal?: AbortSignal,
 * }} [options]
 *   counterparty — только переводы с этим адресом, в обе стороны
 *   token        — адрес контракта либо 'native' для монеты сети
 */
export function fetchTransfers(network, address, options = {}) {
  const { signal, ...params } = options;

  return request(
    `/api/wallet/${network}/${encodeURIComponent(address)}/transfers${query(params)}`,
    { signal },
  );
}

/**
 * Баланс отдельно от графа — если понадобится обновить только его.
 *
 * @param {string} network
 * @param {string} address
 * @param {{ refresh?: boolean, signal?: AbortSignal }} [options]
 */
export function fetchBalance(network, address, { refresh, signal } = {}) {
  return request(
    `/api/wallet/${network}/${encodeURIComponent(address)}/balance${query({ refresh })}`,
    { signal },
  );
}

/** Список поддерживаемых сетей — фронт не хранит его у себя */
export function fetchNetworks({ signal } = {}) {
  return request('/api/networks', { signal });
}
