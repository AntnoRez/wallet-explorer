/**
 * Раскладка графа силовой симуляцией.
 *
 * React Flow сам узлы не расставляет — он рисует их по заданным координатам.
 * Координаты считает d3-force: узлы отталкиваются друг от друга, рёбра
 * притягивают связанные, центр удерживает всё вместе. Кластеры проявляются
 * сами, без правил вроде «выстроить по кругу».
 *
 * ГОРИЗОНТАЛЬ — ЭТО ШАГИ РАССЛЕДОВАНИЯ. Начальный адрес слева, его
 * соседи правее, соседи соседей ещё правее. Цепочка читается слева
 * направо, и видно, сколько шагов сделано и где была развилка.
 *
 * Пока цепочки нет (открыт один адрес), шаг у всех одинаковый — и тогда
 * стороны задаёт направление перевода: прислали слева, отправили справа,
 * обмен по вертикали. Так первый экран остаётся наглядным, а при переходе
 * к расследованию раскладка перестраивается сама.
 *
 * Притяжение мягкое, а не жёсткие колонки: силовая раскладка продолжает
 * группировать связанные узлы, и картинка остаётся живой.
 *
 * ГЛАВНАЯ ТОНКОСТЬ — СОХРАНЕНИЕ ПОЗИЦИЙ.
 * При раскрытии узла граф дополняется, и полный пересчёт раскидал бы то,
 * что пользователь уже разглядывает. Поэтому уже размещённые узлы
 * закрепляются, а новые расставляются вокруг них.
 */

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';

/**
 * Насколько далеко разводятся стороны.
 *
 * Это ЦЕЛЬ притяжения, а не координата: узел встанет примерно там, но
 * отталкивание и связи его подвинут. Значение подобрано под длину ребра
 * (190) — стороны заметно разделены, но граф не растягивается в ленту.
 */
const SIDE_SPREAD = 260;

/**
 * Расстояние между шагами цепочки по горизонтали.
 *
 * Больше длины ребра (190): слои должны читаться как отдельные колонки,
 * иначе соседние шаги перемешиваются и смысл раскладки теряется.
 */
const STEP_SPACING = 320;

/**
 * Расстояние в шагах от начала цепочки.
 *
 * Обход в ширину по рёбрам без учёта направления: нас интересует, за
 * сколько переходов узел достижим, а не куда шли деньги. Направление
 * показывают цвет и стрелка ребра.
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {string} startId с какого узла начали
 * @returns {Map<string, number>} узел -> номер шага
 */
export function computeSteps(nodes, edges, startId) {
  const steps = new Map();
  if (!startId) return steps;

  const neighbours = new Map();
  for (const edge of edges) {
    if (!neighbours.has(edge.source)) neighbours.set(edge.source, []);
    if (!neighbours.has(edge.target)) neighbours.set(edge.target, []);
    neighbours.get(edge.source).push(edge.target);
    neighbours.get(edge.target).push(edge.source);
  }

  steps.set(startId, 0);
  let frontier = [startId];

  while (frontier.length > 0) {
    const next = [];

    for (const id of frontier) {
      for (const neighbour of neighbours.get(id) ?? []) {
        if (steps.has(neighbour)) continue;
        steps.set(neighbour, steps.get(id) + 1);
        next.push(neighbour);
      }
    }

    frontier = next;
  }

  // Узлы, до которых не дотянулись рёбра, ставим на шаг начала:
  // иначе они улетели бы в нулевую координату поверх старта
  for (const node of nodes) {
    if (!steps.has(node.id)) steps.set(node.id, 0);
  }

  return steps;
}

/**
 * Определить, с какой стороны от корня стоит каждый узел.
 *
 * Смотрим только связи С КОРНЕМ: граф строится вокруг него, и «входящий»
 * означает «деньги пришли корню», а не «пришли кому-то из соседей».
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {string} rootId идентификатор корневого узла
 * @returns {Map<string, 'in'|'out'|'both'|'none'>}
 */
export function classifyDirections(nodes, edges, rootId) {
  const directions = new Map();

  for (const edge of edges) {
    if (edge.source === rootId && edge.target !== rootId) {
      // Корень отправитель — значит контрагент получатель, он справа
      directions.set(edge.target, directions.get(edge.target) === 'in' ? 'both' : 'out');
    } else if (edge.target === rootId && edge.source !== rootId) {
      directions.set(edge.source, directions.get(edge.source) === 'out' ? 'both' : 'in');
    }
  }

  // Узлы без прямой связи с корнем встречаются после раскрытия: граф
  // дополняется соседями соседей. Их не тянем никуда
  for (const node of nodes) {
    if (!directions.has(node.id)) directions.set(node.id, 'none');
  }

  return directions;
}

/** Радиус узла для расчёта столкновений — с запасом на подпись */
const NODE_RADIUS = 62;

/** Сколько шагов симуляции прогоняем. Больше — стабильнее, но дольше */
const ITERATIONS = 260;

/**
 * Разложить граф.
 *
 * Симуляция считается синхронно, а не анимацией: React Flow перерисовывает
 * узлы на каждом кадре, и шестьдесят перерисовок в секунду на большом графе
 * заметно тормозят. Пользователь всё равно видит только результат.
 *
 * @param {object[]} nodes узлы графа (id, isCenter, weight…)
 * @param {object[]} edges рёбра (source, target)
 * @param {Map<string, {x: number, y: number}>} [pinned] уже размещённые узлы
 * @returns {Map<string, {x: number, y: number}>} координаты по id
 */
export function layoutGraph(nodes, edges, pinned = new Map(), chainStart = null) {
  if (nodes.length === 0) return new Map();

  const centerNode = nodes.find((node) => node.isCenter);
  const directions = classifyDirections(nodes, edges, centerNode?.id);

  // Шаги считаем от начала расследования, а не от текущего узла: цепочка
  // должна расти в одну сторону, а не переворачиваться при каждом переходе
  const startId = chainStart ?? centerNode?.id;
  const steps = computeSteps(nodes, edges, startId);
  const depth = Math.max(0, ...steps.values());

  // Цепочка началась, если мы ушли с начального адреса либо закрепили
  // что-то кроме него.
  //
  // Судить по глубине графа НЕЛЬЗЯ, хотя соблазнительно: у обычного
  // адреса контрагенты нередко связаны между собой, и узел на расстоянии
  // двух шагов находится сразу — раскладка переключалась бы в режим
  // цепочки, когда никакой цепочки нет.
  const pinnedCount = nodes.filter((node) => node.isPinned).length;
  const byChain = Boolean(chainStart) && (centerNode?.id !== chainStart || pinnedCount > 1);

  /** Куда тянуть узел по горизонтали */
  const targetX = (id) =>
    byChain
      ? (steps.get(id) ?? 0) * STEP_SPACING - (depth * STEP_SPACING) / 2
      : sideTargetX(directions.get(id));

  /** Куда тянуть узел по вертикали */
  const targetY = (id) =>
    byChain ? chainTargetY(id) : sideTargetY(directions.get(id), id);

  // d3-force мутирует переданные объекты, поэтому работаем с копиями:
  // иначе он записал бы координаты и скорости прямо в узлы графа
  const simNodes = nodes.map((node) => {
    const previous = pinned.get(node.id);

    return {
      id: node.id,
      isCenter: node.isCenter,
      // Якорь раскладки. В обычном режиме это центральный узел: он точка
      // отсчёта, и его блуждание сбивало бы ориентацию при пересчёте.
      //
      // В режиме цепочки якорем становится ЕЁ НАЧАЛО, а центр отпускаем:
      // прибитый к нулю центр оказывался бы левее своих же соседей по
      // шагу, потому что шаги считаются от начала, а не от него
      ...(byChain
        ? node.id === startId
          ? { fx: targetX(node.id), fy: 0 }
          : {}
        : node.isCenter
          ? { fx: 0, fy: 0 }
          : {}),
      // Уже размещённые остаются на месте: пересчёт не должен раскидывать
      // то, что пользователь уже разглядывает
      ...(previous && !node.isCenter && node.id !== startId
        ? { fx: previous.x, fy: previous.y }
        : {}),
      // Новые стартуют СРАЗУ НА СВОЕЙ СТОРОНЕ. Старт у центра выглядел
      // безобиднее, но заставлял симуляцию протаскивать узел через
      // середину, и слабо связанные иногда застревали не на той половине:
      // замерено 7 промахов на 12 прогонов. Со стартом на месте их нет
      x: previous?.x ?? targetX(node.id) + (Math.random() - 0.5) * 120,
      y: previous?.y ?? targetY(node.id) + (Math.random() - 0.5) * 260,
    };
  });

  const byId = new Map(simNodes.map((node) => [node.id, node]));

  // Рёбра, оба конца которых есть в графе. Ребро на несуществующий узел
  // уронило бы forceLink
  const simLinks = edges
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }));

  const simulation = forceSimulation(simNodes)
    .force(
      'link',
      forceLink(simLinks)
        .id((node) => node.id)
        // Длина ребра одинаковая: расстояние в этом графе ничего не значит,
        // важна только структура связей
        .distance(190)
        .strength(0.35),
    )
    // Отталкивание: без него узлы слипаются в точку
    .force('charge', forceManyBody().strength(-900).distanceMax(900))
    // Запрет наложения кругов с подписями
    .force('collide', forceCollide(NODE_RADIUS).strength(0.9))
    // В режиме цепочки центрирования нет: оно стягивало бы слои обратно
    // в кучу, борясь с разведением по шагам
    .force('center', byChain ? null : forceCenter(0, 0))
    // Стороны: входящие влево, исходящие вправо. Сила больше, чем у
    // прежнего притяжения к центру, иначе связи перетягивают узлы обратно
    // и разделение размывается
    .force('x', forceX((node) => targetX(node.id)).strength(byChain ? 0.35 : 0.12))
    // По вертикали тянем только двусторонние — вверх и вниз попеременно.
    // Остальные держим слабо, чтобы одиночные не улетали
    .force(
      'y',
      forceY((node) => targetY(node.id)).strength((node) =>
        !byChain && directions.get(node.id) === 'both' ? 0.12 : 0.04,
      ),
    )
    .stop();

  simulation.tick(ITERATIONS);

  const positions = new Map();
  for (const node of simNodes) {
    positions.set(node.id, { x: node.x, y: node.y });
  }

  // Если центра нет (пустой граф или странные данные), оставляем как есть
  if (!centerNode) return positions;

  return positions;
}

/**
 * Разброс по вертикали внутри одного шага цепочки.
 *
 * Ставим по хэшу адреса, а не по порядку: порядок меняется между
 * запросами, и узел прыгал бы вверх-вниз при каждом обновлении.
 * Симуляция потом разведёт их отталкиванием, наша задача — не свалить
 * весь слой в одну точку.
 *
 * @param {string} id
 */
function chainTargetY(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;

  // Диапазон примерно в высоту экрана: дальше уводить незачем
  return ((hash % 9) - 4) * 90;
}

/**
 * Куда тянуть узел по горизонтали.
 *
 * @param {'in'|'out'|'both'|'none'} direction
 */
function sideTargetX(direction) {
  if (direction === 'in') return -SIDE_SPREAD;
  if (direction === 'out') return SIDE_SPREAD;
  // Двусторонние и несвязанные — по центру
  return 0;
}

/**
 * Куда тянуть узел по вертикали.
 *
 * Двусторонние распределяем вверх и вниз, чтобы они не сбились в кучу над
 * корнем. Сторона выбирается по хэшу идентификатора, а не по порядку в
 * массиве: порядок меняется между запросами, и узел прыгал бы сверху вниз
 * при каждом обновлении.
 *
 * @param {'in'|'out'|'both'|'none'} direction
 * @param {string} id
 */
function sideTargetY(direction, id) {
  if (direction !== 'both') return 0;

  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;

  return hash % 2 === 0 ? -SIDE_SPREAD : SIDE_SPREAD;
}

/**
 * Собрать карту уже известных позиций из узлов React Flow.
 *
 * @param {object[]} flowNodes
 * @returns {Map<string, {x: number, y: number}>}
 */
export function collectPositions(flowNodes) {
  const positions = new Map();

  for (const node of flowNodes) {
    if (node.position) positions.set(node.id, { x: node.position.x, y: node.position.y });
  }

  return positions;
}
