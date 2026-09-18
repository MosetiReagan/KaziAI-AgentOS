import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../AppContext.js';
import { BudgetBars } from '../components/BudgetBars.js';
import { StatusPill } from '../components/StatusPill.js';
import { Timeline } from '../components/Timeline.js';
import { TraceTree } from '../components/TraceTree.js';
import {
  Button,
  Empty,
  ErrorNote,
  JsonBlock,
  Loading,
  Metric,
  Panel,
  Pill,
  Table,
  Tabs,
} from '../components/ui.js';
import { useAsync, useTicker } from '../hooks/useAsync.js';
import { useRunStream } from '../hooks/useRunStream.js';
import {
  formatAge,
  formatCost,
  formatDateTime,
  formatDuration,
  formatTokens,
  truncateId,
} from '../lib/format.js';
import { isTerminalRunState, phaseOf } from '../lib/state.js';
import { summarizeEvents, toTimeline, toolStats } from '../lib/timeline.js';

type Tab =
  | 'timeline'
  | 'steps'
  | 'trace'
  | 'checkpoints'
  | 'journal'
  | 'failures'
  | 'recoveries'
  | 'decisions'
  | 'artifacts'
  | 'state';

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { client } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('timeline');
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<Error | undefined>(undefined);

  const runState = useAsync(() => client.getRun(id as string), [client, id]);
  const stream = useRunStream(client, id);
  const run = runState.data?.run;
  const terminal = run !== undefined && isTerminalRunState(run.status);
  const tick = useTicker(!terminal, 1_000);

  const detail = useAsync(
    async () => {
      if (id === undefined) throw new Error('missing run id');
      const [steps, checkpoints, journal, failures, recoveries, decisions, artifacts, trace] =
        await Promise.all([
          client.listSteps(id),
          client.listCheckpoints(id),
          client.listJournal(id),
          client.listFailures(id),
          client.listRecoveries(id),
          client.listDecisions(id),
          client.listArtifacts(id),
          client.getTrace(id),
        ]);
      return {
        steps: steps.items,
        checkpoints: checkpoints.items,
        journal: journal.items,
        failures: failures.items,
        recoveries: recoveries.items,
        decisions: decisions.items,
        artifacts: artifacts.items,
        trace: trace.trace,
      };
    },
    [client, id, terminal],
  );

  const entries = useMemo(() => toTimeline(stream.events), [stream.events]);
  const stats = useMemo(() => summarizeEvents(stream.events), [stream.events]);
  const tools = useMemo(() => toolStats(stream.events), [stream.events]);
  const currentTool = useMemo(() => runningTool(stream.events), [stream.events]);

  async function act(action: 'pause' | 'resume' | 'cancel' | 'retry' | 'checkpoint') {
    if (id === undefined) return;
    setBusy(action);
    setActionError(undefined);
    try {
      if (action === 'checkpoint') await client.checkpoint(id);
      else await client.runAction(id, action);
      runState.reload();
      detail.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(undefined);
    }
  }

  async function fork() {
    if (id === undefined) return;
    setBusy('fork');
    setActionError(undefined);
    try {
      const { run: forked } = await client.fork(id, {});
      navigate(`/runs/${forked.id}`);
    } catch (error) {
      setActionError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy(undefined);
    }
  }

  if (runState.loading && run === undefined) return <Loading label="Loading run…" />;
  if (runState.error) return <ErrorNote error={runState.error} />;
  if (run === undefined) return <Empty>Run not found.</Empty>;

  const elapsed = run.usage.durationMs + (run.startedAt !== undefined && !terminal ? tick - run.updatedAt : 0);
  const currentStep = detail.data?.steps.filter((step) => step.status === 'running').at(-1);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusPill status={run.status} />
            <span className="font-mono text-sm text-slate-400">{run.id}</span>
            {run.parentRunId !== undefined && (
              <Link className="text-xs text-sky-300 hover:underline" to={`/runs/${run.parentRunId}`}>
                forked from {truncateId(run.parentRunId, 16)}
              </Link>
            )}
          </div>
          <h1 className="mt-1 max-w-3xl text-base font-medium text-slate-100">{run.goal}</h1>
          <p className="text-xs text-slate-500">
            {run.agentId} · {run.config.provider}/{run.config.model} · started{' '}
            {formatDateTime(run.startedAt ?? run.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => act('pause')} disabled={busy !== undefined || terminal}>
            Pause
          </Button>
          <Button onClick={() => act('resume')} disabled={busy !== undefined || (!terminal && run.status !== 'PAUSED' && run.status !== 'WAITING')}>
            Resume
          </Button>
          <Button onClick={() => act('retry')} disabled={busy !== undefined || !terminal} variant="primary">
            Retry
          </Button>
          <Button onClick={() => act('checkpoint')} disabled={busy !== undefined || terminal}>
            Checkpoint
          </Button>
          <Button onClick={fork} disabled={busy !== undefined}>
            Fork
          </Button>
          <Button onClick={() => act('cancel')} disabled={busy !== undefined || terminal} variant="danger">
            Cancel
          </Button>
          <Button
            onClick={() => {
              runState.reload();
              detail.reload();
              stream.refresh();
            }}
          >
            Refresh
          </Button>
        </div>
      </header>

      {actionError !== undefined && <ErrorNote error={actionError} />}
      {stream.error !== undefined && (
        <ErrorNote error={new Error(`The live stream stopped: ${stream.error.message}`)} />
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Metric label="Phase" value={phaseOf(run.status)} hint={run.status} />
        <Metric
          label="Current step"
          value={currentStep === undefined ? '—' : `#${currentStep.index}`}
          hint={currentStep?.description}
        />
        <Metric label="Current tool" value={currentTool ?? '—'} hint={run.currentStepId} />
        <Metric label="Elapsed" value={formatDuration(elapsed)} hint={`budget ${formatDuration((run.limits.maxDurationSeconds ?? 0) * 1_000)}`} />
        <Metric
          label="Tokens"
          value={formatTokens(run.usage.tokens.totalTokens)}
          hint={`${run.usage.modelCalls} model calls`}
          tone={ratioTone(run.usage.tokens.totalTokens, run.limits.maxTokens)}
        />
        <Metric
          label="Cost"
          value={formatCost(run.usage.costUsd)}
          hint={run.limits.maxCostUsd === undefined ? 'unlimited' : `${formatCost(run.limits.maxCostUsd)} budget`}
          tone={ratioTone(run.usage.costUsd, run.limits.maxCostUsd)}
        />
        <Metric label="Steps" value={`${run.usage.steps} / ${run.limits.maxSteps ?? '∞'}`} />
        <Metric label="Tool calls" value={`${run.usage.toolCalls} / ${run.limits.maxToolCalls ?? '∞'}`} />
        <Metric label="Recoveries" value={run.usage.recoveryCount} tone={run.usage.recoveryCount > 0 ? 'warn' : 'neutral'} />
        <Metric label="Checkpoints" value={run.usage.checkpointCount} />
        <Metric label="Events" value={stats.events} hint={stream.connected ? (stream.ended ? 'stream closed' : 'live') : 'replaying'} />
        <Metric label="Denied actions" value={stats.denials} tone={stats.denials > 0 ? 'danger' : 'neutral'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <Panel
          title="Timeline"
          subtitle="Operational metadata only — AgentOS never records hidden reasoning"
          actions={
            <span className="text-[11px] text-slate-500">
              {stream.connected ? (stream.ended ? 'stream ended' : 'live') : 'connecting…'}
            </span>
          }
        >
          <Tabs
            tabs={[
              { id: 'timeline', label: 'Timeline' },
              { id: 'steps', label: 'Steps', badge: detail.data?.steps.length },
              { id: 'trace', label: 'Trace' },
              { id: 'checkpoints', label: 'Checkpoints', badge: detail.data?.checkpoints.length },
              { id: 'journal', label: 'Journal', badge: detail.data?.journal.length },
              { id: 'failures', label: 'Failures', badge: detail.data?.failures.length },
              { id: 'recoveries', label: 'Recoveries', badge: detail.data?.recoveries.length },
              { id: 'decisions', label: 'Decisions', badge: detail.data?.decisions.length },
              { id: 'artifacts', label: 'Artifacts', badge: detail.data?.artifacts.length },
              { id: 'state', label: 'State' },
            ]}
            active={tab}
            onChange={setTab}
          />
          <div className="pt-3">
            {tab === 'timeline' && <Timeline entries={entries} />}
            {tab === 'steps' && (
              <Table
                rows={detail.data?.steps ?? []}
                rowKey={(step) => step.id}
                empty="No steps recorded."
                columns={[
                  { key: 'index', header: '#', render: (step) => <span className="tabular">{step.index}</span> },
                  { key: 'phase', header: 'Phase', render: (step) => <span className="text-slate-400">{step.phase}</span> },
                  { key: 'description', header: 'Description', render: (step) => <span className="text-slate-300">{step.description}</span> },
                  { key: 'status', header: 'Status', render: (step) => <span className="text-slate-400">{step.status}</span> },
                  { key: 'tool', header: 'Tool', render: (step) => <span className="text-slate-400">{step.toolId ?? '—'}</span> },
                  {
                    key: 'duration',
                    header: 'Duration',
                    render: (step) => <span className="tabular">{formatDuration(step.durationMs)}</span>,
                  },
                ]}
              />
            )}
            {tab === 'trace' && (
              <>
                {detail.data?.trace === undefined ? (
                  <Empty>No trace was recorded.</Empty>
                ) : (
                  <>
                    <div className="mb-3 flex flex-wrap gap-2 text-[11px]">
                      <Pill>steps {detail.data.trace.summary.steps}</Pill>
                      <Pill>tools {detail.data.trace.summary.toolCalls}</Pill>
                      <Pill tone={detail.data.trace.summary.failures > 0 ? 'danger' : 'neutral'}>
                        failures {detail.data.trace.summary.failures}
                      </Pill>
                      <Pill tone={detail.data.trace.summary.recoveries > 0 ? 'warn' : 'neutral'}>
                        recoveries {detail.data.trace.summary.recoveries}
                      </Pill>
                      <Pill>checkpoints {detail.data.trace.summary.checkpoints}</Pill>
                      <Pill>{formatDuration(detail.data.trace.summary.durationMs)}</Pill>
                      <Pill>{formatCost(detail.data.trace.summary.costUsd)}</Pill>
                    </div>
                    <TraceTree nodes={detail.data.trace.nodes} />
                  </>
                )}
              </>
            )}
            {tab === 'checkpoints' && (
              <div className="space-y-3">
                {(detail.data?.checkpoints ?? []).length === 0 && <Empty>No checkpoints yet.</Empty>}
                {(detail.data?.checkpoints ?? []).map((checkpoint) => (
                  <div key={checkpoint.id} className="rounded border border-[#1e2740] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm text-slate-200">
                        <span className="tabular">#{checkpoint.sequence}</span>
                        <span className="font-mono text-xs text-slate-500">{checkpoint.id}</span>
                        {checkpoint.label !== undefined && <Pill>{checkpoint.label}</Pill>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-slate-500">
                          {formatDateTime(checkpoint.createdAt)} · v{checkpoint.stateVersion}
                        </span>
                        <Button
                          onClick={() => {
                            if (id === undefined) return;
                            setBusy('fork');
                            void client
                              .fork(id, { checkpointId: checkpoint.id })
                              .then(({ run: forked }) => navigate(`/runs/${forked.id}`))
                              .catch((error: unknown) =>
                                setActionError(error instanceof Error ? error : new Error(String(error))),
                              )
                              .finally(() => setBusy(undefined));
                          }}
                          disabled={busy !== undefined}
                        >
                          Fork from here
                        </Button>
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      plan {checkpoint.state.plan?.steps.length ?? 0} steps ·
                      observations {checkpoint.state.observations?.length ?? 0} ·
                      context keys {Object.keys(checkpoint.state.context ?? {}).length}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {tab === 'journal' && (
              <Table
                rows={detail.data?.journal ?? []}
                rowKey={(row) => row.id}
                empty="No actions were journalled."
                columns={[
                  { key: 'id', header: 'Action', render: (row) => <span className="font-mono text-xs">{row.actionId}</span> },
                  { key: 'tool', header: 'Tool', render: (row) => <span className="text-slate-300">{row.toolId}</span> },
                  { key: 'status', header: 'Status', render: (row) => <span className="text-slate-400">{row.status}</span> },
                  { key: 'success', header: 'Result', render: (row) => (row.success ? 'ok' : 'failed') },
                  { key: 'duration', header: 'Duration', render: (row) => <span className="tabular">{formatDuration(row.durationMs)}</span> },
                  { key: 'at', header: 'At', render: (row) => <span className="tabular text-slate-500">{formatDateTime(row.at)}</span> },
                ]}
              />
            )}
            {tab === 'failures' && (
              <Table
                rows={detail.data?.failures ?? []}
                rowKey={(row) => row.id}
                empty="No failures. That is not the same as no attempts — see the journal."
                columns={[
                  { key: 'code', header: 'Code', render: (row) => <span className="text-rose-200">{row.code}</span> },
                  { key: 'category', header: 'Category', render: (row) => <span className="text-slate-400">{row.category}</span> },
                  { key: 'message', header: 'Message', render: (row) => <span className="text-slate-300">{row.message}</span> },
                  { key: 'tool', header: 'Tool', render: (row) => <span className="text-slate-400">{row.toolId ?? '—'}</span> },
                  { key: 'retryable', header: 'Retryable', render: (row) => (row.retryable ? 'yes' : 'no') },
                  { key: 'terminal', header: 'Terminal', render: (row) => (row.terminal ? 'yes' : 'no') },
                  { key: 'at', header: 'At', render: (row) => <span className="tabular text-slate-500">{formatDateTime(row.at)}</span> },
                ]}
              />
            )}
            {tab === 'recoveries' && (
              <Table
                rows={detail.data?.recoveries ?? []}
                rowKey={(row) => row.id}
                empty="No recovery was attempted."
                columns={[
                  { key: 'attempt', header: '#', render: (row) => <span className="tabular">{row.attempt}</span> },
                  { key: 'strategy', header: 'Strategy', render: (row) => <span className="text-slate-200">{row.strategy}</span> },
                  { key: 'success', header: 'Applied', render: (row) => (row.success ? 'yes' : 'no') },
                  { key: 'at', header: 'At', render: (row) => <span className="tabular text-slate-500">{formatDateTime(row.at)}</span> },
                ]}
              />
            )}
            {tab === 'decisions' && (
              <Table
                rows={detail.data?.decisions ?? []}
                rowKey={(row) => row.id}
                empty="No policy was consulted."
                columns={[
                  { key: 'tool', header: 'Tool', render: (row) => <span className="text-slate-300">{row.toolId}</span> },
                  { key: 'outcome', header: 'Decision', render: (row) => <span className="text-slate-200">{row.outcome}</span> },
                  { key: 'risk', header: 'Risk', render: (row) => <span className="text-slate-400">{row.risk}</span> },
                  { key: 'rule', header: 'Rule', render: (row) => <span className="font-mono text-xs text-slate-400">{row.ruleId}</span> },
                  { key: 'reason', header: 'Reason', render: (row) => <span className="text-slate-400">{row.reason}</span> },
                ]}
              />
            )}
            {tab === 'artifacts' && (
              <Table
                rows={detail.data?.artifacts ?? []}
                rowKey={(row) => row.id}
                empty="This run produced no artifacts."
                columns={[
                  { key: 'name', header: 'Name', render: (row) => <span className="text-slate-200">{row.name}</span> },
                  { key: 'mime', header: 'Type', render: (row) => <span className="text-slate-400">{row.mimeType}</span> },
                  { key: 'sha', header: 'Digest', render: (row) => <span className="font-mono text-[11px] text-slate-500">{row.sha256.slice(0, 16)}…</span> },
                  { key: 'size', header: 'Size', render: (row) => <span className="tabular">{row.size}</span> },
                ]}
              />
            )}
            {tab === 'state' && <StateView runId={run.id} version={run.stateVersion} reloadKey={detail.data?.steps.length ?? 0} />}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Budget" subtitle="Enforced by the runtime before every step">
            <BudgetBars run={run} />
          </Panel>
          <Panel title="Tools used">
            <Table
              rows={tools}
              rowKey={(row) => row.toolId}
              empty="No tool has run yet."
              columns={[
                { key: 'tool', header: 'Tool', render: (row) => <span className="text-slate-300">{row.toolId}</span> },
                { key: 'calls', header: 'Calls', render: (row) => <span className="tabular">{row.calls}</span> },
                { key: 'fail', header: 'Failed', render: (row) => <span className="tabular">{row.failures}</span> },
                { key: 'denied', header: 'Denied', render: (row) => <span className="tabular">{row.denials}</span> },
                { key: 'ms', header: 'Total', render: (row) => <span className="tabular">{formatDuration(row.totalMs)}</span> },
              ]}
            />
          </Panel>
          <Panel title="Run config" subtitle="Snapshotted at creation, so a rerun is reproducible">
            <JsonBlock value={run.config} maxHeight={260} />
            <p className="mt-2 text-[11px] text-slate-500">
              workspace {run.workspaceDir} · trace {run.traceId} · state v{run.stateVersion} · updated{' '}
              {formatAge(run.updatedAt, tick)} ago
            </p>
          </Panel>
          {run.error !== undefined && (
            <Panel title="Terminal error">
              <JsonBlock value={run.error} maxHeight={200} />
            </Panel>
          )}
          {detail.data !== undefined && detail.data.artifacts.length === 0 && detail.data.checkpoints.length === 0 && !terminal && (
            <Panel title="Durability">
              <p className="text-xs text-slate-500">
                This run has no checkpoint yet. A worker that dies before the first checkpoint restarts
                from the beginning; after it, recovery resumes from the last one.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

/** The tool of the most recent `tool.started` without a matching completion. */
function runningTool(events: { type: string; data: Record<string, unknown> }[]): string | undefined {
  const open = new Map<string, string>();
  let last: string | undefined;
  for (const event of events) {
    const toolId = typeof event.data.toolId === 'string' ? event.data.toolId : undefined;
    if (toolId === undefined) continue;
    if (event.type === 'tool.started') {
      open.set(toolId, toolId);
      last = toolId;
    } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      open.delete(toolId);
      if (last === toolId) last = undefined;
    }
  }
  return last;
}

function ratioTone(used: number, limit: number | undefined): 'neutral' | 'warn' | 'danger' {
  if (limit === undefined || limit <= 0) return 'neutral';
  const ratio = used / limit;
  if (ratio >= 1) return 'danger';
  if (ratio >= 0.75) return 'warn';
  return 'neutral';
}

function StateView({
  runId,
  version,
  reloadKey,
}: {
  runId: string;
  version: number;
  reloadKey: number;
}) {
  const { client } = useApp();
  const state = useAsync(() => client.getState(runId), [client, runId, reloadKey, version]);
  if (state.loading && state.data === undefined) return <Loading />;
  if (state.error) return <ErrorNote error={state.error} />;
  const value = state.data?.state;
  if (value === undefined) return <Empty>No state was persisted.</Empty>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-[11px]">
        <Pill>{value.status}</Pill>
        <Pill>state v{value.stateVersion}</Pill>
        <Pill>updated {formatDateTime(value.updatedAt)}</Pill>
        <Pill>plan {value.plan?.steps.length ?? 0} steps</Pill>
        <Pill>observations {value.observations.length}</Pill>
      </div>
      {value.plan !== undefined && (
        <Table
          rows={value.plan.steps}
          rowKey={(step) => step.id}
          empty="The plan is empty."
          columns={[
            { key: 'index', header: '#', render: (step) => <span className="tabular">{step.index}</span> },
            { key: 'description', header: 'Step', render: (step) => <span className="text-slate-300">{step.description}</span> },
            { key: 'status', header: 'Status', render: (step) => <span className="text-slate-400">{step.status}</span> },
          ]}
        />
      )}
      <JsonBlock value={value.observations} maxHeight={260} />
      <JsonBlock value={value.context} maxHeight={260} />
    </div>
  );
}
