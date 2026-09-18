import { useState } from 'react';
import { useApp } from '../AppContext.js';
import { Button, Empty, ErrorNote, Field, JsonBlock, Loading, Metric, Panel, Pill, Table, inputClass } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { formatDateTime } from '../lib/format.js';

/**
 * Memory is scoped, provenance-carrying and expiring; an operator can see all
 * of that here and forget an entry without clearing a run (spec §28, §29).
 */
export function MemoryPage() {
  const { client } = useApp();
  const [type, setType] = useState('');
  const [text, setText] = useState('');
  const [minImportance, setMinImportance] = useState('');
  const [includeExpired, setIncludeExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const state = useAsync(async () => {
    const importance = minImportance.trim() === '' ? undefined : Number(minImportance);
    return client.listMemory({
      ...(type === '' ? {} : { type }),
      ...(text.trim() === '' ? {} : { text: text.trim() }),
      ...(importance === undefined || Number.isNaN(importance) ? {} : { minImportance: importance }),
      limit: 200,
    });
  }, [client, type, text, minImportance]);

  async function forget(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      await client.forgetMemory(id);
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  }

  async function prune() {
    setBusy(true);
    setError(undefined);
    try {
      await client.pruneMemory();
      state.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(false);
    }
  }

  const items = (state.data?.items ?? []).filter(
    (entry) => includeExpired || entry.expiresAt === undefined || entry.expiresAt > Date.now(),
  );
  const summary = state.data?.summary;

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Memory</h1>
          <p className="text-sm text-slate-500">
            Nothing is persisted unless an agent asked for it, and everything carries its source,
            trust and confidence.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={state.reload} disabled={busy}>Refresh</Button>
          <Button onClick={prune} disabled={busy} variant="danger">Prune expired</Button>
        </div>
      </header>

      <ErrorNote error={error} />
      <ErrorNote error={state.error} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Entries" value={state.data?.total ?? 0} />
        <Metric label="Average importance" value={summary?.averageImportance ?? '—'} />
        <Metric label="Expired in page" value={summary?.expired ?? 0} tone={(summary?.expired ?? 0) > 0 ? 'warn' : 'neutral'} />
        <Metric
          label="Types"
          value={Object.entries(summary?.byType ?? {}).map(([key, count]) => `${key} ${count}`).join(' · ') || '—'}
        />
      </div>

      <Panel title="Search" subtitle="Scoped to this organization and project">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Type">
            <select className={inputClass} value={type} onChange={(event) => setType(event.target.value)}>
              <option value="">any</option>
              <option value="working">working</option>
              <option value="episodic">episodic</option>
              <option value="semantic">semantic</option>
              <option value="task">task</option>
            </select>
          </Field>
          <div className="min-w-[240px] flex-1">
            <Field label="Text">
              <input
                className={`${inputClass} w-full`}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="e.g. pnpm"
              />
            </Field>
          </div>
          <div className="w-28">
            <Field label="Min importance">
              <input
                className={`${inputClass} w-full`}
                value={minImportance}
                onChange={(event) => setMinImportance(event.target.value)}
                inputMode="decimal"
                placeholder="0.5"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-1.5 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={includeExpired}
              onChange={(event) => setIncludeExpired(event.target.checked)}
            />
            show expired
          </label>
        </div>
      </Panel>

      <Panel title="Entries" subtitle={`${items.length} shown`}>
        {state.loading && state.data === undefined && <Loading />}
        {items.length === 0 && <Empty>No memory matches.</Empty>}
        <Table
          rows={items}
          rowKey={(entry) => entry.id}
          empty="No memory matches."
          columns={[
            { key: 'type', header: 'Type', render: (entry) => <Pill>{entry.type}</Pill> },
            { key: 'content', header: 'Content', render: (entry) => <span className="text-slate-300">{clip(entry.content, 90)}</span> },
            { key: 'scope', header: 'Scope', render: (entry) => (
              <span className="text-[11px] text-slate-400">
                {entry.scope.runId ?? entry.scope.agentId ?? `${entry.scope.organizationId}/${entry.scope.projectId ?? '—'}`}
              </span>
            ) },
            { key: 'importance', header: 'Importance', render: (entry) => <span className="tabular">{entry.importance.toFixed(2)}</span> },
            { key: 'confidence', header: 'Confidence', render: (entry) => <span className="tabular">{entry.confidence.toFixed(2)}</span> },
            { key: 'trust', header: 'Trust', render: (entry) => <span className="text-[11px] text-slate-400">{entry.trust}</span> },
            { key: 'source', header: 'Source', render: (entry) => <span className="text-[11px] text-slate-400">{entry.source}</span> },
            {
              key: 'ttl',
              header: 'Expires',
              render: (entry) => (
                <span className="tabular text-[11px] text-slate-400">
                  {entry.expiresAt === undefined ? 'never' : formatDateTime(entry.expiresAt)}
                </span>
              ),
            },
            {
              key: 'forget',
              header: '',
              render: (entry) => (
                <Button variant="danger" disabled={busy} onClick={() => void forget(entry.id)}>
                  Forget
                </Button>
              ),
            },
          ]}
        />
      </Panel>

      {items.length > 0 && (
        <Panel title="Entry detail" subtitle={items[0]?.id}>
          <JsonBlock value={items[0]} maxHeight={320} />
        </Panel>
      )}
    </div>
  );
}

function clip(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
