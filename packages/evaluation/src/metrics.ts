import type { RunUsage } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'incomplete';

/**
 * Everything the runtime can say about one run, gathered from durable records
 * rather than from process memory: metrics must survive a worker restart.
 */
export interface RunMetrics {
  runId: string;
  organizationId: string;
  projectId: string;
  agentId: string;
  status: string;
  outcome: RunOutcome;
  taskSuccess: boolean;
  durationMs: number;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  deniedToolCalls: number;
  awaitingApprovalCalls: number;
  replayedToolCalls: number;
  recoveryCount: number;
  recoverySuccesses: number;
  recoveryFailureCount: number;
  policyViolations: number;
  permissionDenials: number;
  humanApprovals: number;
  approvalsDenied: number;
  checkpointCount: number;
  failureCount: number;
  terminalFailureCount: number;
  interruptions: number;
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number };
  costUsd: number;
  modelTransitions: number;
  usage: RunUsage;
  startedAt?: number;
  finishedAt?: number;
}

export interface MetricsCollectorStore {
  runs: Pick<AgentOSStore['runs'], 'get'>;
  events: Pick<AgentOSStore['events'], 'list'>;
  actions: Pick<AgentOSStore['actions'], 'list'>;
  checkpoints: Pick<AgentOSStore['checkpoints'], 'list'>;
  approvals: Pick<AgentOSStore['approvals'], 'list'>;
  usage: Pick<AgentOSStore['usage'], 'listByRun'>;
  counters: Pick<AgentOSStore['counters'], 'getUsage'>;
  failures: Pick<AgentOSStore['failures'], 'list'>;
  recoveries: Pick<AgentOSStore['recoveries'], 'list'>;
  invocations: Pick<AgentOSStore['invocations'], 'list'>;
  policyDecisions: Pick<AgentOSStore['policyDecisions'], 'list'>;
}

export interface MetricsCollectorOptions {
  /** Statuses that count as "did not finish", e.g. an operator cancelling. */
  onMissingRun?: 'throw' | 'empty';
}

/**
 * Reads a run's durable history and turns it into metrics. Nothing here trusts
 * a caller-supplied summary: every number comes from a persisted record.
 */
export class MetricsCollector {
  constructor(
    private readonly store: MetricsCollectorStore,
    private readonly options: MetricsCollectorOptions = {},
  ) {}

  async collect(runId: string): Promise<RunMetrics> {
    const run = await this.store.runs.get(runId);
    if (!run) {
      if (this.options.onMissingRun === 'empty') return emptyMetrics(runId);
      throw new Error(`Cannot collect metrics: run ${runId} does not exist`);
    }

    const [events, actions, checkpoints, approvals, failures, recoveries, invocations, policyDecisions, usageRecords] =
      await Promise.all([
        this.store.events.list(runId),
        this.store.actions.list(runId),
        this.store.checkpoints.list(runId),
        this.store.approvals.list({ runId }),
        this.store.failures.list(runId),
        this.store.recoveries.list(runId),
        this.store.invocations.list(runId),
        this.store.policyDecisions.list(runId),
        this.store.usage.listByRun(runId),
      ]);

    const counters = (await this.store.counters.getUsage(runId)) ?? run.usage;
    const outcome = classifyOutcome(run.status);
    const committed = actions.filter((entry) => entry.status === 'succeeded' || entry.status === 'failed');

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let costUsd = 0;
    let modelTransitions = 0;
    let previousModel: string | undefined;
    for (const record of usageRecords) {
      inputTokens += record.inputTokens;
      outputTokens += record.outputTokens;
      cachedInputTokens += record.cachedInputTokens ?? 0;
      costUsd += record.costUsd ?? 0;
      const key = `${record.provider}/${record.model}`;
      if (previousModel !== undefined && previousModel !== key) modelTransitions += 1;
      previousModel = key;
    }
    // Model usage records are the source of truth; fall back to the run's own
    // counter when the run predates usage recording.
    if (usageRecords.length === 0) {
      inputTokens = counters.tokens.inputTokens;
      outputTokens = counters.tokens.outputTokens;
      costUsd = counters.costUsd;
    }

    return {
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      agentId: run.agentId,
      status: run.status,
      outcome,
      taskSuccess: outcome === 'succeeded',
      durationMs: durationOf(run.startedAt, run.finishedAt, run.createdAt, run.updatedAt),
      steps: counters.steps,
      modelCalls: counters.modelCalls,
      toolCalls: committed.length > 0 ? committed.length : counters.toolCalls,
      failedToolCalls: failures.filter((failure) => failure.category === 'tool').length,
      deniedToolCalls: policyDecisions.filter((decision) => decision.outcome === 'DENY').length,
      awaitingApprovalCalls: policyDecisions.filter((decision) => decision.outcome === 'REQUIRE_APPROVAL').length,
      replayedToolCalls: invocations.filter((invocation) => invocation.status === 'already_committed').length,
      recoveryCount: counters.recoveryCount,
      recoverySuccesses: recoveries.filter((attempt) => attempt.success).length,
      recoveryFailureCount: recoveries.filter((attempt) => !attempt.success).length,
      policyViolations: policyDecisions.filter((decision) => decision.outcome === 'DENY').length,
      // A tool that refuses for lack of a granted capability is a denial the
      // run must be able to see, even though no policy rule produced it.
      permissionDenials: failures.filter((failure) => failure.code.includes('permission_denied')).length,
      humanApprovals: approvals.filter((approval) => approval.status === 'granted').length,
      approvalsDenied: approvals.filter((approval) => approval.status === 'denied').length,
      checkpointCount: checkpoints.length,
      failureCount: failures.length,
      terminalFailureCount: failures.filter((failure) => failure.terminal).length,
      interruptions: events.filter((event) => event.type === 'run.paused' || event.type === 'approval.requested').length,
      tokenUsage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      costUsd,
      modelTransitions,
      usage: counters,
      ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    };
  }

  async collectMany(runIds: string[]): Promise<RunMetrics[]> {
    const metrics: RunMetrics[] = [];
    for (const runId of runIds) metrics.push(await this.collect(runId));
    return metrics;
  }
}

/** Aggregate metrics across runs, used for dashboards and Bench reports. */
export interface AggregateMetrics {
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  incomplete: number;
  successRate: number;
  totalToolCalls: number;
  totalFailedToolCalls: number;
  totalSteps: number;
  totalRecoveries: number;
  totalPolicyViolations: number;
  totalApprovals: number;
  totalCheckpoints: number;
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  averageSteps: number;
  averageDurationMs: number;
  averageCostUsd: number;
}

export function aggregateMetrics(metrics: RunMetrics[]): AggregateMetrics {
  const runs = metrics.length;
  const sum = (pick: (item: RunMetrics) => number): number => metrics.reduce((total, item) => total + pick(item), 0);
  const succeeded = metrics.filter((item) => item.outcome === 'succeeded').length;
  return {
    runs,
    succeeded,
    failed: metrics.filter((item) => item.outcome === 'failed').length,
    cancelled: metrics.filter((item) => item.outcome === 'cancelled').length,
    timedOut: metrics.filter((item) => item.outcome === 'timed_out').length,
    incomplete: metrics.filter((item) => item.outcome === 'incomplete').length,
    successRate: runs === 0 ? 0 : succeeded / runs,
    totalToolCalls: sum((item) => item.toolCalls),
    totalFailedToolCalls: sum((item) => item.failedToolCalls),
    totalSteps: sum((item) => item.steps),
    totalRecoveries: sum((item) => item.recoveryCount),
    totalPolicyViolations: sum((item) => item.policyViolations),
    totalApprovals: sum((item) => item.humanApprovals),
    totalCheckpoints: sum((item) => item.checkpointCount),
    totalTokens: sum((item) => item.tokenUsage.totalTokens),
    totalCostUsd: sum((item) => item.costUsd),
    totalDurationMs: sum((item) => item.durationMs),
    averageSteps: runs === 0 ? 0 : sum((item) => item.steps) / runs,
    averageDurationMs: runs === 0 ? 0 : sum((item) => item.durationMs) / runs,
    averageCostUsd: runs === 0 ? 0 : sum((item) => item.costUsd) / runs,
  };
}

export function classifyOutcome(status: string): RunOutcome {
  if (status === 'COMPLETED') return 'succeeded';
  if (status === 'FAILED') return 'failed';
  if (status === 'CANCELLED') return 'cancelled';
  if (status === 'TIMED_OUT') return 'timed_out';
  return 'incomplete';
}

function durationOf(startedAt?: number, finishedAt?: number, createdAt?: number, updatedAt?: number): number {
  const start = startedAt ?? createdAt;
  const end = finishedAt ?? updatedAt;
  if (start === undefined || end === undefined) return 0;
  return Math.max(0, end - start);
}

function emptyMetrics(runId: string): RunMetrics {
  return {
    runId,
    organizationId: '',
    projectId: '',
    agentId: '',
    status: 'UNKNOWN',
    outcome: 'incomplete',
    taskSuccess: false,
    durationMs: 0,
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    deniedToolCalls: 0,
    awaitingApprovalCalls: 0,
    replayedToolCalls: 0,
    recoveryCount: 0,
    recoverySuccesses: 0,
    recoveryFailureCount: 0,
    policyViolations: 0,
    permissionDenials: 0,
    humanApprovals: 0,
    approvalsDenied: 0,
    checkpointCount: 0,
    failureCount: 0,
    terminalFailureCount: 0,
    interruptions: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    costUsd: 0,
    modelTransitions: 0,
    usage: {
      steps: 0,
      toolCalls: 0,
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      networkRequests: 0,
      storageBytes: 0,
      durationMs: 0,
      recoveryCount: 0,
      checkpointCount: 0,
      modelCalls: 0,
    },
  };
}
