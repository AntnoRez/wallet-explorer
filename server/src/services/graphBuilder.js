/**
 * Превращение списка переводов в граф: узлы и рёбра.
 *
 * Четыре механизма, каждый решает свою часть проблемы читаемости:
 *
 *   1. АГРЕГАЦИЯ РЁБЕР. Пятнадцать переводов между A и B — одно ребро
 *      с суммой, счётчиком и периодом, а не пятнадцать линий.
 *
 *   2. TOP-N + ГРУППИРОВКА. Показываем N самых значимых контрагентов,
 *      остальных сворачиваем в один узел «+880 адресов». Экран физически
 *      не вмещает 900 узлов читаемо.
 *
 *   3. ПОРОГ ЗНАЧИМОСТИ. Пыль, комиссии и тестовые переводы создают
 *      основную визуальную грязь, а не осмысленные движения.
 *
 *   4. ВРЕМЕННОЕ ОКНО. Применяется раньше, при чтении из БД (GRAPH_DAYS).
 *
 * КАК СРАВНИВАЕМ ЗНАЧИМОСТЬ РАЗНЫХ ТОКЕНОВ.
 * Складывать 100 USDT и 100 TRX нельзя, курсов у нас нет. Поэтому значимость
 * перевода — это ДОЛЯ от общего объёма СВОЕГО токена в текущей выборке.
 * Доли безразмерны и складываются: контрагент, забравший 30% всего USDT и
 * 10% всего TRX, весит 0.4. Порог «0.01% объёма» тогда работает одинаково
 * для любого токена.
 *
 * Суммы складываются через BigInt: значения в минимальных единицах легко
 * выходят за пределы точности Number.
 */

/** Сколько контрагентов показываем поимённо */
const DEFAULT_TOP_NODES = 20;

/**
 * Минимальная доля от объёма токена, ниже которой перевод считается шумом.
 * 0.0001 = 0.01% — порог из практики: отсекает пыль, но не трогает
 * осмысленные переводы.
 */
const DEFAULT_MIN_SHARE = 0.0001;

/** Идентификатор сводного узла */
export const OTHERS_NODE_ID = '__others__';

/**
 * Короткая запись адреса для подписи узла: TWS1on…Hh7PV
 * @param {string} address
 */
export function shortenAddress(address) {
  if (!address || address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}

/**
 * Ключ ребра. Направление имеет значение: A→B и B→A — разные рёбра,
 * иначе потерялось бы, кто кому платил. Токен тоже: 100 USDT и 100 TRX
 * между одной парой складывать нельзя.
 */
function edgeKey(from, to, tokenKey) {
  return `${from}|${to}|${tokenKey}`;
}

/**
 * Чем считать «тот же токен».
 *
 * Приоритет у адреса контракта: он уникален, а символ подделывается —
 * выпустить свой токен с названием USDT может кто угодно.
 */
function tokenKeyOf(transfer) {
  return transfer.tokenContractAddress ?? transfer.tokenSymbol ?? 'native';
}

/**
 * Отформатировать сумму для подписи ребра.
 * @param {string} value минимальные единицы
 * @param {number|null} decimals
 */
function formatAmount(value, decimals) {
  if (decimals == null) return value; // точность неизвестна — показываем сырое

  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const fraction = decimals > 0 ? padded.slice(padded.length - decimals) : '';

  // Показываем максимум два знака после запятой: подпись на ребре,
  // а не бухгалтерский документ
  const shortFraction = fraction.slice(0, 2).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  return `${negative ? '-' : ''}${grouped}${shortFraction ? `.${shortFraction}` : ''}`;
}

/**
 * Доля BigInt-величины от целого, как обычное число.
 * Считаем через промежуточное умножение — прямое деление BigInt отбросило бы
 * дробную часть.
 */
function shareOf(value, total) {
  if (total === 0n) return 0;
  return Number((value * 1_000_000n) / total) / 1_000_000;
}

/**
 * Построить граф.
 *
 * @param {object[]} transfers переводы из БД
 * @param {string} centerAddress адрес, вокруг которого строим
 * @param {Map<string, object>} [meta] пометки адресов из таблицы addresses
 * @param {{ topNodes?: number, minShare?: number }} [options]
 *   topNodes — сколько контрагентов показать поимённо (0 = все)
 *   minShare — порог значимости, доля от объёма токена (0 = не фильтровать)
 * @returns {{ nodes: object[], edges: object[], stats: object }}
 */
export function buildGraph(transfers, centerAddress, meta = new Map(), options = {}) {
  const topNodes = options.topNodes ?? DEFAULT_TOP_NODES;
  const minShare = options.minShare ?? DEFAULT_MIN_SHARE;

  // ── 1. Агрегируем переводы в рёбра ────────────────────────────────────
  const { edges, tokenTotals } = aggregateEdges(transfers);

  // ── 2. Считаем значимость и отсекаем шум ──────────────────────────────
  //
  // Доля внутри токена сама по себе обманчива: NFT-спам с единственным
  // переводом даёт долю 1.0 и вытесняет из топа настоящие движения USDT.
  // Поэтому домножаем на распространённость токена — какую часть всех
  // переводов выборки он составляет.
  //
  //   NFT:  доля 1.0    × 1/978   = 0.001
  //   USDT: доля 0.115  × 670/978 = 0.079   <- выше, и это правильно
  const tokenWeights = tokenSpread(transfers);

  for (const edge of edges.values()) {
    edge.share = shareOf(BigInt(edge.totalValue), tokenTotals.get(edge.tokenKey) ?? 0n);
    edge.weightedShare = edge.share * (tokenWeights.get(edge.tokenKey) ?? 0);
  }

  const significant = [];
  let noiseEdges = 0;
  let noiseTransfers = 0;

  for (const edge of edges.values()) {
    if (minShare > 0 && edge.share < minShare) {
      noiseEdges += 1;
      noiseTransfers += edge.transferCount;
      continue;
    }
    significant.push(edge);
  }

  // ── 3. Ранжируем контрагентов ─────────────────────────────────────────
  const weights = rankCounterparties(significant, centerAddress);

  const ranked = [...weights.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const hidden = new Set();

  ranked.forEach(([address], index) => {
    if (topNodes > 0 && index >= topNodes) hidden.add(address);
  });

  // ── 4. Собираем узлы и рёбра, сворачивая скрытых в сводный узел ───────
  const nodes = new Map();
  const resultEdges = [];
  /** @type {Map<string, any>} */
  const othersEdges = new Map();

  for (const edge of significant) {
    const sourceHidden = hidden.has(edge.source);
    const targetHidden = hidden.has(edge.target);

    if (!sourceHidden && !targetHidden) {
      ensureNode(nodes, edge.source, centerAddress, meta);
      ensureNode(nodes, edge.target, centerAddress, meta);
      resultEdges.push(finalizeEdge(edge));
      continue;
    }

    // Ребро упирается в скрытый адрес — переносим его на сводный узел
    const source = sourceHidden ? OTHERS_NODE_ID : edge.source;
    const target = targetHidden ? OTHERS_NODE_ID : edge.target;

    // Связь между двумя скрытыми адресами графу ничего не сообщает
    if (source === OTHERS_NODE_ID && target === OTHERS_NODE_ID) continue;

    mergeIntoOthers(othersEdges, edge, source, target);
    ensureNode(nodes, source === OTHERS_NODE_ID ? edge.target : edge.source, centerAddress, meta);
  }

  if (hidden.size > 0) {
    nodes.set(OTHERS_NODE_ID, {
      id: OTHERS_NODE_ID,
      label: `+${hidden.size} ${pluralAddresses(hidden.size)}`,
      address: null,
      isCenter: false,
      isExpanded: false,
      isSuspicious: false,
      suspicionReason: null,
      // Признак для фронта: по клику раскрыть следующую порцию
      isGroup: true,
      groupSize: hidden.size,
      totals: {},
      transferCount: 0,
    });

    for (const edge of othersEdges.values()) {
      resultEdges.push(finalizeEdge(edge));
    }
  }

  // Центральный узел должен присутствовать, даже если переводов нет
  ensureNode(nodes, centerAddress, centerAddress, meta);

  // ── 5. Обороты узлов считаем по ВИДИМЫМ рёбрам ────────────────────────
  applyTotals(nodes, resultEdges);

  const nodeList = [...nodes.values()];

  return {
    nodes: nodeList,
    edges: resultEdges,
    stats: {
      nodeCount: nodeList.length,
      edgeCount: resultEdges.length,
      transferCount: transfers.length,
      // Сколько контрагентов свёрнуто в сводный узел
      hiddenNodeCount: hidden.size,
      // Что отсеял порог значимости
      noiseEdges,
      noiseTransfers,
      // Сколько переводов скрыто за одним ребром. Считаем по ПОКАЗАННЫМ
      // переводам: отсеянные шумом в граф не попали, и включать их сюда
      // значило бы завышать сжатие.
      compression:
        resultEdges.length > 0
          ? Number(
              (
                resultEdges.reduce((sum, edge) => sum + edge.transferCount, 0) /
                resultEdges.length
              ).toFixed(2),
            )
          : 0,
      tokens: countTokens(transfers),
      period: periodOf(transfers),
      applied: { topNodes, minShare },
    },
  };
}

/**
 * Схлопнуть переводы в рёбра и посчитать общий объём по каждому токену.
 * @param {object[]} transfers
 */
function aggregateEdges(transfers) {
  /** @type {Map<string, any>} */
  const edges = new Map();
  /** @type {Map<string, bigint>} */
  const tokenTotals = new Map();

  for (const transfer of transfers) {
    const from = transfer.fromAddress;
    const to = transfer.toAddress;

    // Перевод без получателя (деплой контракта) ребром не является
    if (!from || !to) continue;

    const tokenKey = tokenKeyOf(transfer);
    const value = BigInt(transfer.value ?? '0');
    const timestamp = new Date(transfer.blockTimestamp);

    tokenTotals.set(tokenKey, (tokenTotals.get(tokenKey) ?? 0n) + value);

    const key = edgeKey(from, to, tokenKey);
    const existing = edges.get(key);

    if (!existing) {
      edges.set(key, {
        id: key,
        source: from,
        target: to,
        tokenKey,
        tokenSymbol: transfer.tokenSymbol,
        tokenContractAddress: transfer.tokenContractAddress,
        decimals: transfer.decimals,
        totalValue: value.toString(),
        transferCount: 1,
        firstAt: timestamp,
        lastAt: timestamp,
        transferTypes: [transfer.transferType],
        // Все хэши не храним: между парой адресов их бывают сотни,
        // панель деталей покажет десяток, остальное подтянется запросом
        sampleHashes: [transfer.hash],
      });
      continue;
    }

    existing.totalValue = (BigInt(existing.totalValue) + value).toString();
    existing.transferCount += 1;
    if (timestamp < existing.firstAt) existing.firstAt = timestamp;
    if (timestamp > existing.lastAt) existing.lastAt = timestamp;

    if (!existing.transferTypes.includes(transfer.transferType)) {
      existing.transferTypes.push(transfer.transferType);
    }
    if (existing.sampleHashes.length < 10 && !existing.sampleHashes.includes(transfer.hash)) {
      existing.sampleHashes.push(transfer.hash);
    }
    // decimals могли быть неизвестны в первой записи, но известны в другой
    if (existing.decimals == null && transfer.decimals != null) {
      existing.decimals = transfer.decimals;
      existing.tokenSymbol = existing.tokenSymbol ?? transfer.tokenSymbol;
    }
  }

  return { edges, tokenTotals };
}

/**
 * Вес каждого контрагента — сумма долей его рёбер с центром.
 *
 * Доли безразмерны, поэтому USDT и TRX складываются осмысленно:
 * «забрал 30% всего USDT и 10% всего TRX» весит 0.4.
 *
 * @param {object[]} edges
 * @param {string} centerAddress
 */
function rankCounterparties(edges, centerAddress) {
  /** @type {Map<string, { weight: number, transfers: number }>} */
  const weights = new Map();

  const bump = (address, edge) => {
    if (address === centerAddress) return;
    const current = weights.get(address) ?? { weight: 0, transfers: 0 };
    current.weight += edge.weightedShare ?? edge.share;
    current.transfers += edge.transferCount;
    weights.set(address, current);
  };

  for (const edge of edges) {
    bump(edge.source, edge);
    bump(edge.target, edge);
  }

  return weights;
}

/**
 * Слить ребро в сводное — к узлу «остальные».
 */
function mergeIntoOthers(othersEdges, edge, source, target) {
  const key = edgeKey(source, target, edge.tokenKey);
  const existing = othersEdges.get(key);

  if (!existing) {
    othersEdges.set(key, {
      ...edge,
      id: key,
      source,
      target,
      // Хэши сводного ребра ведут в разные транзакции разных адресов —
      // как примеры годятся, как список «всех переводов» нет
      sampleHashes: edge.sampleHashes.slice(0, 3),
      isAggregated: true,
      mergedAddresses: 1,
    });
    return;
  }

  existing.totalValue = (BigInt(existing.totalValue) + BigInt(edge.totalValue)).toString();
  existing.transferCount += edge.transferCount;
  existing.mergedAddresses += 1;
  if (edge.firstAt < existing.firstAt) existing.firstAt = edge.firstAt;
  if (edge.lastAt > existing.lastAt) existing.lastAt = edge.lastAt;
  if (existing.sampleHashes.length < 10) {
    existing.sampleHashes.push(...edge.sampleHashes.slice(0, 2));
  }
  if (existing.decimals == null && edge.decimals != null) existing.decimals = edge.decimals;
}

/**
 * Добавить ребру подпись и вес для толщины линии.
 */
function finalizeEdge(edge) {
  const amount = formatAmount(edge.totalValue, edge.decimals);
  const symbol = edge.tokenSymbol ?? '';
  const countPart =
    edge.transferCount > 1 ? `${edge.transferCount} ${pluralTransfers(edge.transferCount)} · ` : '';

  return {
    ...edge,
    label: `${countPart}${amount}${symbol ? ` ${symbol}` : ''}`.trim(),
    // Толщина линии на фронте. Берём ВЗВЕШЕННУЮ долю — ту же величину, по
    // которой ранжируются контрагенты. Иначе NFT-спам с единственным
    // переводом рисовался бы самой толстой линией, находясь при этом внизу
    // ранга: визуальное противоречие.
    weight: edge.weightedShare ?? edge.share ?? 0,
    // Доля внутри своего токена — полезна в подсказке: «12% всего USDT»
    tokenShare: edge.share ?? 0,
  };
}

/**
 * Завести узел, если ещё не заведён.
 */
function ensureNode(nodes, address, centerAddress, meta) {
  if (!address || nodes.has(address)) return nodes.get(address);

  const info = meta.get(address);
  const node = {
    id: address,
    label: info?.label ?? shortenAddress(address),
    address,
    isCenter: address === centerAddress,
    // Раскрыт ли узел: выкачивали ли мы его целиком. Без этого признака
    // не отличить «у адреса две связи» от «мы видели две его связи»
    isExpanded: info?.fetched ?? false,
    isSuspicious: info?.isSuspicious ?? false,
    suspicionReason: info?.suspicionReason ?? null,
    isGroup: false,
    totals: {},
    transferCount: 0,
  };

  nodes.set(address, node);
  return node;
}

/**
 * Посчитать обороты узлов по итоговым рёбрам.
 *
 * Считаем ПОСЛЕ отбора, а не во время агрегации: иначе в оборотах учитывались
 * бы отсеянные шумовые переводы, и цифры не сходились бы с нарисованным.
 */
function applyTotals(nodes, edges) {
  const add = (address, tokenKey, direction, edge) => {
    const node = nodes.get(address);
    if (!node) return;

    if (!node.totals[tokenKey]) {
      node.totals[tokenKey] = {
        symbol: edge.tokenSymbol,
        decimals: edge.decimals,
        contractAddress: edge.tokenContractAddress,
        in: '0',
        out: '0',
      };
    }

    const totals = node.totals[tokenKey];
    totals[direction] = (BigInt(totals[direction]) + BigInt(edge.totalValue)).toString();
    node.transferCount += edge.transferCount;
  };

  for (const edge of edges) {
    add(edge.source, edge.tokenKey, 'out', edge);
    add(edge.target, edge.tokenKey, 'in', edge);
  }
}

/**
 * Какую часть всех переводов выборки составляет каждый токен.
 *
 * Нужно, чтобы редкий токен не получал преимущество: доля внутри токена у
 * единственного перевода всегда равна 1.0, и без этой поправки NFT-спам
 * вытеснял бы из топа реальные движения USDT.
 *
 * @param {object[]} transfers
 * @returns {Map<string, number>}
 */
function tokenSpread(transfers) {
  const counts = new Map();
  let total = 0;

  for (const transfer of transfers) {
    if (!transfer.fromAddress || !transfer.toAddress) continue;
    const key = tokenKeyOf(transfer);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }

  const spread = new Map();
  for (const [key, count] of counts) {
    spread.set(key, total > 0 ? count / total : 0);
  }
  return spread;
}

/** Согласование числительного: 1 перевод, 2 перевода, 5 переводов */
function pluralTransfers(count) {
  const lastTwo = count % 100;
  const last = count % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return 'переводов';
  if (last === 1) return 'перевод';
  if (last >= 2 && last <= 4) return 'перевода';
  return 'переводов';
}

/** Согласование числительного: 1 адрес, 2 адреса, 5 адресов */
function pluralAddresses(count) {
  const lastTwo = count % 100;
  const last = count % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return 'адресов';
  if (last === 1) return 'адрес';
  if (last >= 2 && last <= 4) return 'адреса';
  return 'адресов';
}

/**
 * Сколько переводов по каждому токену.
 * @param {object[]} transfers
 */
function countTokens(transfers) {
  const counts = new Map();

  for (const transfer of transfers) {
    const symbol = transfer.tokenSymbol ?? 'неизвестный токен';
    counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Период, покрытый переводами.
 * @param {object[]} transfers
 */
function periodOf(transfers) {
  if (transfers.length === 0) return { from: null, to: null };

  let from = new Date(transfers[0].blockTimestamp);
  let to = from;

  for (const transfer of transfers) {
    const timestamp = new Date(transfer.blockTimestamp);
    if (timestamp < from) from = timestamp;
    if (timestamp > to) to = timestamp;
  }

  return { from, to };
}

export const __testing = {
  edgeKey,
  tokenKeyOf,
  countTokens,
  periodOf,
  formatAmount,
  shareOf,
  rankCounterparties,
  pluralAddresses,
  pluralTransfers,
  tokenSpread,
};
