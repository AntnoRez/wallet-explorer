import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getStraightPath, useInternalNode } from '@xyflow/react';

import { formatAmount, formatDateTime, shortenAddress, plural } from '../format.js';

/**
 * Ребро, которое цепляется к КРАЮ круга, а не к фиксированной точке.
 *
 * Обычное ребро React Flow идёт от правой стороны узла к левой. В силовой
 * раскладке узлы стоят под произвольными углами, поэтому все линии сходятся
 * в один пучок справа и выходят слева — граф выглядит спутанным клубком,
 * а направление связи читается плохо.
 *
 * Здесь линия идёт от центра к центру и обрезается по границе круга. Куда
 * бы ни сместился узел, ребро всегда упирается в его край с нужной стороны.
 */

/**
 * Точка на границе узла в направлении цели.
 *
 * Узлы у нас круглые, но React Flow знает только их прямоугольник — вместе
 * с подписью под кругом. Поэтому радиус берём от ширины круга, а центр —
 * от верхней части блока, где круг и находится.
 *
 * @param {object} node внутренний узел React Flow (с измеренными размерами)
 * @param {{x: number, y: number}} target точка, к которой тянемся
 */
function edgePoint(node, target) {
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured?.width ?? 0;

  // Радиус берём ТОЧНЫЙ, из данных узла: он же используется при отрисовке
  // круга. Прикидка по размеру блока не годится — блок включает подпись под
  // кругом, и для крупного центрального узла оценка выходила меньше
  // реального радиуса, отчего линии заходили внутрь круга.
  const radius = (node.data?.diameter ?? 34) / 2;

  const cx = x + width / 2;
  const cy = y + radius;

  const dx = target.x - cx;
  const dy = target.y - cy;
  const distance = Math.hypot(dx, dy) || 1;

  // Отступ в 4 пикселя, чтобы стрелка не наезжала на обводку круга
  const offset = radius + 4;

  return {
    x: cx + (dx / distance) * offset,
    y: cy + (dy / distance) * offset,
    cx,
    cy,
  };
}

export default function FloatingEdge({ id, source, target, markerEnd, style, data }) {
  const [hovered, setHovered] = useState(false);
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  // Узлы ещё не измерены — рисовать нечего
  if (!sourceNode || !targetNode) return null;

  // Сначала грубо целимся в центры, затем уточняем точки на границах
  const roughSource = edgePoint(sourceNode, { x: 0, y: 0 });
  const roughTarget = edgePoint(targetNode, { x: 0, y: 0 });

  const from = edgePoint(sourceNode, { x: roughTarget.cx, y: roughTarget.cy });
  const to = edgePoint(targetNode, { x: roughSource.cx, y: roughSource.cy });

  // Прямая линия, а не кривая: связь «кто кому» читается по направлению
  // отрезка, и на трёх десятках рёбер прямые не путаются между собой так,
  // как изгибы.
  const [path, labelX, labelY] = getStraightPath({
    sourceX: from.x,
    sourceY: from.y,
    targetX: to.x,
    targetY: to.y,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={hovered ? { ...style, opacity: 1, strokeWidth: (style?.strokeWidth ?? 2) + 1 } : style}
        // Невидимая широкая полоса поверх линии: попасть курсором в линию
        // толщиной в полтора пикселя практически невозможно
        interactionWidth={24}
      />

      {/*
        Обработчики вешаем на отдельный прозрачный путь: у BaseEdge нет
        событий мыши, а его interactionWidth ловит только клики React Flow
      */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />

      {/*
        Подсказка вместо постоянной подписи.

        Показывает ВСЕ связи между парой адресов — по одной на токен.
        Постоянные подписи накладывались друг на друга: от
        «18 746 075.52 USDT» оставался хвост «75.52 USDT», и сумма
        читалась неверно.
      */}
      {(hovered || data?.isSelected) && data?.pair?.length > 0 && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute z-50 min-w-[210px] rounded-lg border border-line bg-surface px-3 py-2 shadow-xl"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <div className="space-y-1.5">
              {data.pair.map((item, index) => (
                <div key={`${item.tokenSymbol}-${index}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-semibold text-ink">
                      {formatAmount(item.totalValue, item.decimals)}
                    </span>
                    <span className="text-xs text-muted">{item.tokenSymbol ?? '?'}</span>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 text-[10px] text-muted">
                    <span>
                      {item.source === data.source ? '→' : '←'} {item.transferCount}{' '}
                      {plural(item.transferCount, ['перевод', 'перевода', 'переводов'])}
                    </span>
                    {item.lastAt && <span>{formatDateTime(item.lastAt)}</span>}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-2 border-t border-line pt-1.5 text-[10px] leading-relaxed text-muted/80">
              <div className="truncate">{shortenAddress(data.source)}</div>
              <div className="truncate">{shortenAddress(data.target)}</div>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
