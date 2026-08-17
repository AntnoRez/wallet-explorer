import { useGraphStore } from '../store/graphStore.js';

/**
 * Фильтры выборки.
 *
 * Все три меняют то, что считает сервер, поэтому каждый переключатель
 * перезапрашивает граф. Локально отфильтровать нельзя: сервер отбирает
 * top-N по обороту ещё до отправки, и «показать 50 узлов» означает другую
 * выборку, а не другой показ той же.
 */

/** Период выборки. 0 — всё, что есть в базе */
const PERIODS = [
  { value: 7, label: '7 дней' },
  { value: 30, label: '30 дней' },
  { value: 90, label: '90 дней' },
  { value: 0, label: 'всё' },
];

/** Сколько контрагентов показывать поимённо */
const NODE_LIMITS = [10, 20, 50, 100];

export default function FiltersBar() {
  const filters = useGraphStore((state) => state.filters);
  const setFilters = useGraphStore((state) => state.setFilters);
  const status = useGraphStore((state) => state.status);

  const disabled = status === 'loading';

  return (
    <div className="flex items-center gap-4 border-b border-line bg-surface/60 px-4 py-2 text-xs">
      <Group label="Период">
        {PERIODS.map((period) => (
          <Option
            key={period.value}
            active={filters.days === period.value}
            disabled={disabled}
            onClick={() => setFilters({ days: period.value })}
          >
            {period.label}
          </Option>
        ))}
      </Group>

      <Divider />

      <Group label="Узлов">
        {NODE_LIMITS.map((limit) => (
          <Option
            key={limit}
            active={filters.topNodes === limit}
            disabled={disabled}
            onClick={() => setFilters({ topNodes: limit })}
          >
            {limit}
          </Option>
        ))}
      </Group>

      <Divider />

      {/*
        Порог отсекает пыль: переводы мельче 0.01% оборота токена. На живых
        данных это 200–400 записей из тысячи — в основном комиссии и
        спам-рассылки. Выключать имеет смысл, когда ищешь именно мелкие
        движения: дробление средств выглядит как раз так.
      */}
      <Group label="Мелкие переводы">
        <Option
          active={filters.minShare > 0}
          disabled={disabled}
          onClick={() => setFilters({ minShare: 0.0001 })}
        >
          скрыть
        </Option>
        <Option
          active={filters.minShare === 0}
          disabled={disabled}
          onClick={() => setFilters({ minShare: 0 })}
        >
          показать
        </Option>
      </Group>
    </div>
  );
}

function Group({ label, children }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted/70">{label}</span>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function Option({ children, active, disabled, onClick }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'rounded border px-2 py-0.5 transition-colors',
        active
          ? 'border-accent/50 bg-accent/10 text-accent'
          : 'border-line bg-surface-2 text-muted hover:text-ink',
        disabled ? 'opacity-50' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-line" />;
}
