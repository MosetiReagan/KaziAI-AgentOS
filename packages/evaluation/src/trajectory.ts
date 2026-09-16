import type { AgentEvent, JsonValue } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { RunMetrics } from './metrics.js';

export interface TrajectoryStep {
  index: number;
  kind: 'plan' | 'step' | 'tool' | 'observation' | 'verification' | 'recovery' | 'checkpoint' | 'approval' | 'model';
  at: number;
  label: string;
  status?: string;
  toolId?: string;
  durationMs?: number;
  detail?: JsonValue;
}

export interface TrajectoryToolCall {
  at: number;
  toolId: string;
  status: string;
  durationMs?: number;
  attempts: number;
  errorCode?: string;
}

export interface TrajectoryRecovery {
  at: number;
  strategy: string;
  success: boolean;
  attempt: number;
}

export interface TrajectoryVerification {
  at: number;
  passed: boolean;
  summary: string;
}

export interface RunTrajectory {
  runId: string;
  traceId: string;
  agentId: string;
  goal: string;
  status: string;
  success: boolean;
  steps: TrajectoryStep[];
  toolCalls: TrajectoryToolCall[];
  failures: Array<{ at: number; code: string; message: string; category: string; retryable: boolean }>;
  recovery: TrajectoryRecovery[];
  verifications: TrajectoryVerification[];
  checkpoints: Array<{ at: number; checkpointId: string; sequence: number }>;
  approvals: Array<{ at: number; toolId: string; status: string; risk: string }>;
  metrics?: RunMetrics;
}

/**
 * Builds the evaluation trajectory of a run from its durable history: what the
 * agent did, what failed, what was recovered, and what it cost. It deliberately
 * contains no hidden chain-of-thought — only recorded actions and results
 * (spec §40).
 */
export async function buildTrajectory(
  store: Pick<AgentOSStore, 'runs' | 'events' | 'invocations' | 'failures' | 'recoveries' | 'checkpoints' | 'approvals'>,
  runId: string,
  options: { metrics?: RunMetrics; success?: boolean } = {},
): Promise<RunTrajectory> {
  const run = await store.runs.get(runId);
  if (!run) throw new Error(`Cannot build a trajectory: run ${runId} does not exist`);
  const [events, invocations, failures, recoveries, checkpoints, approvals] = await Promise.all([
    store.events.list(runId),
    store.invocations.list(runId),
    store.failures.list(runId),
    store.recoveries.list(runId),
    store.checkpoints.list(runId),
    store.approvals.list({ runId }),
  ]);

  return {
    runId,
    traceId: run.traceId,
    agentId: run.agentId,
    goal: run.goal,
    status: run.status,
    success: options.success ?? run.status === 'COMPLETED',
    steps: events.map(toStep).filter((step): step is TrajectoryStep => step !== undefined),
    toolCalls: groupInvocations(invocations),
    failures: failures.map((failure) => ({
      at: failure.at,
      code: failure.code,
      message: failure.message,
      category: failure.category,
      retryable: failure.retryable,
    })),
    recovery: recoveries.map((attempt) => ({
      at: attempt.at,
      strategy: attempt.strategy,
      success: attempt.success,
      attempt: attempt.attempt,
    })),
    verifications: events
      .filter((event) => event.type === 'verification.completed')
      .map((event) => ({
        at: event.at,
        passed: event.data['passed'] === true,
        summary: typeof event.data['summary'] === 'string' ? event.data['summary'] : '',
      })),
    checkpoints: checkpoints.map((checkpoint) => ({
      at: checkpoint.createdAt,
      checkpointId: checkpoint.id,
      sequence: checkpoint.sequence,
    })),
    approvals: approvals.map((approval) => ({
      at: approval.requestedAt,
      toolId: approval.toolId,
      status: approval.status,
      risk: approval.risk,
    })),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  };
}

function toStep(event: AgentEvent): TrajectoryStep | undefined {
  const index = event.sequence;
  const base = { index, at: event.at, detail: event.data };
  switch (event.type) {
    case 'plan.created':
    case 'plan.updated':
      return { ...base, kind: 'plan', label: `plan v${String(event.data['version'] ?? '?')}` };
    case 'step.started':
      return { ...base, kind: 'step', label: `step ${String(event.data['index'] ?? '?')}`, status: 'running' };
    case 'step.completed':
      return { ...base, kind: 'step', label: `step ${String(event.data['index'] ?? '?')}`, status: 'completed' };
    case 'tool.requested':
    case 'tool.allowed':
    case 'tool.denied':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return {
        ...base,
        kind: 'tool',
        label: `${event.type} ${String(event.data['toolId'] ?? '')}`.trim(),
        toolId: typeof event.data['toolId'] === 'string' ? event.data['toolId'] : undefined,
        status: event.type.split('.')[1],
      };
    case 'model.requested':
    case 'model.responded':
      return { ...base, kind: 'model', label: event.type, detail: event.data };
    case 'verification.started':
    case 'verification.completed':
      return { ...base, kind: 'verification', label: event.type, status: event.data['passed'] === true ? 'passed' : undefined };
    case 'recovery.started':
    case 'recovery.completed':
      return { ...base, kind: 'recovery', label: String(event.data['strategy'] ?? event.type) };
    case 'checkpoint.created':
      return { ...base, kind: 'checkpoint', label: String(event.data['reason'] ?? 'checkpoint') };
    case 'approval.requested':
    case 'approval.granted':
    case 'approval.denied':
      return { ...base, kind: 'approval', label: event.type, toolId: typeof event.data['toolId'] === 'string' ? event.data['toolId'] : undefined };
    default:
      return undefined;
  }
}

function groupInvocations(
  invocations: Array<{
    at: number;
    toolId: string;
    actionId: string;
    status: string;
    durationMs: number;
  }>,
): TrajectoryToolCall[] {
  const grouped = new Map<string, TrajectoryToolCall>();
  for (const invocation of invocations) {
    const existing = grouped.get(invocation.actionId);
    if (existing) {
      existing.attempts += 1;
      existing.durationMs = (existing.durationMs ?? 0) + invocation.durationMs;
      existing.status = invocation.status;
      continue;
    }
    grouped.set(invocation.actionId, {
      at: invocation.at,
      toolId: invocation.toolId,
      status: invocation.status,
      durationMs: invocation.durationMs,
      attempts: 1,
    });
  }
  return [...grouped.values()].sort((left, right) => left.at - right.at);
}
