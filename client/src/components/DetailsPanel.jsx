import { useEffect, useMemo, useState } from 'react';
import { fetchTransfers } from '../api/client.js';
import { useGraphStore, findSelected } from '../store/graphStore.js';
import { formatAmount, shortenAddress, formatDateTime, plural } from '../format.js';

/**
 * Правая панель: подробности о выбранном узле или ребре.
 *
 * Ничего не выбрано — показываем сводку по корневому адресу: баланс,
 * статистику, состояние загрузки.
 */
export default function DetailsPanel() {
  const selection = useGraphStore((state) => state.selection);
  const graph = useGraphStore((state) => state.graph);
  const selected = selection ? findSelected(selection, graph) : null;

  if (!selected) return <WalletSummary />;
  if (selected.type === 'node') return <NodeDetails node={selected.node} />;
  return <EdgeDetails edge={selected.edge} />;
}

/* ─────────────────────────── Общие части ─────────────────────────── */

function Section({ title, children }) {
  return (
    <div className="border-b border-line px-4 py-3">
      {title && (
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function AddressLine({ address, label }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Буфер обмена недоступен (не https или запрет) — молча пропускаем:
      // адрес всё равно виден и его можно выделить мышью
    }
  };

  return (
    <div>
      {label && <div className="mb-1 text-sm font-semibold text-ink">{label}</div>}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={address}>
          {address}
        </code>
        <button
          onClick={copy}
          className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
        >
          {copied ? 'скопировано' : 'копировать'}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Сводка по кошельку ────────────────────── */

function WalletSummary() {
  const wallet = useGraphStore((state) => state.wallet);
  const status = useGraphStore((state) => state.status);
  const loadMore = useGraphStore((state) => state.loadMore);
  const refresh = useGraphStore((state) => state.refresh);

  if (!wallet) {
    return (
      <div className="p-4 text-sm text-muted">
        {status === 'loading' ? 'Загрузка…' : 'Введите адрес, чтобы построить граф'}
      </div>
    );
  }

  const { balance, graph, sync, query, address } = wallet;
  const nativeDecimals = balance?.native?.decimals ?? 6;

  return (
    <div>
      <Section>
        <AddressLine address={address} />
      </Section>

      {balance && !balance.unavailable && (
        <BalanceSection balance={balance} nativeDecimals={nativeDecimals} />
      )}

      <Section title="Граф">
        <Row label="Узлов" value={graph.stats.nodeCount} />
        <Row label="Связей" value={graph.stats.edgeCount} />
        {graph.stats.hiddenNodeCount > 0 && (
          <Row label="Свёрнуто адресов" value={graph.stats.hiddenNodeCount} />
        )}
        {graph.stats.noiseTransfers > 0 && (
          <Row label="Отсеяно как шум" value={`${graph.stats.noiseTransfers} переводов`} />
        )}
        <Row
          label="Переводов"
          value={`${query.transfersUsed} из ${query.transfersInDb}`}
        />
      </Section>

      {graph.stats.tokens?.length > 0 && (
        <Section title="Токены">
          {graph.stats.tokens.slice(0, 6).map((token) => (
            <Row key={token.symbol} label={token.symbol} value={token.count} />
          ))}
        </Section>
      )}

      <Section>
        <div className="flex gap-2">
          <button
            onClick={refresh}
            disabled={status === 'loading'}
            className="flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink disabled:opacity-40"
          >
            Обновить
          </button>
          {sync.hasMore && (
            <button
              onClick={loadMore}
              disabled={status === 'loading'}
              className="flex-1 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent disabled:opacity-40"
            >
              Загрузить ещё
            </button>
          )}
        </div>
        {sync.partial?.length > 0 && (
          <div className="mt-2 text-[11px] text-out">
            Часть источников не ответила — данные неполные
          </div>
        )}
      </Section>
    </div>
  );
}

/**
 * Баланс: TRX и токены.
 *
 * Токены разделены на осмысленные и спам. Признак — сколько раз токен
 * участвовал в переводах этого адреса: у настоящего их сотни, у спам-рассылки
 * ровно один, тот самый, которым его и прислали. У тестового адреса из 175
 * токенов на балансе 170 не участвовали ни в одном переводе.
 *
 * Спам не выбрасываем, а прячем за раскрывающимся списком: скрытый
 * токен может оказаться важным, а решать за пользователя, что ему не нужно,
 * инструмент расследования не должен.
 */
function BalanceSection({ balance, nativeDecimals }) {
  const [showSpam, setShowSpam] = useState(false);

  const tokens = balance.tokens ?? [];
  const meaningful = tokens
    .filter((token) => token.transferCount > 0)
    .sort((a, b) => b.transferCount - a.transferCount);
  const spam = tokens.filter((token) => !token.transferCount);

  return (
    <Section title="Баланс">
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-semibold text-ink">
          {formatAmount(balance.native.balance, nativeDecimals)}
        </span>
        <span className="text-xs text-muted">{balance.native.symbol}</span>
      </div>

      {balance.native.frozen !== '0' && (
        <div className="mt-1 text-[11px] text-muted">
          заморожено: {formatAmount(balance.native.frozen, nativeDecimals)}
        </div>
      )}

      {meaningful.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-line/60 pt-2">
          {meaningful.map((token) => (
            <TokenRow key={token.contractAddress} token={token} />
          ))}
        </div>
      )}

      {spam.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowSpam((value) => !value)}
            className="text-[11px] text-muted hover:text-ink"
          >
            {showSpam ? '▾' : '▸'} ещё {spam.length}{' '}
            {plural(spam.length, ['токен', 'токена', 'токенов'])} без единого перевода
          </button>

          {showSpam && (
            <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
              {spam.slice(0, 50).map((token) => (
                <div
                  key={token.contractAddress}
                  className="flex items-baseline justify-between text-[10px] text-muted/60"
                >
                  <code className="truncate" title={token.contractAddress}>
                    {shortenAddress(token.contractAddress)}
                  </code>
                  <span className="ml-2 shrink-0">{token.balance}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function TokenRow({ token }) {
  // Мало переводов — возможно подделка под известный символ. У тестового
  // адреса нашлось два разных контракта с одинаковым названием
  const suspicious = token.transferCount < 3;

  return (
    <div className="flex items-baseline justify-between text-xs">
      <span className="flex items-baseline gap-1.5">
        <span className={suspicious ? 'text-muted' : 'text-ink'}>
          {token.symbol ?? shortenAddress(token.contractAddress)}
        </span>
        {suspicious && (
          <span className="text-[9px] text-muted/60" title="Мало переводов — возможно спам">
            {token.transferCount}×
          </span>
        )}
      </span>
      <span className={suspicious ? 'text-muted/70' : 'font-medium text-ink'}>
        {formatAmount(token.balance, token.decimals)}
      </span>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-xs">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-ink">{value}</span>
    </div>
  );
}

/* ──────────────────────────── Узел ───────────────────────────────── */

function NodeDetails({ node }) {
  const expandNode = useGraphStore((state) => state.expandNode);
  const expandGroup = useGraphStore((state) => state.expandGroup);
  const rootAddress = useGraphStore((state) => state.rootAddress);
  const network = useGraphStore((state) => state.network);
  const wallet = useGraphStore((state) => state.wallet);

  if (node.isGroup) {
    return (
      <div>
        <Section>
          <div className="text-sm font-semibold text-group">
            Свёрнуто: {node.groupSize} адрес(ов)
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-muted">
            Контрагенты с малой долей оборота. Они не пропали из данных — просто
            не показаны поимённо, чтобы граф оставался читаемым.
          </div>
          <button
            onClick={expandGroup}
            className="mt-3 w-full rounded-md border border-group/40 bg-group/10 px-3 py-2 text-xs text-group"
          >
            Показать больше контрагентов
          </button>
        </Section>
      </div>
    );
  }

  const explorer = `https://tronscan.org/#/address/${node.address}`;
  const isRoot = node.address === rootAddress;

  return (
    <div>
      <Section>
        <AddressLine address={node.address} label={node.publicLabel ?? shortenAddress(node.address)} />

        {node.tags && (
          <div className="mt-2 flex flex-wrap gap-1">
            {node.tags.redTag && <Tag tone="danger">{node.tags.redTag}</Tag>}
            {node.tags.greyTag && <Tag tone="muted">{node.tags.greyTag}</Tag>}
            {node.tags.chainTags?.map((tag) => (
              <Tag key={tag} tone="muted">
                {tag}
              </Tag>
            ))}
          </div>
        )}

        {node.isSuspicious && (
          <div className="mt-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
            {node.suspicionReason ?? 'Помечен как подозрительный'}
          </div>
        )}
      </Section>

      <TotalsSection totals={node.totals} />

      <Section>
        <div className="flex gap-2">
          {!isRoot && (
            <button
              onClick={() => expandNode(node.address)}
              className="flex-1 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent"
            >
              Перейти к адресу
            </button>
          )}
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-center text-xs text-ink"
          >
            Tronscan
          </a>
        </div>
        {isRoot && wallet && (
          <div className="mt-2 text-[11px] text-muted">Это текущий центр графа</div>
        )}
      </Section>
    </div>
  );
}

function Tag({ children, tone }) {
  const cls = tone === 'danger' ? 'border-danger/40 text-danger' : 'border-line text-muted';
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] ${cls}`}>{children}</span>;
}

/**
 * Обороты по токенам с сальдо.
 *
 * Сальдо — главное, что говорит о роли адреса: получил столько же, сколько
 * отправил, значит через него деньги прошли насквозь; получил и не отправил
 * — здесь они осели.
 */
function TotalsSection({ totals }) {
  const entries = Object.entries(totals ?? {});
  if (entries.length === 0) return null;

  return (
    <Section title="Оборот в этом графе">
      {entries.map(([key, total]) => {
        const decimals = total.decimals;
        const incoming = BigInt(total.in ?? '0');
        const outgoing = BigInt(total.out ?? '0');
        const net = incoming - outgoing;

        return (
          <div key={key} className="mb-3 last:mb-0">
            <div className="mb-1 text-xs font-medium text-ink">
              {total.symbol ?? 'неизвестный токен'}
            </div>
            <Row label="получено" value={<span className="text-in">{formatAmount(total.in, decimals)}</span>} />
            <Row label="отправлено" value={<span className="text-out">{formatAmount(total.out, decimals)}</span>} />
            <div className="mt-1 flex items-baseline justify-between border-t border-line/60 pt-1 text-xs">
              <span className="text-muted">сальдо</span>
              <span className={net >= 0n ? 'font-medium text-in' : 'font-medium text-out'}>
                {net >= 0n ? '+' : '−'}
                {formatAmount((net < 0n ? -net : net).toString(), decimals)}
              </span>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

/* ──────────────────────────── Ребро ──────────────────────────────── */

function EdgeDetails({ edge }) {
  const network = useGraphStore((state) => state.network);
  const rootAddress = useGraphStore((state) => state.rootAddress);
  const filters = useGraphStore((state) => state.filters);
  const graph = useGraphStore((state) => state.graph);

  const [state, setState] = useState({ status: 'idle', transfers: [], total: 0 });

  const isGroupEdge = edge.source.startsWith('__') || edge.target.startsWith('__');
  const anchor = edge.source === rootAddress ? edge.source : edge.target;
  const counterparty = edge.source === rootAddress ? edge.target : edge.source;

  /**
   * Все связи между этой парой адресов, а не только то ребро, по которому
   * кликнули.
   *
   * Между двумя адресами бывает несколько рёбер — по одному на токен.
   * Клик по TRX-линии показывал только TRX, хотя рядом лежали 17 миллионов
   * USDT: пользователь видел «1 перевод» и делал неверный вывод о связи.
   */
  const pairEdges = useMemo(() => {
    const key = [edge.source, edge.target].sort().join('|');

    return graph.edges
      .filter((item) => [item.source, item.target].sort().join('|') === key)
      .sort((a, b) => b.transferCount - a.transferCount);
  }, [graph.edges, edge.source, edge.target]);

  useEffect(() => {
    if (isGroupEdge) {
      setState({ status: 'group', transfers: [], total: 0 });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'loading', transfers: [], total: 0 });

    // Без фильтра по токену: показываем всё, что было между этими адресами
    fetchTransfers(network, anchor, {
      counterparty,
      days: filters.days,
      limit: 100,
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
  }, [network, anchor, counterparty, filters.days, isGroupEdge]);

  return (
    <div>
      <Section>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Связь между адресами
        </div>
        <div className="mt-2 space-y-1 text-[11px]">
          <div className="flex gap-2">
            <span className="w-3 shrink-0 text-muted">1</span>
            <code className="truncate font-mono text-muted" title={edge.source}>
              {shortenAddress(edge.source)}
            </code>
          </div>
          <div className="flex gap-2">
            <span className="w-3 shrink-0 text-muted">2</span>
            <code className="truncate font-mono text-muted" title={edge.target}>
              {shortenAddress(edge.target)}
            </code>
          </div>
        </div>
      </Section>

      <Section title={`Потоки по токенам (${pairEdges.length})`}>
        {pairEdges.map((item) => {
          const outgoing = item.source === anchor;

          return (
            <div key={item.id} className="mb-2.5 last:mb-0">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-ink">
                  {formatAmount(item.totalValue, item.decimals)}
                </span>
                <span className="text-xs text-muted">{item.tokenSymbol ?? '?'}</span>
              </div>
              <div className="flex items-baseline justify-between text-[11px] text-muted">
                <span className={outgoing ? 'text-out' : 'text-in'}>
                  {outgoing ? '→ отправлено' : '← получено'}
                </span>
                <span>
                  {item.transferCount}{' '}
                  {plural(item.transferCount, ['перевод', 'перевода', 'переводов'])}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-muted/70">
                {formatDateTime(item.firstAt)} — {formatDateTime(item.lastAt)}
              </div>
            </div>
          );
        })}
      </Section>

      {state.status === 'group' && (
        <Section>
          <div className="text-[11px] leading-relaxed text-muted">
            Это сводная связь с группой адресов. Список переводов по ней не
            запрашивается: контрагентов сотни, и осмысленной таблицы не выйдет.
          </div>
        </Section>
      )}

      {state.status === 'loading' && (
        <Section>
          <div className="text-xs text-muted">Загрузка переводов…</div>
        </Section>
      )}

      {state.status === 'error' && (
        <Section>
          <div className="text-xs text-danger">{state.error}</div>
        </Section>
      )}

      {state.status === 'ready' && (
        <Section title={`Все переводы между адресами (${state.total})`}>
          {/*
            Список ШИРЕ, чем одно ребро: сюда попадают все токены и оба
            направления. Ребро графа — это связь в одном токене, а связь
            между адресами обычно шире.
          */}
          <div className="space-y-1.5">
            {state.transfers.map((transfer) => (
              <TransferRow
                key={`${transfer.hash}|${transfer.transferIndex}`}
                transfer={transfer}
                anchor={anchor}
              />
            ))}
          </div>
          {state.total > state.transfers.length && (
            <div className="mt-2 text-[10px] text-muted">
              показаны первые {state.transfers.length}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function TransferRow({ transfer, anchor }) {
  const outgoing = transfer.fromAddress === anchor;

  return (
    <a
      href={`https://tronscan.org/#/transaction/${transfer.hash}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-baseline gap-2 rounded px-1 py-1 text-[11px] hover:bg-surface-2"
    >
      <span className={outgoing ? 'text-out' : 'text-in'}>{outgoing ? '→' : '←'}</span>
      <span className="shrink-0 text-muted">{formatDateTime(transfer.blockTimestamp)}</span>
      <span className="ml-auto shrink-0 font-medium text-ink">
        {formatAmount(transfer.value, transfer.decimals)}
      </span>
      <span className="w-10 shrink-0 truncate text-right text-muted">
        {transfer.tokenSymbol ?? '?'}
      </span>
    </a>
  );
}
