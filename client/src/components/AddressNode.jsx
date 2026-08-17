import { Handle, Position } from '@xyflow/react';

/**
 * Узел графа — адрес или сводная группа.
 *
 * Форма: круг с подписью под ним. Круг, а не карточка, потому что в
 * силовой раскладке узлы поворачиваются друг к другу произвольными
 * сторонами — у круга нет «неудачного» угла, а рёбра всегда упираются
 * в край одинаково.
 *
 * Размер круга — по обороту: крупный контрагент виден до чтения подписи.
 */

/** Размеры круга в пикселях: от и до */
export const MIN_SIZE = 34;
export const MAX_SIZE = 78;

/**
 * Диаметр по весу узла.
 *
 * Вес — доля от общего оборота, обычно сильно скошенная: один контрагент
 * забирает половину, остальные по проценту. Линейная шкала сделала бы их
 * неразличимыми, поэтому корень — он поднимает мелкие значения, не раздувая
 * крупные.
 *
 * Экспортируется, потому что тот же размер нужен рёбрам: они обрезаются по
 * границе круга, и приблизительная оценка радиуса заводила линии внутрь.
 */
export function nodeDiameter(node) {
  if (node.isCenter) return MAX_SIZE;
  const scaled = Math.sqrt(Math.min(Math.max(node.weight ?? 0, 0), 1));
  return Math.round(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * scaled);
}

/**
 * Сокращение адреса, если метки нет: TWS1on…Hh7PV
 * Хвост информативнее начала — у всех Tron-адресов оно похоже.
 */
function shorten(address) {
  if (!address || address.length <= 14) return address ?? '';
  return `${address.slice(0, 6)}…${address.slice(-5)}`;
}

export default function AddressNode({ data, selected }) {
  const {
    isCenter,
    isGroup,
    isExpanded,
    isSuspicious,
    publicLabel,
    address,
    groupSize,
    weight = 0,
    isLoading,
  } = data;

  const size = nodeDiameter({ isCenter, weight });
  const caption = publicLabel || (isGroup ? `+${groupSize}` : shorten(address));

  // Цвет несёт смысл, а не украшает:
  //   accent  — центр, точка отсчёта
  //   group   — сводный узел, не настоящий адрес
  //   danger  — сработала эвристика или метка риска
  //   line    — обычный контрагент
  const ring = isSuspicious
    ? 'border-danger'
    : isCenter
      ? 'border-accent'
      : isGroup
        ? 'border-group'
        : 'border-line';

  const fill = isCenter
    ? 'bg-accent/15'
    : isGroup
      ? 'bg-group/15'
      : isSuspicious
        ? 'bg-danger/10'
        : 'bg-surface-2';

  return (
    <div className="flex flex-col items-center" style={{ width: MAX_SIZE + 60 }}>
      {/*
        Точки соединения рёбер. Скрыты: пользователь ничего не соединяет
        руками, но React Flow без них не знает, куда вести линии.
        Обе по центру — ребро само найдёт край круга.
      */}
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />

      <div
        className={[
          'relative flex items-center justify-center rounded-full border-2 transition-shadow',
          ring,
          fill,
          selected ? 'shadow-[0_0_0_3px_rgba(76,141,255,0.35)]' : '',
        ].join(' ')}
        style={{ width: size, height: size }}
      >
        {isGroup ? (
          <span className="text-[11px] font-semibold text-group">{groupSize}</span>
        ) : (
          <span className="text-[10px] font-medium text-muted">
            {isExpanded ? '●' : '○'}
          </span>
        )}

        {/* Раскрытие идёт — показываем это на самом узле, а не только в шапке */}
        {isLoading && (
          <span className="absolute inset-0 animate-ping rounded-full border-2 border-accent/60" />
        )}
      </div>

      <div className="mt-1.5 max-w-full text-center">
        <div
          className={[
            'truncate text-[11px] leading-tight',
            isCenter ? 'font-semibold text-ink' : 'text-muted',
            publicLabel ? 'text-ink' : '',
          ].join(' ')}
          title={address ?? caption}
        >
          {caption}
        </div>

        {/*
          Подсказка о нераскрытом узле. Показываем только у обычных адресов:
          у сводного узла раскрытие означает другое — показать следующую
          порцию контрагентов, и это делает клик по самому узлу.
        */}
        {!isCenter && !isGroup && !isExpanded && (
          <div className="text-[9px] leading-tight text-muted/60">не раскрыт</div>
        )}
      </div>
    </div>
  );
}
