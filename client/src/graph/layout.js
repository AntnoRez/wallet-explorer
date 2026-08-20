/**
 * Раскладка графа силовой симуляцией.
 *
 * React Flow сам узлы не расставляет — он рисует их по заданным координатам.
 * Координаты считает d3-force: узлы отталкиваются друг от друга, рёбра
 * притягивают связанные, центр удерживает всё вместе. Кластеры проявляются
 * сами, без правил вроде «выстроить по кругу».
 *
 * СТОРОНЫ СЧИТАЮТСЯ ОТ ТЕКУЩЕГО УЗЛА, А НЕ ОТ НАЧАЛА КООРДИНАТ.
 * Прислали — слева от него, отправили — справа, обмен сверху и снизу.
 * Закреплённые при этом не двигаются: они уже стоят там, где их поставила
 * прошлая раскладка или рука пользователя.
 *
 * Отсюда цепочка выстраивается сама: идёшь по расходам — каждый шаг уходит
 * правее, идёшь по поступлениям — левее. Отдельная раскладка «по слоям»
 * для этого не нужна, а вместе со сторонами она боролась бы за одну ось.
 *
 * Наложений избегает отталкивание: у закреплённых координаты жёсткие,
 * поэтому расталкиваются вокруг них именно новые узлы.
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

/** Начало координат — запасной якорь, когда центра ещё нет на графе */
const ORIGIN = { x: 0, y: 0 };

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
 * @param {Map<string, {x: number, y: number}>} [manual] позиции, заданные рукой
 * @returns {Map<string, {x: number, y: number}>} координаты по id
 */
export function layoutGraph(nodes, edges, pinned = new Map(), manual = new Map()) {
  if (nodes.length === 0) return new Map();

  const centerNode = nodes.find((node) => node.isCenter);
  const directions = classifyDirections(nodes, edges, centerNode?.id);

  // Откуда отсчитываем стороны. Текущий узел почти всегда уже стоит на
  // графе — он был соседом до того, как его раскрыли, — и остаётся на
  // месте. Соседи расходятся влево и вправо ОТ НЕГО, а не от нуля: иначе
  // новый слой лёг бы поверх уже расставленной цепочки
  const anchor =
    (centerNode && (manual.get(centerNode.id) ?? pinned.get(centerNode.id))) ?? ORIGIN;

  /** Куда тянуть узел по горизонтали */
  const targetX = (id) => anchor.x + sideTargetX(directions.get(id));

  /** Куда тянуть узел по вертикали */
  const targetY = (id) => anchor.y + sideTargetY(directions.get(id), id);

  // d3-force мутирует переданные объекты, поэтому работаем с копиями:
  // иначе он записал бы координаты и скорости прямо в узлы графа
  const simNodes = nodes.map((node) => {
    const previous = pinned.get(node.id);
    const placed = manual.get(node.id);

    // Поставленное рукой не двигаем НИКОГДА — даже центр и начало
    // цепочки. Пользователь, расставивший узлы, знает о своей картине
    // больше, чем симуляция
    if (placed) {
      return { id: node.id, isCenter: node.isCenter, fx: placed.x, fy: placed.y, x: placed.x, y: placed.y };
    }

    return {
      id: node.id,
      isCenter: node.isCenter,
      // Центр прибит к своему прежнему месту, а если его там не было —
      // к началу координат. Блуждающий центр сбивал бы всю картину:
      // от него отсчитываются стороны соседей
      ...(node.isCenter ? { fx: anchor.x, fy: anchor.y } : {}),
      // Уже размещённые остаются на месте: пересчёт не должен раскидывать
      // то, что пользователь уже разглядывает
      ...(previous && !node.isCenter ? { fx: previous.x, fy: previous.y } : {}),
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
    // Центрирующей силы нет вовсе: она стягивала бы новые узлы к нулю,
    // споря с якорем, и расставленная картина уезжала бы при каждом шаге
    // Стороны: входящие влево, исходящие вправо. Сила больше, чем у
    // прежнего притяжения к центру, иначе связи перетягивают узлы обратно
    // и разделение размывается
    .force('x', forceX((node) => targetX(node.id)).strength(0.12))
    // По вертикали тянем только двусторонние — вверх и вниз попеременно.
    // Остальные держим слабо, чтобы одиночные не улетали
    .force(
      'y',
      forceY((node) => targetY(node.id)).strength((node) =>
        directions.get(node.id) === 'both' ? 0.12 : 0.04,
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
