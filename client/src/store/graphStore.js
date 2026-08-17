/**
 * Состояние приложения.
 *
 * Главная сложность здесь — НАКОПЛЕНИЕ ГРАФА. Сервер отдаёт граф вокруг
 * одного адреса. Когда пользователь раскрывает узел, приходит второй граф —
 * вокруг него. Их нужно слить, а не заменить: иначе раскрытие теряло бы
 * то, что уже нарисовано, и «раскрыть» превращалось бы в «перейти».
 */

import { create } from 'zustand';
import { fetchWallet, fetchLabels, ApiError } from '../api/client.js';

/** Префикс сводного узла «+N адресов» */
const OTHERS_PREFIX = '__others__';

/**
 * Сделать id сводного узла уникальным для его центра.
 *
 * Сервер называет сводный узел одинаково — `__others__` — для любого адреса.
 * При раскрытии второго узла его группа затёрла бы первую, и рёбра
 * перемешались бы между разными «остальными». Привязываем к центру.
 */
function scopeOthersId(id, centerAddress) {
  return id === OTHERS_PREFIX ? `${OTHERS_PREFIX}|${centerAddress}` : id;
}

/**
 * Привести граф от сервера к виду, пригодному для слияния.
 *
 * @param {object} graph
 * @param {string} centerAddress
 */
function scopeGraph(graph, centerAddress) {
  const nodes = graph.nodes.map((node) => ({
    ...node,
    id: scopeOthersId(node.id, centerAddress),
    // Запоминаем, вокруг какого адреса появился сводный узел, — иначе по
    // клику непонятно, чьих «остальных» раскрывать
    ...(node.isGroup ? { groupOwner: centerAddress } : {}),
  }));

  const edges = graph.edges.map((edge) => {
    const source = scopeOthersId(edge.source, centerAddress);
    const target = scopeOthersId(edge.target, centerAddress);
    return { ...edge, source, target, id: `${source}|${target}|${edge.tokenKey ?? ''}` };
  });

  return { nodes, edges };
}

/**
 * Слить новый граф с уже накопленным.
 *
 * Правила:
 *   - узлы объединяются по id; уже раскрытый узел не «схлопывается»
 *     обратно в нераскрытый, если новый граф о нём меньше знает;
 *   - рёбра объединяются по id, новые данные побеждают — они свежее;
 *   - позиции сохраняются: пересчёт раскладки не должен раскидывать то,
 *     что пользователь уже разглядывает.
 */
function mergeGraph(previous, incoming) {
  const nodes = new Map(previous.nodes.map((node) => [node.id, node]));

  for (const node of incoming.nodes) {
    const existing = nodes.get(node.id);

    if (!existing) {
      nodes.set(node.id, node);
      continue;
    }

    nodes.set(node.id, {
      ...existing,
      ...node,
      // Раскрытость и метка — накопительные признаки: если мы когда-то
      // узнали их, новый граф не должен их отменять
      isExpanded: existing.isExpanded || node.isExpanded,
      label: node.label ?? existing.label,
      isCenter: existing.isCenter || node.isCenter,
      // Позиция считается раскладкой отдельно и здесь не трогается
      position: existing.position,
    });
  }

  const edges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  for (const edge of incoming.edges) edges.set(edge.id, edge);

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

const EMPTY_GRAPH = { nodes: [], edges: [] };

const DEFAULT_FILTERS = {
  days: 30,
  topNodes: 20,
  minShare: 0.0001,
};

export const useGraphStore = create((set, get) => ({
  network: 'tron',

  /** Адрес в центре графа */
  rootAddress: null,

  /**
   * Адреса, через которые прошли.
   *
   * Раскрытие узла — это ПЕРЕХОД: старый граф пропадает, новый строится
   * вокруг выбранного адреса. Так картинка всегда остаётся читаемой, но без
   * истории пользователь не может вернуться туда, откуда пришёл.
   */
  history: [],

  graph: EMPTY_GRAPH,

  /** Ответ сервера по корневому адресу: баланс, статистика, состояние загрузки */
  wallet: null,

  /** address -> { label, tags, isSuspicious } */
  labels: {},

  filters: DEFAULT_FILTERS,

  /** Что выбрано в графе: { type: 'node'|'edge', id } */
  selection: null,

  /** 'graph' | 'table' */
  view: 'graph',

  status: 'idle', // idle | loading | ready | error
  error: null,

  /** Адреса, которые сейчас догружаются — для индикатора на узле */
  expanding: new Set(),

  /* ─────────────────────────── Действия ─────────────────────────── */

  setView: (view) => set({ view }),

  setFilters: (patch) => {
    set((state) => ({ filters: { ...state.filters, ...patch } }));
    const { rootAddress } = get();
    // Фильтры меняют выборку на сервере — перезапрашиваем корневой адрес.
    // Накопленное при раскрытии сбрасываем: иначе в графе останутся узлы,
    // не проходящие новый фильтр, и картинка перестанет соответствовать
    // подписи «top-20 за 30 дней»
    if (rootAddress) get().load(rootAddress, { reset: true });
  },

  select: (selection) => set({ selection }),

  clearSelection: () => set({ selection: null }),

  /**
   * Загрузить адрес.
   *
   * @param {string} address
   * @param {{ reset?: boolean, refresh?: boolean, loadMore?: boolean }} [options]
   *   reset    — начать новый граф, а не дополнять текущий
   *   refresh  — игнорировать кэш на сервере
   *   loadMore — догрузить более старые переводы
   */
  load: async (address, { reset = true, refresh = false, loadMore = false } = {}) => {
    const { network, filters } = get();

    set({
      status: 'loading',
      error: null,
      ...(reset ? { rootAddress: address, graph: EMPTY_GRAPH, selection: null } : {}),
    });

    try {
      const wallet = await fetchWallet(network, address, {
        ...filters,
        refresh,
        loadMore,
      });

      const incoming = scopeGraph(wallet.graph, address);

      set((state) => ({
        wallet,
        graph: reset ? incoming : mergeGraph(state.graph, incoming),
        status: 'ready',
      }));

      // Метки — отдельным запросом, граф уже показан
      get().loadLabels();
    } catch (error) {
      if (error.name === 'AbortError') return;

      set({
        status: 'error',
        error:
          error instanceof ApiError
            ? { message: error.message, isUserError: error.isUserError, details: error.details }
            : { message: 'Не удалось загрузить данные', isUserError: false },
      });
    }
  },

  /**
   * Перейти к адресу: он становится центром, прежний граф уступает место.
   *
   * Не «дополнить», а именно перейти. Накопление быстро превращает граф
   * в кашу: каждый адрес приносит два десятка контрагентов, и после трёх
   * раскрытий разобрать связи невозможно. Переход держит на экране один
   * понятный слой, а вернуться назад позволяет история.
   *
   * @param {string} address
   */
  expandNode: async (address) => {
    const { expanding, rootAddress } = get();
    if (expanding.has(address) || address === rootAddress) return;

    set((state) => ({
      expanding: new Set(state.expanding).add(address),
      // Текущий адрес уходит в историю ДО загрузки: если загрузка упадёт,
      // пользователь всё равно сможет вернуться
      history: rootAddress ? [...state.history, rootAddress] : state.history,
    }));

    try {
      await get().load(address, { reset: true });
    } finally {
      set((state) => {
        const next = new Set(state.expanding);
        next.delete(address);
        return { expanding: next };
      });
    }
  },

  /**
   * Раскрыть сводный узел «+N адресов».
   *
   * Свёрнутые контрагенты не пропали из данных — они просто не попали в
   * top-N по обороту. Значит «раскрыть группу» означает увеличить N и
   * перезапросить граф: сервер отберёт больше узлов поимённо.
   *
   * Шаг удваивает текущее значение, но не больше потолка: интерфейс не
   * должен позволять запросить граф, который не отрисуется.
   */
  expandGroup: async () => {
    const { filters } = get();
    const next = Math.min(filters.topNodes * 2, 200);

    if (next === filters.topNodes) return;
    get().setFilters({ topNodes: next });
  },

  /** Вернуться к предыдущему адресу */
  goBack: async () => {
    const { history } = get();
    if (history.length === 0) return;

    const previous = history[history.length - 1];
    set((state) => ({ history: state.history.slice(0, -1) }));

    // Загружаем напрямую, а не через expandNode: тот снова положил бы
    // текущий адрес в историю, и «назад» зациклилось бы между двумя точками
    await get().load(previous, { reset: true });
  },

  /** Догрузить более старые переводы корневого адреса */
  loadMore: async () => {
    const { rootAddress } = get();
    if (rootAddress) await get().load(rootAddress, { reset: false, loadMore: true });
  },

  /** Обновить, игнорируя кэш сервера */
  refresh: async () => {
    const { rootAddress } = get();
    if (rootAddress) await get().load(rootAddress, { reset: true, refresh: true });
  },

  /**
   * Подтянуть метки для узлов графа.
   *
   * Сервер отдаёт не больше восьми новых адресов за вызов — остальные
   * помечает pending. Поэтому повторяем, пока есть что догружать, но с
   * ограничением: иначе на большом графе цикл затянется на минуты.
   */
  loadLabels: async (rounds = 3) => {
    const { network, graph } = get();

    const addresses = graph.nodes
      .filter((node) => node.address && !node.isGroup)
      .map((node) => node.address);

    if (addresses.length === 0) return;

    // Копим результаты всех раундов и обновляем состояние ОДИН раз.
    //
    // Обновление после каждого раунда дёргало граф: React Flow заново
    // пересоздавал узлы, не успевал их измерить и держал в
    // visibility: hidden, а рёбра при этом не находили свои узлы и
    // пропадали целиком. На адресах, чьи метки уже лежали в кэше, всё
    // работало — оттого баг и выглядел случайным.
    const collected = {};

    for (let round = 0; round < rounds; round += 1) {
      let response;
      try {
        response = await fetchLabels(network, addresses);
      } catch {
        // Метки — уточнение поверх готового графа. Не получилось —
        // узлы останутся подписаны сокращёнными адресами
        break;
      }

      Object.assign(collected, response.labels);
      if (!response.stats?.pending) break;
    }

    if (Object.keys(collected).length > 0) {
      set((state) => ({ labels: { ...state.labels, ...collected } }));
    }
  },

  reset: () =>
    set({
      rootAddress: null,
      history: [],
      graph: EMPTY_GRAPH,
      wallet: null,
      labels: {},
      selection: null,
      status: 'idle',
      error: null,
    }),
}));

/* ──────────────────────────── Селекторы ──────────────────────────── */

/**
 * Приклеить метки к узлам.
 *
 * ЭТО НЕ СЕЛЕКТОР ZUSTAND, а обычная функция — и это принципиально.
 *
 * Zustand v5 построен на useSyncExternalStore, который сравнивает результат
 * подписки ПО ССЫЛКЕ. Функция вроде этой создаёт новый массив при каждом
 * вызове, поэтому в роли селектора она даёт бесконечный цикл перерисовок:
 *
 *   "The result of getSnapshot should be cached to avoid an infinite loop"
 *   "Maximum update depth exceeded"
 *
 * Поймано ровно так — граф не отрисовался вовсе. Правильный способ:
 * подписаться на graph.nodes и labels по отдельности (их ссылки меняются
 * только при реальном изменении), а склейку делать в useMemo компонента.
 *
 * @param {object[]} nodes
 * @param {Record<string, object>} labels
 */
export function withLabels(nodes, labels) {
  return nodes.map((node) => {
    const info = node.address ? labels[node.address] : null;
    if (!info) return node;

    return {
      ...node,
      label: info.label ?? node.label,
      publicLabel: info.label ?? null,
      tags: info.tags ?? null,
      isSuspicious: info.isSuspicious ?? node.isSuspicious,
      suspicionReason: info.suspicionReason ?? node.suspicionReason,
    };
  });
}

/**
 * Найти выбранный узел или ребро.
 *
 * Тоже НЕ селектор Zustand по той же причине: возвращает новый объект.
 * Вызывать из useMemo компонента.
 *
 * @param {{selection: object|null, graph: object}} state
 */
export function findSelected(selection, graph) {
  if (!selection) return null;

  if (selection.type === 'node') {
    const node = graph.nodes.find((item) => item.id === selection.id);
    return node ? { type: 'node', node } : null;
  }

  const edge = graph.edges.find((item) => item.id === selection.id);
  return edge ? { type: 'edge', edge } : null;
}
