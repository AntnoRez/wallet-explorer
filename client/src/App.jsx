import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

import TransactionGraph from './components/TransactionGraph.jsx';
import TransfersTable from './components/TransfersTable.jsx';
import DetailsPanel from './components/DetailsPanel.jsx';
import FiltersBar from './components/FiltersBar.jsx';
import { useGraphStore } from './store/graphStore.js';
import { plural } from './format.js';

/** Адрес для первого запуска, чтобы не начинать с пустого экрана */
const DEMO_ADDRESS = 'TWS1onJnNTg8tJHomceqxBxTsUB1DHh7PV';

export default function App() {
  const [input, setInput] = useState(DEMO_ADDRESS);

  const load = useGraphStore((state) => state.load);
  const status = useGraphStore((state) => state.status);
  const error = useGraphStore((state) => state.error);
  const wallet = useGraphStore((state) => state.wallet);
  const history = useGraphStore((state) => state.history);
  const goBack = useGraphStore((state) => state.goBack);
  const rootAddress = useGraphStore((state) => state.rootAddress);
  const view = useGraphStore((state) => state.view);
  const setView = useGraphStore((state) => state.setView);

  useEffect(() => {
    load(DEMO_ADDRESS);
  }, [load]);

  // Поле ввода следует за графом: перешли по узлу — в поле новый адрес.
  // Иначе там остаётся то, что вводили руками, и непонятно, чей граф открыт
  useEffect(() => {
    if (rootAddress) setInput(rootAddress);
  }, [rootAddress]);

  const submit = () => {
    const address = input.trim();
    if (address) load(address);
  };

  const stats = wallet?.graph?.stats;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <button
          onClick={goBack}
          disabled={history.length === 0}
          title="Вернуться к предыдущему адресу"
          className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-30 disabled:hover:text-muted"
        >
          ←
        </button>

        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          spellCheck={false}
          className="w-[400px] rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-ink outline-none transition-colors focus:border-accent"
          placeholder="Адрес Tron — начинается с T"
        />

        <button
          onClick={submit}
          disabled={status === 'loading'}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Показать
        </button>

        {/* Переключатель видов: граф и таблица показывают одни данные */}
        <div className="flex rounded-md border border-line bg-surface-2 p-0.5">
          <ViewButton active={view === 'graph'} onClick={() => setView('graph')}>
            Граф
          </ViewButton>
          <ViewButton active={view === 'table'} onClick={() => setView('table')}>
            Список
          </ViewButton>
        </div>

        <div className="min-w-0 flex-1 truncate text-xs text-muted">
          {history.length > 0 && (
            <span className="mr-3 text-muted/70">
              путь: {history.length + 1}{' '}
              {plural(history.length + 1, ['адрес', 'адреса', 'адресов'])}
            </span>
          )}

          {status === 'loading' && 'загрузка…'}

          {status === 'ready' && stats && (
            <>
              {stats.nodeCount} {plural(stats.nodeCount, ['узел', 'узла', 'узлов'])} ·{' '}
              {stats.edgeCount} {plural(stats.edgeCount, ['связь', 'связи', 'связей'])}
              {stats.hiddenNodeCount > 0 && ` · свёрнуто ${stats.hiddenNodeCount}`}
            </>
          )}

          {status === 'error' && (
            <span className={error?.isUserError ? 'text-out' : 'text-danger'}>
              {error?.message}
            </span>
          )}
        </div>
      </header>

      <FiltersBar />

      <main className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {/*
            Граф держим смонтированным даже в режиме таблицы: React Flow
            при повторном монтировании заново измеряет узлы и вписывает вид,
            и переключение туда-обратно сбрасывало бы масштаб и положение.
          */}
          <div className={view === 'graph' ? 'h-full' : 'hidden'}>
            <ReactFlowProvider>
              <TransactionGraph />
            </ReactFlowProvider>
          </div>

          {view === 'table' && <TransfersTable />}
        </div>

        <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-surface">
          <DetailsPanel />
        </aside>
      </main>
    </div>
  );
}

function ViewButton({ children, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded px-3 py-1.5 text-xs transition-colors',
        active ? 'bg-accent text-white' : 'text-muted hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}
