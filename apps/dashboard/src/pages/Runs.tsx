import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import type { AgentRun } from '../api/types.js';
import { useApp } from '../AppContext.js';
import { StatusPill } from '../components/StatusPill.js';
import { Button, ErrorNote, Field, Loading, Panel, Table, inputClass } from '../components/ui.js';
import { useAsync, useTicker } from '../hooks/useAsync.js';
import { formatAge, formatCost, formatDuration, truncateId } from '../lib/format.js';
import { ACTIVE_STATES, TERMINAL_STATES } from '../lib/state.js';

export function RunsPage() {
  const { client } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [agentId, setAgentId] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<Error | undefined>(undefined);
  const tick = useTicker(true, 5_000);

  const runs = useAsync(
    () => client.listRuns({ status: status || undefined, agentId: agentId || undefined, limit: 100 }),
    [client, status, agentId],
  );
  const agents = useAsync(() => client.listAgents(), [client]);

  async function createRun(input: { agentId: string; goal: string; maxSteps?: number; maxCostUsd?: number }) {
    setCreating(true);
    setCreateError(undefined);
    try {
      const { run } = await client.createRun({
        agentId: input.agentId,
        goal: input.goal,
        ...(input.maxSteps === undefined && input.maxCostUsd === undefined
          ? {}
          : {
              limits: {
                ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
                ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
              },
            }),
      });
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Runs</h1>
          <p className="text-sm text-slate-500">
            Every run is durable; what you see here is read back from the store, not from memory.
          </p>
        </div>
        <Button onClick={runs.reload}>Refresh</Button>
      </header>

      <Panel title="New run" subtitle="Start an agent on a goal">
        <NewRunForm
          agents={(agents.data?.items ?? []).map((agent) => agent.id)}
          busy={creating}
          onSubmit={createRun}
        />
        {createError !== undefined && (
          <div className="mt-3">
            <ErrorNote error={createError} />
          </div>
        )}
      </Panel>

      <Panel title="All runs" subtitle={`${runs.data?.total ?? 0} matching`}>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="Status">
            <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">any</option>
              {[...ACTIVE_STATES, 'WAITING', ...TERMINAL_STATES].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent">
            <select className={inputClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">any</option>
              {(agents.data?.items ?? []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.id}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {runs.loading && runs.data === undefined && <Loading />}
        <ErrorNote error={runs.error} />
        <Table
          rows={runs.data?.items ?? []}
          rowKey={(run) => run.id}
          empty="No runs match this filter."
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
            { key: 'status', header: 'Status', render: (run) => <StatusPill status={run.status} /> },
            { key: 'goal', header: 'Goal', render: (run) => <span className="text-slate-300">{clip(run.goal)}</span> },
            { key: 'agent', header: 'Agent', render: (run) => <span className="text-slate-400">{run.agentId}</span> },
            { key: 'steps', header: 'Steps', render: (run) => <span className="tabular">{run.usage.steps}</span> },
            { key: 'tools', header: 'Tools', render: (run) => <span className="tabular">{run.usage.toolCalls}</span> },
            { key: 'recovery', header: 'Recov.', render: (run) => <span className="tabular">{run.usage.recoveryCount}</span> },
            { key: 'cost', header: 'Cost', render: (run) => <span className="tabular">{formatCost(run.usage.costUsd)}</span> },
            {
              key: 'duration',
              header: 'Duration',
              render: (run) => <span className="tabular">{formatDuration(run.usage.durationMs)}</span>,
            },
            {
              key: 'age',
              header: 'Created',
              render: (run) => <span className="tabular text-slate-400">{formatAge(run.createdAt, tick)}</span>,
            },
          ]}
        />
      </Panel>
    </div>
  );
}

function NewRunForm({
  agents,
  busy,
  onSubmit,
}: {
  agents: string[];
  busy: boolean;
  onSubmit: (input: { agentId: string; goal: string; maxSteps?: number; maxCostUsd?: number }) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0] ?? 'developer');
  const [goal, setGoal] = useState('');
  const [maxSteps, setMaxSteps] = useState('');
  const [maxCostUsd, setMaxCostUsd] = useState('');

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const steps = maxSteps.trim() === '' ? undefined : Number(maxSteps);
        const cost = maxCostUsd.trim() === '' ? undefined : Number(maxCostUsd);
        onSubmit({
          agentId,
          goal,
          ...(steps === undefined || Number.isNaN(steps) ? {} : { maxSteps: steps }),
          ...(cost === undefined || Number.isNaN(cost) ? {} : { maxCostUsd: cost }),
        });
      }}
    >
      <Field label="Agent">
        <select className={inputClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {(agents.length === 0 ? ['developer'] : agents).map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
      </Field>
      <div className="min-w-[280px] flex-1">
        <Field label="Goal">
          <input
            className={`${inputClass} w-full`}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Fix the failing tests in this repository."
            required
          />
        </Field>
      </div>
      <div className="w-24">
        <Field label="Max steps">
          <input
            className={`${inputClass} w-full`}
            value={maxSteps}
            onChange={(event) => setMaxSteps(event.target.value)}
            inputMode="numeric"
            placeholder="100"
          />
        </Field>
      </div>
      <div className="w-24">
        <Field label="Max $">
          <input
            className={`${inputClass} w-full`}
            value={maxCostUsd}
            onChange={(event) => setMaxCostUsd(event.target.value)}
            inputMode="decimal"
            placeholder="5"
          />
        </Field>
      </div>
      <Button type="submit" variant="primary" disabled={busy || goal.trim() === ''}>
        {busy ? 'Starting…' : 'Start run'}
      </Button>
    </form>
  );
}

function clip(value: string, length = 64): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function isApiError(error: unknown, code: string): boolean {
  return error instanceof ApiError && error.code === code;
}

export type { AgentRun };
