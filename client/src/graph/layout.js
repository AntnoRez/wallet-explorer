/**
 * Раскладка графа силовой симуляцией.
 *
 * React Flow сам узлы не расставляет — он рисует их по заданным координатам.
 * Координаты считает d3-force: узлы отталкиваются друг от друга, рёбра
 * притягивают связанные, центр удерживает всё вместе. Кластеры проявляются
 * сами, без правил вроде «выстроить по кругу».
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
export function layoutGraph(nodes, edges, pinned = new Map()) {
  if (nodes.length === 0) return new Map();

  const centerNode = nodes.find((node) => node.isCenter);

  // d3-force мутирует переданные объекты, поэтому работаем с копиями:
  // иначе он записал бы координаты и скорости прямо в узлы графа
  const simNodes = nodes.map((node) => {
    const previous = pinned.get(node.id);

    return {
      id: node.id,
      isCenter: node.isCenter,
      // Центральный узел прибит к началу координат: он точка отсчёта,
      // и его блуждание сбивало бы ориентацию при каждом пересчёте
      ...(node.isCenter ? { fx: 0, fy: 0 } : {}),
      // Уже размещённые остаются на месте
      ...(previous && !node.isCenter ? { fx: previous.x, fy: previous.y } : {}),
      // Новым задаём стартовую точку рядом с центром, иначе d3 разбросает
      // их случайно и симуляция дольше сходится
      x: previous?.x ?? (Math.random() - 0.5) * 300,
      y: previous?.y ?? (Math.random() - 0.5) * 300,
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
    .force('center', forceCenter(0, 0))
    // Лёгкое притяжение к осям — не даёт одиночным узлам улетать далеко
    .force('x', forceX(0).strength(0.04))
    .force('y', forceY(0).strength(0.04))
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
