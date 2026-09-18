import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentRun, Checkpoint, FailureRecord } from '../api/types.js';
import { useApp } from '../AppContext.js';
import { StatusPill } from '../components/StatusPill.js';
import { TraceTree } from '../components/TraceTree.js';
import { Button, Empty, ErrorNote, JsonBlock, Loading, Panel, Pill, Table } from '../components/ui.js';
import { useAsync, useTicker } from '../hooks/useAsync.js';
import { formatAge, formatCost, formatDateTime, formatDuration, truncateId } from '../lib/format.js';
import { isTerminalRunState } from '../lib/state.js';

/** How many recent runs the aggregate views look at. */
const WINDOW = 25;

function useRecentRuns(): { runs: AgentRun[]; loading: boolean; error: Error | undefined; reload(): void } {
  const { client } = useApp();
  const state = useAsync(async () => {
    const page = await client.listRuns({ limit: WINDOW, orderBy: 'createdAt', direction: 'desc' });
    return page.items;
  }, [client]);
  return {
    runs: state.data ?? [],
    loading: state.loading && state.data === undefined,
    error: state.error,
    reload: state.reload,
  };
}

/**
 * Checkpoints across recent runs (spec §55). "Fork" always creates a new run;
 * the original is immutable, so an experiment cannot corrupt the evidence.
 */
export function CheckpointsPage() {
  const { client } = useApp();
  const recent = useRecentRuns();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [forked, setForked] = useState<string | undefined>(undefined);

  const checkpoints = useAsync(async () => {
    const results = await Promise.all(
      recent.runs.map(async (run) => {
        const page = await client.listCheckpoints(run.id);
        return page.items.map((checkpoint) => ({ checkpoint, run }));
      }),
    );
    return results.flat().sort((left, right) => right.checkpoint.createdAt - left.checkpoint.createdAt);
  }, [client, recent.runs.map((run) => run.id).join(',')]);

  async function fork(runId: string, checkpoint: Checkpoint) {
    setBusy(checkpoint.id);
    setError(undefined);
    try {
      const { run } = await client.fork(runId, { checkpointId: checkpoint.id });
      setForked(run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setBusy(undefined);
    }
  }

  if (recent.loading) return <Loading />;
  if (recent.error) return <ErrorNote error={recent.error} />;

  const rows = (checkpoints.data ?? []).slice(0, 200);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Checkpoints</h1>
          <p className="text-sm text-slate-500">
            The last {WINDOW} runs produced {rows.length} checkpoints. Resume and fork both start from
            a durable snapshot, never from process memory.
          </p>
        </div>
        <Button onClick={checkpoints.reload}>Refresh</Button>
      </header>

      <ErrorNote error={error} />
      {forked !== undefined && (
        <div className="rounded border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          Forked into a new run.{' '}
          <Link className="underline" to={`/runs/${forked}`}>
            Open {truncateId(forked, 24)}
          </Link>
        </div>
      )}

      <Panel title="Checkpoints" subtitle="Newest first">
        {checkpoints.loading && checkpoints.data === undefined && <Loading />}
        <ErrorNote error={checkpoints.error} />
        <Table
          rows={rows}
          rowKey={(row) => row.checkpoint.id}
          empty="No checkpoints in this window."
          columns={[
            {
              key: 'run',
              header: 'Run',
              render: (row) => (
                <Link className="text-sky-300 hover:underline" to={`/runs/${row.run.id}`}>
                  {truncateId(row.run.id, 20)}
                </Link>
              ),
            },
            { key: 'status', header: 'Status', render: (row) => <StatusPill status={row.run.status} /> },
            { key: 'seq', header: 'Seq', render: (row) => <span className="tabular">#{row.checkpoint.sequence}</span> },
            { key: 'label', header: 'Label', render: (row) => <span className="text-slate-400">{row.checkpoint.label ?? '—'}</span> },
            { key: 'state', header: 'State v', render: (row) => <span className="tabular">{row.checkpoint.stateVersion}</span> },
            {
              key: 'plan',
              header: 'Plan',
              render: (row) => <span className="tabular">{row.checkpoint.state.plan?.steps.length ?? 0} steps</span>,
            },
            {
              key: 'at',
              header: 'Created',
              render: (row) => <span className="tabular text-slate-500">{formatDateTime(row.checkpoint.createdAt)}</span>,
            },
            {
              key: 'actions',
              header: '',
              render: (row) => (
                <div className="flex items-center gap-1">
                  <Button
                    disabled={busy !== undefined}
                    onClick={() => {
                      void fork(row.run.id, row.checkpoint);
                    }}
                  >
                    Fork
                  </Button>
                  <Button
                    disabled={busy !== undefined}
                    onClick={() => {
                      void navigator.clipboard?.writeText(row.checkpoint.id);
                    }}
                  >
                    Copy id
                  </Button>
                </div>
              ),
            },
          ]}
        />
      </Panel>

      {checkpoints.data !== undefined && checkpoints.data.length > 0 && (
        <Panel title="Latest checkpoint state" subtitle={checkpoints.data[0]?.checkpoint.id}>
          <JsonBlock value={checkpoints.data[0]?.checkpoint.state ?? {}} maxHeight={380} />
        </Panel>
      )}
    </div>
  );
}

/** Failures across recent runs, with the recovery that followed each one. */
export function FailuresPage() {
  const { client } = useApp();
  const recent = useRecentRuns();
  const state = useAsync(async () => {
    const results = await Promise.all(
      recent.runs.map(async (run) => {
        const [failures, recoveries] = await Promise.all([
          client.listFailures(run.id),
          client.listRecoveries(run.id),
        ]);
        return { failures: failures.items, recoveries: recoveries.items, run };
      }),
    );
    return results.flatMap((entry) =>
      entry.failures.map((failure) => ({
        failure,
        run: entry.run,
        recovery: entry.recoveries.find((attempt) => attempt.failureId === failure.id),
      })),
    );
  }, [client, recent.runs.map((run) => run.id).join(',')]);

  if (recent.loading) return <Loading />;
  const rows = (state.data ?? []).sort((left, right) => right.failure.at - left.failure.at).slice(0, 200);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Failures</h1>
          <p className="text-sm text-slate-500">
            Nothing is swallowed: every failure is classified, persisted and either recovered or
            terminal. Showing the last {WINDOW} runs.
          </p>
        </div>
        <Button onClick={state.reload}>Refresh</Button>
      </header>

      <Panel title="Failures" subtitle={`${rows.length} in this window`}>
        {state.loading && state.data === undefined && <Loading />}
        <ErrorNote error={state.error} />
        <Table
          rows={rows}
          rowKey={(row) => row.failure.id}
          empty="No failure was recorded in this window."
          columns={[
            {
              key: 'run',
              header: 'Run',
              render: (row) => (
                <Link className="text-sky-300 hover:underline" to={`/runs/${row.run.id}`}>
                  {truncateId(row.run.id, 18)}
                </Link>
              ),
            },
            { key: 'code', header: 'Code', render: (row) => <span className="text-rose-200">{row.failure.code}</span> },
            { key: 'category', header: 'Category', render: (row) => <Pill>{row.failure.category}</Pill> },
            { key: 'tool', header: 'Tool', render: (row) => <span className="font-mono text-xs text-slate-400">{row.failure.toolId ?? '—'}</span> },
            { key: 'message', header: 'Message', render: (row) => <span className="text-slate-300">{clip(row.failure.message)}</span> },
            {
              key: 'flags',
              header: 'Flags',
              render: (row) => (
                <span className="flex gap-1">
                  {row.failure.retryable && <Pill tone="info">retryable</Pill>}
                  {row.failure.terminal && <Pill tone="danger">terminal</Pill>}
                </span>
              ),
            },
            {
              key: 'recovery',
              header: 'Recovery',
              render: (row) => (
                <span className="text-slate-400">
                  {row.recovery === undefined
                    ? 'none'
                    : `${row.recovery.strategy} ${row.recovery.success ? '(applied)' : '(failed)'}`}
                </span>
              ),
            },
            { key: 'at', header: 'At', render: (row) => <span className="tabular text-slate-500">{formatDateTime(row.failure.at)}</span> },
          ]}
        />
      </Panel>
    </div>
  );
}

/** Traces for recent runs, with an inline tree for the selected one. */
export function TracesPage() {
  const { client } = useApp();
  const tick = useTicker(true, 5_000);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const recent = useRecentRuns();
  const trace = useAsync(
    async () => (selected === undefined ? undefined : (await client.getTrace(selected)).trace),
    [client, selected],
  );
  const active = selected ?? recent.runs[0]?.id;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-slate-100">Traces</h1>
        <p className="text-sm text-slate-500">
          One tree per run: plan, steps, tool calls, verification, recovery and checkpoints, in the
          order the runtime executed them.
        </p>
      </header>

      <Panel title="Recent runs" subtitle="Select one to open its trace">
        {recent.loading && <Loading />}
        <Table
          rows={recent.runs}
          rowKey={(run) => run.id}
          empty="No runs yet."
          onRowClick={(run) => setSelected(run.id)}
          columns={[
            {
              key: 'id',
              header: 'Run',
              render: (run) => <span className="text-sky-300">{truncateId(run.id, 22)}</span>,
            },
            { key: 'status', header: 'Status', render: (run) => <StatusPill status={run.status} /> },
            { key: 'goal', header: 'Goal', render: (run) => <span className="text-slate-400">{clip(run.goal, 48)}</span> },
            { key: 'steps', header: 'Steps', render: (run) => <span className="tabular">{run.usage.steps}</span> },
            { key: 'cost', header: 'Cost', render: (run) => <span className="tabular">{formatCost(run.usage.costUsd)}</span> },
            {
              key: 'age',
              header: 'Age',
              render: (run) => <span className="tabular text-slate-500">{formatAge(run.createdAt, tick)}</span>,
            },
          ]}
        />
      </Panel>

      <Panel
        title="Trace"
        subtitle={active === undefined ? 'No run selected' : `run ${active}`}
        actions={
          active === undefined ? undefined : (
            <Link className="text-xs text-sky-300 hover:underline" to={`/runs/${active}`}>
              Open run
            </Link>
          )
        }
      >
        {active === undefined && <Empty>Pick a run above.</Empty>}
        {active !== undefined && trace.loading && trace.data === undefined && <Loading />}
        <ErrorNote error={trace.error} />
        {trace.data !== undefined && (
          <>
            <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
              <Pill>steps {trace.data.summary.steps}</Pill>
              <Pill>tools {trace.data.summary.toolCalls}</Pill>
              <Pill tone={trace.data.summary.failures > 0 ? 'danger' : 'neutral'}>
                failures {trace.data.summary.failures}
              </Pill>
              <Pill tone={trace.data.summary.recoveries > 0 ? 'warn' : 'neutral'}>
                recoveries {trace.data.summary.recoveries}
              </Pill>
              <Pill>duration {formatDuration(trace.data.summary.durationMs)}</Pill>
              <Pill>tokens {trace.data.summary.tokens}</Pill>
              <Pill>{formatCost(trace.data.summary.costUsd)}</Pill>
            </div>
            <TraceTree nodes={trace.data.nodes} />
          </>
        )}
      </Panel>
    </div>
  );
}

/** Runs that ended, for the overview's "settled" language. */
export function isSettled(run: AgentRun): boolean {
  return isTerminalRunState(run.status);
}

export type { FailureRecord };

function clip(value: string, length = 64): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
