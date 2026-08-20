import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  Controls,
  Panel,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';

import AddressNode, { nodeDiameter } from './AddressNode.jsx';
import FloatingEdge from './FloatingEdge.jsx';
import { classifyDirections, layoutGraph } from '../graph/layout.js';
import { useGraphStore, withLabels } from '../store/graphStore.js';

/** Типы объявляем вне компонента: иначе React Flow пересоздаёт их каждый рендер */
const NODE_TYPES = { address: AddressNode };
const EDGE_TYPES = { floating: FloatingEdge };

/** Толщина линии в пикселях: от и до */
const MIN_WIDTH = 1.2;
const MAX_WIDTH = 6;

/**
 * Толщина ребра по его весу.
 * Корень — по той же причине, что и у размера узлов: веса сильно скошены.
 */
function widthOf(weight = 0) {
  const scaled = Math.sqrt(Math.min(Math.max(weight, 0), 1));
  return MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * scaled;
}

export default function TransactionGraph() {
  const graph = useGraphStore((state) => state.graph);
  const labels = useGraphStore((state) => state.labels);

  // Склейка меток — в useMemo, а НЕ в селекторе Zustand: селектор,
  // возвращающий новый массив, даёт бесконечный цикл перерисовок
  const nodesWithLabels = useMemo(() => withLabels(graph.nodes, labels), [graph.nodes, labels]);
  const rootAddress = useGraphStore((state) => state.rootAddress);
  const expanding = useGraphStore((state) => state.expanding);
  const selection = useGraphStore((state) => state.selection);
  const select = useGraphStore((state) => state.select);
  const clearSelection = useGraphStore((state) => state.clearSelection);
  const expandNode = useGraphStore((state) => state.expandNode);
  const expandGroup = useGraphStore((state) => state.expandGroup);
  const chainStart = useGraphStore((state) => state.chainStart);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState([]);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState([]);
  const { fitView } = useReactFlow();

  /** Позиции между пересчётами: чтобы раскрытие не раскидывало готовый граф */
  const positionsRef = useRef(new Map());

  /**
   * Все связи между каждой парой адресов.
   *
   * Между двумя адресами бывает несколько рёбер — по одному на токен.
   * Подсказка показывает их все разом: иначе пришлось бы наводить на
   * каждую линию отдельно, а они лежат друг на друге.
   *
   * Пара ненаправленная: если A платил B и B платил A, это одна связь
   * с двумя направлениями, и разбивать её на две подсказки незачем.
   */
  const pairSummary = useMemo(() => {
    const groups = new Map();

    for (const edge of graph.edges) {
      const key = [edge.source, edge.target].sort().join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        tokenSymbol: edge.tokenSymbol,
        totalValue: edge.totalValue,
        decimals: edge.decimals,
        transferCount: edge.transferCount,
        source: edge.source,
        target: edge.target,
        firstAt: edge.firstAt,
        lastAt: edge.lastAt,
      });
    }

    // Внутри пары сортируем по количеству переводов: сначала то,
    // чем пользовались всерьёз, потом единичные спам-токены
    for (const list of groups.values()) {
      list.sort((a, b) => b.transferCount - a.transferCount);
    }

    return groups;
  }, [graph.edges]);

  // Пересобираем граф React Flow при изменении данных
  useEffect(() => {
    if (graph.nodes.length === 0) {
      setFlowNodes([]);
      setFlowEdges([]);
      positionsRef.current = new Map();
      return;
    }

    const positions = layoutGraph(graph.nodes, graph.edges, positionsRef.current, chainStart);
    positionsRef.current = positions;

    const labelsById = new Map(nodesWithLabels.map((node) => [node.id, node]));

    setFlowNodes(
      graph.nodes.map((node) => {
        const weight = weightOfNode(node, graph.edges);
        const enriched = labelsById.get(node.id) ?? node;

        return {
          id: node.id,
          type: 'address',
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          selected: selection?.type === 'node' && selection.id === node.id,
          data: {
            ...enriched,
            weight,
            // Точный диаметр круга — рёбра обрезаются по нему
            diameter: nodeDiameter({ isCenter: node.isCenter, weight }),
            isPinned: node.isPinned ?? false,
            isLoading: node.address ? expanding.has(node.address) : false,
          },
        };
      }),
    );

    // Сторона каждого узла относительно корня. Та же классификация, что
    // и в раскладке, — иначе цвет ребра мог бы разойтись с положением узла
    const directions = classifyDirections(graph.nodes, graph.edges, rootAddress);

    setFlowEdges(
      graph.edges.map((edge) => {
        // Направление считаем относительно КОРНЕВОГО адреса: зелёное —
        // деньги пришли к нему, оранжевое — ушли. Для связей между чужими
        // адресами направления «к нам» нет, поэтому нейтральный цвет.
        const isIncoming = edge.target === rootAddress;
        const isOutgoing = edge.source === rootAddress;

        // Контрагент, с которым обмен идёт в обе стороны, стоит по центру
        // сверху или снизу — и обе его связи красим жёлтым. Иначе одна
        // была бы зелёной, другая оранжевой, и узел читался бы как два
        // разных случая сразу
        const counterparty = isIncoming ? edge.source : edge.target;
        const isBoth =
          (isIncoming || isOutgoing) && directions.get(counterparty) === 'both';

        const color = isBoth
          ? 'var(--color-both)'
          : isIncoming
            ? 'var(--color-in)'
            : isOutgoing
              ? 'var(--color-out)'
              : 'var(--color-line)';

        const isSelected = selection?.type === 'edge' && selection.id === edge.id;

        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'floating',
          animated: isSelected,
          // Подпись рисует сам FloatingEdge — у него есть координаты
          // середины кривой, посчитанные по краям кругов
          // Всё, что нужно подсказке при наведении. Постоянных подписей
          // на рёбрах нет: между парой адресов бывает несколько связей
          // (по одной на токен), и их подписи накладывались друг на друга —
          // от «18 746 075.52 USDT» оставался хвост «75.52 USDT»
          data: {
            source: edge.source,
            target: edge.target,
            isSelected,
            // Все связи между этой парой — подсказка показывает их разом
            pair: pairSummary.get([edge.source, edge.target].sort().join('|')) ?? [],
          },
          style: {
            stroke: color,
            strokeWidth: isSelected ? MAX_WIDTH : widthOf(edge.weight),
            opacity: isSelected ? 1 : 0.75,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 14,
            height: 14,
            color,
          },
        };
      }),
    );
  }, [
    graph,
    nodesWithLabels,
    rootAddress,
    chainStart,
    expanding,
    selection,
    pairSummary,
    setFlowNodes,
    setFlowEdges,
  ]);

  /**
   * Метки применяем ОТДЕЛЬНЫМ эффектом, обновляя только data.
   *
   * Иначе каждый ответ с метками пересоздавал весь массив узлов, React Flow
   * сбрасывал измерения и держал узлы в visibility: hidden — на адресе, чьи
   * метки не были в кэше, граф не появлялся вовсе, хотя данные приходили.
   *
   * Здесь же ссылки на неизменившиеся узлы сохраняются, и перемерять
   * React Flow ничего не должен.
   */
  // Первое появление графа — вписываем в экран. При раскрытии не трогаем:
  // резкое перемасштабирование сбивает с толку сильнее, чем узел за краем.
  //
  // Ждём именно nodesInitialized, а не таймер: fitView считает границы по
  // измеренным размерам узлов, и вызов до измерения даёт масштаб по нулям —
  // граф оказывается в углу экрана. Так и было с setTimeout на 60 мс.
  const nodesInitialized = useNodesInitialized();
  const fittedFor = useRef(null);

  useEffect(() => {
    if (!rootAddress || !nodesInitialized || flowNodes.length === 0) return;
    if (fittedFor.current === rootAddress) return;

    fittedFor.current = rootAddress;

    // requestAnimationFrame обязателен. useNodesInitialized сообщает, что
    // узлы ИЗМЕРЕНЫ, но layout-проход браузера ещё не закончен: сразу после
    // него fitView считает границы по неполным данным, и граф уезжает
    // за край. Ждём следующий кадр.
    const frame = requestAnimationFrame(() => fitView({ padding: 0.25, duration: 400 }));
    return () => cancelAnimationFrame(frame);
  }, [rootAddress, nodesInitialized, flowNodes.length, fitView]);

  // Пересчёт при изменении размера области.
  //
  // Панель деталей занимает 320 пикселей справа и появляется не мгновенно:
  // fitView успевал отработать по полной ширине, а затем контейнер сужался,
  // и граф уезжал за край. То же случится при разворачивании окна.
  const wrapperRef = useRef(null);
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    let timer;
    const observer = new ResizeObserver(() => {
      // Небольшая задержка: во время перетаскивания границы событий много,
      // а вписывать имеет смысл только по окончании
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (fittedFor.current) fitView({ padding: 0.25, duration: 200 });
      }, 120);
    });

    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitView]);

  const onNodeClick = useCallback(
    (_event, node) => select({ type: 'node', id: node.id }),
    [select],
  );

  const onNodeDoubleClick = useCallback(
    (_event, node) => {
      // Двойной клик раскрывает: одиночный уже занят показом деталей,
      // а отдельная кнопка на узле в круг не помещается
      if (node.data.isGroup) {
        // У группы раскрытие означает другое — показать больше
        // контрагентов поимённо, а не перейти к адресу (его у неё нет)
        expandGroup();
        return;
      }

      if (node.data.address) expandNode(node.data.address);
    },
    [expandNode, expandGroup],
  );

  const onEdgeClick = useCallback(
    (_event, edge) => select({ type: 'edge', id: edge.id }),
    [select],
  );

  return (
    <div ref={wrapperRef} className="h-full w-full">
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onEdgeClick={onEdgeClick}
      onPaneClick={clearSelection}
      // Граф читают, а не редактируют
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      minZoom={0.15}
      maxZoom={2.5}
      // Штатное вписывание React Flow: он знает про свои размеры больше,
      // чем наш эффект, и делает это на нужном этапе жизненного цикла
      fitView
      fitViewOptions={{ padding: 0.25 }}
      proOptions={{ hideAttribution: false }}
      className="bg-base"
    >
      <Background color="#1c2130" gap={22} size={1} />

      <Panel position="top-left">
        <Legend />
      </Panel>
      <Controls
        className="!border-line !bg-surface [&>button]:!border-line [&>button]:!bg-surface-2 [&>button]:!fill-muted hover:[&>button]:!bg-line"
        showInteractive={false}
      />
    </ReactFlow>
    </div>
  );
}

/**
 * Вес узла — сумма весов его рёбер.
 *
 * Сервер считает вес для рёбер, а не для узлов: значимость контрагента
 * складывается из всех связей с ним. Здесь досчитываем, чтобы размер круга
 * отражал ту же величину, по которой узлы отбирались в top-N.
 */
function weightOfNode(node, edges) {
  if (node.isCenter) return 1;

  let total = 0;
  for (const edge of edges) {
    if (edge.source === node.id || edge.target === node.id) total += edge.weight ?? 0;
  }
  return total;
}

/**
 * Легенда сторон.
 *
 * Стороны и цвета — соглашение, а не общеизвестный факт: без подписи
 * жёлтое ребро приходится угадывать. Стрелки в подписях повторяют
 * положение узлов на экране, чтобы связь читалась без объяснений.
 */
function Legend() {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface/80 px-2.5 py-1.5 text-[11px] backdrop-blur">
      <LegendItem color="var(--color-in)" text="слева — прислали" />
      <LegendItem color="var(--color-out)" text="справа — отправили" />
      <LegendItem color="var(--color-both)" text="сверху и снизу — обмен" />
    </div>
  );
}

function LegendItem({ color, text }) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <span className="h-0.5 w-4 rounded" style={{ background: color }} />
      {text}
    </span>
  );
}
