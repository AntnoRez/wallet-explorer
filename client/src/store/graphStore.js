/**
 * Состояние приложения.
 *
 * Главная сложность здесь — НАКОПЛЕНИЕ ГРАФА. Сервер отдаёт граф вокруг
 * одного адреса. Когда пользователь раскрывает узел, приходит второй граф —
 * вокруг него. Их нужно слить, а не заменить: иначе раскрытие теряло бы
 * то, что уже нарисовано, и «раскрыть» превращалось бы в «перейти».
 */

import { create } from 'zustand';
import { fetchWallet, fetchLabels, fetchNetworks, ApiError } from '../api/client.js';
import { pickNetwork } from '../address.js';

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
 * Собрать видимый граф из накопленного.
 *
 * Показываем ровно три вещи:
 *   - закреплённые узлы (скелет расследования),
 *   - текущий узел,
 *   - его соседей (рабочая область).
 *
 * Рёбра берём все, у которых ОБА конца попали в это множество. Отсюда
 * приятное следствие: связь между двумя закреплёнными узлами проявляется
 * сама, как только оба оказались на экране, — даже если мы узнали о них
 * в разное время и из разных запросов.
 *
 * @param {{nodes: Map, edges: Map}} cache всё, что видели
 * @param {Set<string>} pinned закреплённые адреса
 * @param {string|null} focus текущий узел
 * @param {Set<string>} neighbors соседи текущего узла
 */
function buildVisible(cache, pinned, focus, neighbors) {
  const visible = new Set([...pinned, ...neighbors]);
  if (focus) visible.add(focus);

  const nodes = [];
  for (const id of visible) {
    const node = cache.nodes.get(id);
    if (node) nodes.push({ ...node, isCenter: id === focus, isPinned: pinned.has(id) });
  }

  const edges = [];
  for (const edge of cache.edges.values()) {
    if (visible.has(edge.source) && visible.has(edge.target)) edges.push(edge);
  }

  return { nodes, edges };
}

const EMPTY_GRAPH = { nodes: [], edges: [] };

/**
 * Сколько контрагентов показываем при раскрытии узла.
 *
 * Меньше, чем у начального адреса: там важна полнота картины, здесь —
 * возможность идти дальше, не теряя цепочку из виду. Свёрнутые никуда
 * не деваются, их видно узлом «+N».
 */
const NEIGHBOURS_PER_STEP = 10;

const DEFAULT_FILTERS = {
  days: 30,
  topNodes: 20,
  minShare: 0.0001,
};

export const useGraphStore = create((set, get) => ({
  /**
   * Текущая сеть. Не константа: она выбирается по виду введённого адреса,
   * см. loadNetworks() и load().
   */
  network: 'tron',

  /** Справочник сетей с сервера: ключи, символы, шаблоны ссылок */
  networks: [],

  /**
   * Закреплённые адреса — скелет расследования.
   *
   * Они остаются на графе, куда бы ты ни ушёл дальше. Цепочка растёт
   * именно из них: раскрыл узел, закрепил интересный, шагнул дальше.
   */
  pinned: new Set(),

  /**
   * Адрес, с которого началось расследование.
   *
   * От него считаются шаги в раскладке: он слева, дальше по цепочке —
   * правее. Меняется только при вводе адреса руками; переходы по узлам
   * его не сбивают, иначе цепочка каждый раз начиналась бы заново.
   */
  chainStart: null,

  /**
   * Всё, что мы когда-либо видели: узлы и рёбра по идентификаторам.
   *
   * Показываем не всё — иначе через три шага получим кашу, ради которой
   * и затевалось закрепление. Но помним всё: благодаря этому ребро между
   * двумя закреплёнными узлами появляется само, как только оба на экране,
   * даже если увидели мы их в разное время.
   */
  cache: { nodes: new Map(), edges: new Map() },

  /**
   * Соседи текущего узла — рабочая область.
   *
   * Единственное, что исчезает при переходе. Постоянное на графе — только
   * закреплённое, и это делает картинку предсказуемой: сколько бы шагов
   * ты ни сделал, лишнего на экране ровно один слой.
   */
  focusNeighbors: new Set(),

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
  /**
   * Забрать справочник сетей.
   *
   * Нужен до первого запроса: по нему выбирается сеть для адреса и берутся
   * шаблоны ссылок на обозреватель. Без него фронту пришлось бы знать, что
   * у Tronscan путь `/#/transaction/`, а у остальных `/tx/`.
   */
  loadNetworks: async () => {
    if (get().networks.length > 0) return;

    try {
      const { networks, default: fallback } = await fetchNetworks();
      set((state) => ({
        networks,
        // Сеть по умолчанию берём с сервера, но не затираем ту, что
        // пользователь мог уже выбрать вручную
        network: state.network ?? fallback,
      }));
    } catch {
      // Справочник — удобство, а не необходимость: без него работаем
      // с сетью по умолчанию и без ссылок на обозреватель
    }
  },

  /**
   * Закрепить или открепить узел.
   *
   * Закреплённый остаётся на графе при любых переходах — из таких узлов
   * и складывается цепочка расследования. Открепление убирает его сразу,
   * если он не сосед текущего узла.
   *
   * @param {string} address
   */
  togglePin: (address) => {
    if (!address) return;

    set((state) => {
      const pinned = new Set(state.pinned);
      if (pinned.has(address)) pinned.delete(address);
      else pinned.add(address);

      return {
        pinned,
        graph: buildVisible(state.cache, pinned, state.rootAddress, state.focusNeighbors),
      };
    });
  },

  /** Снять все закрепления, оставив только текущий узел с соседями */
  clearPins: () => {
    set((state) => ({
      pinned: new Set(),

  /**
   * Адрес, с которого началось расследование.
   *
   * От него считаются шаги в раскладке: он слева, дальше по цепочке —
   * правее. Меняется только при вводе адреса руками; переходы по узлам
   * его не сбивают, иначе цепочка каждый раз начиналась бы заново.
   */
  chainStart: null,
      graph: buildVisible(state.cache, new Set(), state.rootAddress, state.focusNeighbors),
    }));
  },

  /** Сменить сеть и перестроить граф для того же адреса */
  setNetwork: (key) => {
    if (get().network === key) return;

    // Кэш и закрепления чистим: узлы другой сети к этой не относятся,
    // а адрес 0x… существует во всех EVM-сетях сразу — оставь мы их,
    // на графе смешались бы истории из разных цепей
    set({
      network: key,
      graph: EMPTY_GRAPH,
      selection: null,
      pinned: new Set(),

  /**
   * Адрес, с которого началось расследование.
   *
   * От него считаются шаги в раскладке: он слева, дальше по цепочке —
   * правее. Меняется только при вводе адреса руками; переходы по узлам
   * его не сбивают, иначе цепочка каждый раз начиналась бы заново.
   */
  chainStart: null,
      cache: { nodes: new Map(), edges: new Map() },
      focusNeighbors: new Set(),
    });

    const { rootAddress, load } = get();
    if (rootAddress) load(rootAddress);
  },

  load: async (address, { reset = true, refresh = false, loadMore = false, newChain = false } = {}) => {
    const { filters, networks } = get();

    // Сеть определяется видом адреса: T... — Tron, 0x... — EVM. Если
    // текущая сеть подходит по семейству, остаёмся в ней — пользователь,
    // смотрящий Ethereum, не должен улетать в Polygon при вводе другого
    // адреса EVM
    const network = pickNetwork(address, get().network, networks) ?? get().network;
    if (network !== get().network) set({ network });

    // Ручной ввод адреса начинает расследование заново: прежняя цепочка
    // к новому адресу отношения не имеет
    if (newChain) {
      set({
        chainStart: address,
        // Начало цепочки закрепляем сразу: от него считаются шаги в
        // раскладке, и уйди оно с экрана — считать было бы не от чего.
        // Да и по смыслу точка отсчёта расследования должна быть видна
        pinned: new Set([address]),
        cache: { nodes: new Map(), edges: new Map() },
        focusNeighbors: new Set(),
        history: [],
      });
    }

    set((state) => ({
      status: 'loading',
      error: null,
      // Первый адрес в сессии тоже начинает цепочку
      chainStart: state.chainStart ?? address,
      pinned: state.chainStart ? state.pinned : new Set([address]),
      ...(reset ? { rootAddress: address, selection: null } : {}),
    }));

    try {
      const wallet = await fetchWallet(network, address, {
        ...filters,
        // При раскрытии берём меньше контрагентов, чем для начального
        // адреса: соседи накапливаются с каждым шагом, и полная двадцатка
        // на каждом узле быстро превращает цепочку в кашу
        topNodes: newChain ? filters.topNodes : NEIGHBOURS_PER_STEP,
        refresh,
        loadMore,
      });

      const incoming = scopeGraph(wallet.graph, address);

      set((state) => {
        // Копим ВСЁ увиденное: показываем подмножество, но помним целиком
        const cache = {
          nodes: new Map(state.cache.nodes),
          edges: new Map(state.cache.edges),
        };

        for (const node of incoming.nodes) {
          const known = cache.nodes.get(node.id);
          // Накопительные признаки не отменяем: раскрытость и метка,
          // однажды узнанные, не должны теряться из-за более бедного ответа
          cache.nodes.set(node.id, known ? { ...known, ...node, label: node.label ?? known.label } : node);
        }
        for (const edge of incoming.edges) cache.edges.set(edge.id, edge);

        // Соседи текущего узла — всё, что пришло в этом ответе, кроме
        // его самого. Прошлые соседи при переходе исчезают: на экране
        // всегда ровно один рабочий слой плюс закреплённое
        const neighbors = new Set(
          incoming.nodes.map((node) => node.id).filter((id) => id !== address),
        );

        return {
          wallet,
          cache,
          focusNeighbors: neighbors,
          graph: buildVisible(cache, state.pinned, address, neighbors),
          status: 'ready',
        };
      });

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
      pinned: new Set(),

  /**
   * Адрес, с которого началось расследование.
   *
   * От него считаются шаги в раскладке: он слева, дальше по цепочке —
   * правее. Меняется только при вводе адреса руками; переходы по узлам
   * его не сбивают, иначе цепочка каждый раз начиналась бы заново.
   */
  chainStart: null,
      cache: { nodes: new Map(), edges: new Map() },
      focusNeighbors: new Set(),
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

/**
 * Описание текущей сети: символ монеты, шаблоны ссылок на обозреватель.
 *
 * Отдельный хук, потому что нужен половине компонентов, а собирать его
 * из двух полей стора в каждом — лишний повод ошибиться. Возвращается
 * элемент массива, а не новый объект: иначе Zustand считал бы состояние
 * изменившимся на каждый рендер и уводил бы компонент в цикл.
 */
export const useCurrentNetwork = () =>
  useGraphStore((state) => state.networks.find((network) => network.key === state.network));
