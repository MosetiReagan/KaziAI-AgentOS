import { Link } from 'react-router-dom';
import type { AgentRun } from '../api/types.js';
import { useApp } from '../AppContext.js';
import { StatusPill } from '../components/StatusPill.js';
import { Button, ErrorNote, JsonBlock, Loading, Metric, Panel, Pill, Table } from '../components/ui.js';
import { useAsync, useTicker } from '../hooks/useAsync.js';
import { formatAge, formatCost, formatDuration, formatTokens, truncateId } from '../lib/format.js';
import { ACTIVE_STATES, isTerminalRunState } from '../lib/state.js';

interface OverviewData {
  runs: AgentRun[];
  total: number;
  pendingApprovals: number;
  agents: number;
  tools: number;
  providers: number;
  info: Record<string, unknown>;
}

export function OverviewPage() {
  const { client } = useApp();
  const state = useAsync<OverviewData>(async () => {
    const [runs, approvals, agents, tools, providers, info] = await Promise.all([
      client.listRuns({ limit: 200 }),
      client.listApprovals({ status: 'pending' }),
      client.listAgents(),
      client.listTools(),
      client.listProviders(),
      client.getInfo(),
    ]);
    return {
      runs: runs.items,
      total: runs.total,
      pendingApprovals: approvals.items.length,
      agents: agents.items.length,
      tools: tools.items.length,
      providers: providers.items.length,
      info: info.info as unknown as Record<string, unknown>,
    };
  }, [client]);
  const tick = useTicker(true, 5_000);

  if (state.loading && state.data === undefined) return <Loading label="Loading the runtime…" />;
  if (state.error) return <ErrorNote error={state.error} />;
  const data = state.data;
  if (data === undefined) return <Loading />;

  const active = data.runs.filter((run) => ACTIVE_STATES.includes(run.status));
  const waiting = data.runs.filter((run) => run.status === 'WAITING');
  const paused = data.runs.filter((run) => run.status === 'PAUSED');
  const completed = data.runs.filter((run) => run.status === 'COMPLETED');
  const failed = data.runs.filter((run) => run.status === 'FAILED' || run.status === 'TIMED_OUT');
  const finished = data.runs.filter((run) => isTerminalRunState(run.status));
  const successRate = finished.length === 0 ? undefined : completed.length / finished.length;
  const spend = data.runs.reduce((total, run) => total + run.usage.costUsd, 0);
  const tokens = data.runs.reduce((total, run) => total + run.usage.tokens.totalTokens, 0);
  const recoveries = data.runs.reduce((total, run) => total + run.usage.recoveryCount, 0);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Overview</h1>
          <p className="text-sm text-slate-500">
            {data.total} runs in this project · {ACTIVE_STATES.length} states are live, the rest are
            settled
          </p>
        </div>
        <Button onClick={state.reload}>Refresh</Button>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <Metric label="Active" value={active.length} tone={active.length > 0 ? 'info' : 'neutral'} />
        <Metric label="Waiting on a human" value={waiting.length + data.pendingApprovals} tone={data.pendingApprovals > 0 ? 'warn' : 'neutral'} />
        <Metric label="Paused" value={paused.length} tone={paused.length > 0 ? 'warn' : 'neutral'} />
        <Metric label="Completed" value={completed.length} tone="success" />
        <Metric label="Failed" value={failed.length} tone={failed.length > 0 ? 'danger' : 'neutral'} />
        <Metric
          label="Success rate"
          value={successRate === undefined ? '—' : `${Math.round(successRate * 100)}%`}
          hint={`${finished.length} settled runs`}
        />
        <Metric label="Spend (recent)" value={formatCost(spend)} />
        <Metric label="Tokens (recent)" value={formatTokens(tokens)} />
        <Metric label="Recoveries" value={recoveries} tone={recoveries > 0 ? 'warn' : 'neutral'} />
        <Metric label="Agents" value={data.agents} />
        <Metric label="Tools" value={data.tools} />
        <Metric label="Providers" value={data.providers} />
      </div>

      <Panel
        title="Live and waiting"
        subtitle="Runs the runtime is currently responsible for"
        actions={<Link className="text-xs text-sky-300 hover:underline" to="/live">Open live view</Link>}
      >
        <Table
          rows={[...active, ...waiting, ...paused].slice(0, 10)}
          rowKey={(run) => run.id}
          empty="Nothing is running right now."
          columns={[
            {
              key: 'run',
              header: 'Run',
              render: (run) => (
                <Link className="text-sky-300 hover:underline" to={`/runs/${run.id}`}>
                  {truncateId(run.id, 20)}
                </Link>
              ),
            },
            { key: 'status', header: 'Status', render: (run) => <StatusPill status={run.status} /> },
            { key: 'agent', header: 'Agent', render: (run) => <span className="text-slate-300">{run.agentId}</span> },
            { key: 'goal', header: 'Goal', render: (run) => <span className="text-slate-400">{truncate(run.goal, 60)}</span> },
            {
              key: 'usage',
              header: 'Steps / tools',
              render: (run) => (
                <span className="tabular text-slate-400">
                  {run.usage.steps} / {run.usage.toolCalls}
                </span>
              ),
            },
            {
              key: 'age',
              header: 'Updated',
              render: (run) => <span className="tabular text-slate-400">{formatAge(run.updatedAt, tick)}</span>,
            },
          ]}
        />
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Recent failures"
          actions={<Link className="text-xs text-sky-300 hover:underline" to="/failures">All failures</Link>}
        >
          <Table
            rows={failed.slice(0, 6)}
            rowKey={(run) => run.id}
            empty="No run has failed."
            columns={[
              {
                key: 'run',
                header: 'Run',
                render: (run) => (
                  <Link className="text-sky-300 hover:underline" to={`/runs/${run.id}`}>
                    {truncateId(run.id, 20)}
                  </Link>
                ),
              },
              { key: 'status', header: 'Status', render: (run) => <StatusPill status={run.status} /> },
              {
                key: 'error',
                header: 'Error',
                render: (run) => (
                  <span className="text-slate-400">{truncate(errorMessage(run), 70)}</span>
                ),
              },
              {
                key: 'when',
                header: 'When',
                render: (run) => <span className="tabular text-slate-400">{formatAge(run.finishedAt ?? run.updatedAt, tick)}</span>,
              },
            ]}
          />
        </Panel>

        <Panel title="Runtime" subtitle="What this deployment is configured to do">
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Pill tone="neutral">driver {String(data.info.driver ?? '—')}</Pill>
              <Pill tone="neutral">agents {data.agents}</Pill>
              <Pill tone="neutral">tools {data.tools}</Pill>
              <Pill tone="neutral">providers {data.providers}</Pill>
            </div>
            <JsonBlock value={data.info} maxHeight={220} />
            <p className="text-xs text-slate-500">
              Data directory {String(data.info.dataDir ?? '—')} · longest run{' '}
              {formatDuration(
                data.runs.reduce((max, run) => Math.max(max, run.usage.durationMs), 0),
              )}
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

function errorMessage(run: AgentRun): string {
  const error = run.error as { message?: unknown; code?: unknown } | undefined;
  if (typeof error?.message === 'string') return error.message;
  if (typeof error?.code === 'string') return error.code;
  return 'unknown error';
}
