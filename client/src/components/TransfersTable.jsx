import { useEffect, useMemo, useState } from 'react';
import { fetchTransfers } from '../api/client.js';
import { useGraphStore, useCurrentNetwork } from '../store/graphStore.js';
import { explorerLink } from '../address.js';
import { formatAmount, formatAge, formatDateTime, shortenAddress, plural } from '../format.js';

/**
 * Плоский список переводов — второй вид тех же данных, что и граф.
 *
 * Граф отвечает на вопрос «куда шли деньги», таблица — «что именно
 * произошло и когда». Поэтому данные она запрашивает свои: граф работает
 * с агрегированными рёбрами, а здесь нужны отдельные переводы.
 */

/** Сколько строк тянем за раз */
const PAGE_SIZE = 200;

export default function TransfersTable() {
  const network = useGraphStore((state) => state.network);
  const rootAddress = useGraphStore((state) => state.rootAddress);
  const filters = useGraphStore((state) => state.filters);
  const expandNode = useGraphStore((state) => state.expandNode);
  const wallet = useGraphStore((state) => state.wallet);

  const [state, setState] = useState({ status: 'idle', transfers: [], total: 0 });
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Храним АДРЕС КОНТРАКТА, а не символ: символы неуникальны — у одного
  // тестового адреса нашлось два разных контракта с символом «ip292».
  // 'native' означает монету сети, 'all' — без фильтра
  const [tokenFilter, setTokenFilter] = useState('all');
  const [directionFilter, setDirectionFilter] = useState('all');

  useEffect(() => {
    if (!rootAddress) return;

    const controller = new AbortController();
    setState((previous) => ({ ...previous, status: 'loading' }));

    fetchTransfers(network, rootAddress, {
      days: filters.days,
      limit,
      // Фильтр по токену — СЕРВЕРНЫЙ, в отличие от фильтра по
      // направлению. Причина: страница ограничена лимитом, и отбор
      // на клиенте показал бы «USDT: 16 переводов» там, где их в базе
      // несколько сотен. Врущий фильтр хуже медленного
      ...(tokenFilter !== 'all' ? { token: tokenFilter } : {}),
      signal: controller.signal,
    })
      .then((response) =>
        setState({ status: 'ready', transfers: response.transfers, total: response.total }),
      )
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setState({ status: 'error', transfers: [], total: 0, error: error.message });
      });

    return () => controller.abort();
  }, [network, rootAddress, filters.days, limit, tokenFilter]);

  /**
   * Токены для фильтра — из БАЛАНСА, а не из загруженной страницы.
   *
   * В балансе у каждого токена есть transferCount по всей истории адреса,
   * а страница показывает лишь первые двести переводов: собрав список
   * из неё, мы предложили бы фильтровать по тому, что случайно попало
   * в начало.
   */
  const tokens = useMemo(() => {
    const balance = wallet?.balance;
    if (!balance) return [];

    const list = (balance.tokens ?? [])
      .filter((token) => token.transferCount > 0)
      .map((token) => ({
        key: token.contractAddress,
        symbol: token.symbol ?? shortenAddress(token.contractAddress),
        count: token.transferCount,
      }));

    // Монета сети переводов в балансе не имеет — добавляем отдельно
    list.unshift({ key: 'native', symbol: balance.native?.symbol ?? 'монета', count: null });

    return list.sort((a, b) => (b.count ?? Infinity) - (a.count ?? Infinity));
  }, [wallet]);

  /**
   * Фильтрация на клиенте.
   *
   * Именно здесь, а не на сервере: данные уже загружены, а переключение
   * между «только входящие» и «только USDT» должно быть мгновенным.
   * Серверный фильтр означал бы запрос на каждый клик.
   */
  const visible = useMemo(() => {
    return state.transfers.filter((transfer) => {
      // По токену уже отфильтровал сервер — здесь только направление,
      // оно должно переключаться мгновенно
      if (directionFilter === 'in' && transfer.toAddress !== rootAddress) return false;
      if (directionFilter === 'out' && transfer.fromAddress !== rootAddress) return false;

      return true;
    });
  }, [state.transfers, directionFilter, rootAddress]);

  if (!rootAddress) {
    return <div className="p-6 text-sm text-muted">Введите адрес, чтобы увидеть переводы</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-xs">
        <Chip active={directionFilter === 'all'} onClick={() => setDirectionFilter('all')}>
          все
        </Chip>
        <Chip active={directionFilter === 'in'} onClick={() => setDirectionFilter('in')} tone="in">
          входящие
        </Chip>
        <Chip active={directionFilter === 'out'} onClick={() => setDirectionFilter('out')} tone="out">
          исходящие
        </Chip>

        <span className="mx-1 h-4 w-px bg-line" />

        {/*
          Первые пять токенов — чипами, остальные в списке рядом.
          Чипами всё показать нельзя: у активного адреса в Ethereum
          нашёлся 101 разный токен, и шапка превратилась бы в простыню.
          А списком одним тоже плохо — когда токенов два, лишний клик
          ни за чем
        */}
        <Chip active={tokenFilter === 'all'} onClick={() => setTokenFilter('all')}>
          все токены
        </Chip>

        {tokens.slice(0, 5).map((token) => (
          <Chip
            key={token.key}
            active={tokenFilter === token.key}
            onClick={() => setTokenFilter(token.key)}
            title={
              token.count === null
                ? 'Монета сети'
                : `${token.count} переводов за всю известную историю — ` +
                  'за выбранный период их может быть меньше'
            }
          >
            {token.symbol}
            {token.count !== null && <span className="ml-1 text-muted">{token.count}</span>}
          </Chip>
        ))}

        {tokens.length > 5 && (
          <select
            value={tokens.slice(0, 5).some((token) => token.key === tokenFilter) ? '' : tokenFilter}
            onChange={(event) => event.target.value && setTokenFilter(event.target.value)}
            className="rounded border border-line bg-surface-2 px-1.5 py-0.5 text-xs text-muted outline-none hover:text-ink"
          >
            <option value="">ещё {tokens.length - 5}…</option>
            {tokens.slice(5).map((token) => (
              <option key={token.key} value={token.key}>
                {token.symbol} · {token.count}
              </option>
            ))}
          </select>
        )}

        <span className="ml-auto text-muted">
          {state.status === 'loading'
            ? 'загрузка…'
            : `${visible.length} из ${state.total} ${plural(state.total, ['перевода', 'переводов', 'переводов'])}` +
              (tokenFilter !== 'all' ? ' по токену' : '')}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-muted">
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2 font-medium">Хэш</th>
              <th className="px-3 py-2 font-medium">Когда</th>
              <th className="px-3 py-2 font-medium">Контрагент</th>
              <th className="px-3 py-2 text-right font-medium">Сумма</th>
              <th className="px-3 py-2 font-medium">Токен</th>
              <th className="px-3 py-2 font-medium">Тип</th>
            </tr>
          </thead>

          <tbody>
            {visible.map((transfer) => (
              <TransferRow
                key={`${transfer.hash}|${transfer.transferIndex}`}
                transfer={transfer}
                rootAddress={rootAddress}
                onOpenAddress={expandNode}
              />
            ))}
          </tbody>
        </table>

        {state.status === 'ready' && visible.length === 0 && (
          <div className="p-6 text-center text-sm text-muted">
            Под выбранные условия ничего не подошло
          </div>
        )}

        {state.status === 'error' && (
          <div className="p-6 text-center text-sm text-danger">{state.error}</div>
        )}

        {state.transfers.length < state.total && (
          <div className="border-t border-line p-3 text-center">
            <button
              onClick={() => setLimit((current) => current + PAGE_SIZE)}
              disabled={state.status === 'loading'}
              className="rounded-md border border-line bg-surface-2 px-4 py-2 text-xs text-ink disabled:opacity-40"
            >
              Показать ещё {PAGE_SIZE}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ children, active, onClick, tone, title }) {
  const toneClass =
    tone === 'in' ? 'text-in' : tone === 'out' ? 'text-out' : 'text-ink';

  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        'rounded border px-2 py-1 transition-colors',
        active ? 'border-accent/50 bg-accent/10' : 'border-line bg-surface-2 hover:border-muted/40',
        active ? toneClass : 'text-muted',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function TransferRow({ transfer, rootAddress, onOpenAddress }) {
  const currentNetwork = useCurrentNetwork();
  const outgoing = transfer.fromAddress === rootAddress;
  const counterparty = outgoing ? transfer.toAddress : transfer.fromAddress;

  return (
    <tr className="border-b border-line/50 hover:bg-surface-2/60">
      <td className="px-3 py-1.5">
        <span className={outgoing ? 'text-out' : 'text-in'}>{outgoing ? '→' : '←'}</span>
      </td>

      <td className="px-3 py-1.5">
        <a
          href={explorerLink(currentNetwork?.explorerTx, { hash: transfer.hash })}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-muted hover:text-accent"
          title={transfer.hash}
        >
          {transfer.hash.slice(0, 8)}…{transfer.hash.slice(-4)}
        </a>
      </td>

      <td className="px-3 py-1.5 text-muted" title={formatDateTime(transfer.blockTimestamp)}>
        {formatAge(transfer.blockTimestamp)}
      </td>

      <td className="px-3 py-1.5">
        {counterparty ? (
          <button
            onClick={() => onOpenAddress(counterparty)}
            className="font-mono text-muted hover:text-accent"
            title={counterparty}
          >
            {shortenAddress(counterparty)}
          </button>
        ) : (
          <span className="text-muted/50">—</span>
        )}
      </td>

      <td
        className={`px-3 py-1.5 text-right font-medium ${outgoing ? 'text-out' : 'text-in'}`}
      >
        {outgoing ? '−' : '+'}
        {formatAmount(transfer.value, transfer.decimals)}
      </td>

      <td className="px-3 py-1.5 text-muted">
        {transfer.tokenSymbol ?? <span className="text-muted/50">неизвестен</span>}
      </td>

      <td className="px-3 py-1.5">
        <TypeBadge type={transfer.transferType} />
      </td>
    </tr>
  );
}

/**
 * Тип перевода — то, чего нет в обычных обозревателях.
 *
 * Показывает, откуда взялась запись: обычный перевод монеты, токен или
 * внутренний перевод, сделанный контрактом. Последние в эксплорерах
 * приходится искать отдельно, а для разбора движения средств они важны.
 */
function TypeBadge({ type }) {
  const currentNetwork = useCurrentNetwork();

  const map = {
    // Символ монеты берём у сети: TRX, POL или ETH — смотря где смотрим
    native: { text: currentNetwork?.nativeSymbol ?? 'монета', cls: 'border-line text-muted' },
    token: { text: 'токен', cls: 'border-line text-muted' },
    internal: { text: 'внутр.', cls: 'border-group/40 text-group' },
  };

  const item = map[type] ?? { text: type, cls: 'border-line text-muted' };

  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${item.cls}`}>{item.text}</span>;
}
