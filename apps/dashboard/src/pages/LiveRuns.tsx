import { Link } from 'react-router-dom';
import { useApp } from '../AppContext.js';
import { StatusPill } from '../components/StatusPill.js';
import { Button, ErrorNote, Loading, Panel, Table } from '../components/ui.js';
import { useAsync, useTicker } from '../hooks/useAsync.js';
import { formatAge, formatCost, formatDuration, truncateId } from '../lib/format.js';
import { ACTIVE_STATES, phaseOf } from '../lib/state.js';

/**
 * Live runs, refreshed on a timer. This view is deliberately read-only: the
 * controls belong on the run itself, where the surrounding state is visible.
 */
export function LiveRunsPage() {
  const { client } = useApp();
  const tick = useTicker(true, 2_000);
  const state = useAsync(async () => {
    const page = await client.listRuns({ limit: 100 });
    return page.items;
  }, [client]);

  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error) return <ErrorNote error={state.error} />;
  const live = (state.data ?? []).filter(
    (run) => ACTIVE_STATES.includes(run.status) || run.status === 'WAITING' || run.status === 'PAUSED',
  );

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Live runs</h1>
          <p className="text-sm text-slate-500">
            {live.length} run{live.length === 1 ? '' : 's'} in flight across this project
          </p>
        </div>
        <Button onClick={state.reload}>Refresh</Button>
      </header>

      <Panel title="In flight" subtitle="Elapsed time and budget as of the last refresh">
        <Table
          rows={live}
          rowKey={(run) => run.id}
          empty="No run is executing right now."
          columns={[
            {
              key: 'id',
              header: 'Run',
              render: (run) => (
                <Link className="text-sky-300 hover:underline" to={`/runs/${run.id}`}>
                  {truncateId(run.id, 22)}
                </Link>
              ),
            },
            { key: 'status', header: 'State', render: (run) => <StatusPill status={run.status} /> },
            { key: 'phase', header: 'Phase', render: (run) => <span className="text-slate-400">{phaseOf(run.status)}</span> },
            { key: 'step', header: 'Step', render: (run) => <span className="tabular">{run.usage.steps}</span> },
            { key: 'tools', header: 'Tool calls', render: (run) => <span className="tabular">{run.usage.toolCalls}</span> },
            { key: 'tokens', header: 'Tokens', render: (run) => <span className="tabular">{run.usage.tokens.totalTokens}</span> },
            { key: 'cost', header: 'Cost', render: (run) => <span className="tabular">{formatCost(run.usage.costUsd)}</span> },
            {
              key: 'elapsed',
              header: 'Elapsed',
              render: (run) => <span className="tabular">{formatDuration(run.usage.durationMs)}</span>,
            },
            {
              key: 'updated',
              header: 'Last event',
              render: (run) => <span className="tabular text-slate-400">{formatAge(run.updatedAt, tick)} ago</span>,
            },
          ]}
        />
      </Panel>
    </div>
  );
}
