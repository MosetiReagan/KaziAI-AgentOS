import type {
  AgentEvent,
  AgentRun,
  CheckpointRef,
  JsonObject,
  JsonValue,
  Trace,
  TraceNode,
  TraceNodeKind,
} from '@kazi-ai/agentos-core';

export interface TraceStepInput {
  id: string;
  index: number;
  description: string;
  phase: string;
  status: string;
  toolId?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface TraceToolInput {
  id: string;
  toolId: string;
  actionId: string;
  status: string;
  durationMs: number;
  success: boolean;
  at: number;
}

export interface TraceRecoveryInput {
  id: string;
  attempt: number;
  strategy: string;
  success: boolean;
  at: number;
}

export interface TraceApprovalInput {
  id: string;
  toolId: string;
  status: string;
  risk: string;
  requestedAt: number;
  decidedAt?: number;
}

export interface TraceInput {
  run: AgentRun;
  /**
   * Wall clock used when the run has not finished yet, so an in-flight trace
   * has a duration. Injectable because a trace that is rebuilt later must be
   * reproducible (spec §57, §89); the default reads the ambient clock.
   */
  now?: number;
  events?: AgentEvent[];
  steps?: TraceStepInput[];
  invocations?: TraceToolInput[];
  checkpoints?: CheckpointRef[];
  recoveries?: TraceRecoveryInput[];
  approvals?: TraceApprovalInput[];
}

/**
 * Assemble the run trace. Events are the primary source (they are append-only
 * and versioned), with persisted steps, invocations, checkpoints, recoveries
 * and approvals filling the gaps for records written before an event was
 * emitted. Nothing here reads hidden model reasoning (spec §40).
 */
export function buildTrace(input: TraceInput): Trace {
  const { run } = input;
  const events = [...(input.events ?? [])].sort((left, right) => left.sequence - right.sequence);
  const children: TraceNode[] = [];
  const index = new Map<string, TraceNode>();
  const claimed = new Set<string>();

  // One node per real thing that happened. A tool call emits `requested` then
  // `completed`/`failed`/`denied` (and a retry may emit the terminal event
  // again), so nodes are folded by their stable key instead of one-per-event.
  for (const event of events) {
    const node = nodeForEvent(event);
    if (!node) continue;
    const key = keyForEvent(event);
    if (!key) {
      children.push(node);
      continue;
    }
    const existing = index.get(key);
    if (!existing) {
      index.set(key, node);
      claimed.add(key);
      children.push(node);
      continue;
    }
    const previousDetail = (existing.detail ?? {}) as JsonObject;
    existing.status = node.status;
    existing.finishedAt = node.startedAt;
    existing.durationMs = Math.max(0, node.startedAt - existing.startedAt);
    existing.detail = { ...previousDetail, ...(node.detail ?? {}) };
    existing.attempts = (existing.attempts ?? 1) + 1;
    if (node.risk) existing.risk = node.risk;
  }

  appendMissing(
    children,
    'step',
    claimed,
    input.steps ?? [],
    (step) => ({
      id: step.id,
      kind: 'step',
      label: `STEP ${step.index + 1} ${step.description}`,
      status: step.status,
      startedAt: step.startedAt ?? run.createdAt,
      ...(step.finishedAt === undefined ? {} : { finishedAt: step.finishedAt }),
      ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      ...(step.toolId === undefined ? {} : { toolId: step.toolId }),
      stepId: step.id,
      detail: { phase: step.phase },
    }),
    (step) => `step:${step.id}`,
  );

  appendMissing(
    children,
    'tool',
    claimed,
    input.invocations ?? [],
    (invocation) => ({
      id: invocation.actionId,
      kind: 'tool',
      label: invocation.toolId,
      status: invocation.status,
      startedAt: invocation.at,
      durationMs: invocation.durationMs,
      toolId: invocation.toolId,
      detail: { actionId: invocation.actionId, success: invocation.success },
    }),
    (invocation) => `tool:${invocation.actionId}`,
  );

  appendMissing(
    children,
    'checkpoint',
    claimed,
    input.checkpoints ?? [],
    (checkpoint) => ({
      id: checkpoint.id,
      kind: 'checkpoint',
      label: `CHECKPOINT #${checkpoint.sequence}`,
      status: 'created',
      startedAt: checkpoint.createdAt,
      detail: { sequence: checkpoint.sequence, stateVersion: checkpoint.stateVersion },
    }),
    (checkpoint) => `checkpoint:${checkpoint.id}`,
  );

  appendMissing(
    children,
    'recovery',
    claimed,
    input.recoveries ?? [],
    (recovery) => ({
      id: recovery.id,
      kind: 'recovery',
      label: `RECOVERY ${recovery.strategy}`,
      status: recovery.success ? 'succeeded' : 'failed',
      startedAt: recovery.at,
      detail: { attempt: recovery.attempt, strategy: recovery.strategy },
    }),
    (recovery) => `recovery:${recovery.attempt}`,
  );

  appendMissing(
    children,
    'approval',
    claimed,
    input.approvals ?? [],
    (approval) => ({
      id: approval.id,
      kind: 'approval',
      label: `APPROVAL ${approval.toolId}`,
      status: approval.status,
      startedAt: approval.requestedAt,
      ...(approval.decidedAt === undefined ? {} : { finishedAt: approval.decidedAt }),
      risk: approval.risk as TraceNode['risk'],
    }),
    (approval) => `approval:${approval.id}`,
  );

  children.sort((left, right) => left.startedAt - right.startedAt);

  const planNode = planNodeOf(run);
  const nodes = planNode ? [planNode, ...children] : children;

  return {
    runId: run.id,
    traceId: run.traceId,
    nodes,
    summary: {
      steps: nodes.filter((node) => node.kind === 'step').length,
      toolCalls: nodes.filter((node) => node.kind === 'tool').length,
      failures: countFailures(nodes),
      recoveries: nodes.filter((node) => node.kind === 'recovery').length,
      checkpoints: nodes.filter((node) => node.kind === 'checkpoint').length,
      durationMs: (run.finishedAt ?? input.now ?? Date.now()) - run.createdAt,
      costUsd: run.usage.costUsd,
      tokens: run.usage.tokens.totalTokens,
    },
  };
}

function planNodeOf(run: AgentRun): TraceNode | undefined {
  if (!run.plan) return undefined;
  return {
    id: run.plan.id,
    kind: 'plan',
    label: `PLAN v${run.plan.version}`,
    status: 'created',
    startedAt: run.plan.createdAt,
    detail: {
      objective: run.plan.objective,
      steps: run.plan.steps.length,
      stepIds: run.plan.steps.map((step) => step.id) as JsonValue,
    },
  };
}

function nodeForEvent(event: AgentEvent): TraceNode | undefined {
  const data = event.data as JsonObject;
  const stableId =
    (typeof data['checkpointId'] === 'string' ? data['checkpointId'] : undefined) ??
    (typeof data['approvalId'] === 'string' ? data['approvalId'] : undefined);
  const base = {
    id: stableId ?? event.id,
    label: labelOf(event),
    status: statusOf(event),
    startedAt: event.at,
    detail: { ...event.data, sequence: event.sequence },
  };
  switch (event.type) {
    case 'plan.created':
    case 'plan.updated':
    case 'plan.revised':
      return { ...base, kind: 'plan' };
    case 'step.started':
    case 'step.completed':
    case 'step.failed':
    case 'step.skipped':
      return { ...base, kind: 'step', ...(stepIdOf(event) ? { stepId: stepIdOf(event) as string } : {}) };
    case 'tool.requested':
    case 'tool.allowed':
    case 'tool.denied':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return { ...base, kind: 'tool', ...(toolIdOf(event) ? { toolId: toolIdOf(event) as string } : {}) };
    case 'model.requested':
    case 'model.responded':
    case 'model.failed':
    case 'model.failover':
      return { ...base, kind: 'model' };
    case 'verification.started':
    case 'verification.completed':
      return { ...base, kind: 'verification' };
    case 'recovery.started':
    case 'recovery.completed':
    case 'recovery.failed':
      return { ...base, kind: 'recovery' };
    case 'checkpoint.created':
      return { ...base, kind: 'checkpoint' };
    case 'approval.requested':
    case 'approval.granted':
    case 'approval.denied':
    case 'approval.modified':
      return { ...base, kind: 'approval', ...(toolIdOf(event) ? { toolId: toolIdOf(event) as string } : {}) };
    case 'state.transitioned':
      return { ...base, kind: 'run' };
    default:
      return undefined;
  }
}

function labelOf(event: AgentEvent): string {
  const toolId = toolIdOf(event);
  if (toolId) return toolId;
  const stepId = stepIdOf(event);
  if (stepId) return `step ${stepId}`;
  return event.type;
}

function statusOf(event: AgentEvent): string {
  const data = event.data as JsonObject;
  if (typeof data['status'] === 'string') return data['status'] as string;
  if (event.type.endsWith('.failed')) return 'failed';
  if (event.type.endsWith('.completed') || event.type.endsWith('.granted') || event.type.endsWith('.allowed')) return 'succeeded';
  if (event.type.endsWith('.denied')) return 'denied';
  if (event.type.endsWith('.started') || event.type.endsWith('.requested')) return 'running';
  if (event.type === 'run.completed') return 'COMPLETED';
  if (event.type === 'run.failed') return 'FAILED';
  return 'recorded';
}

function toolIdOf(event: AgentEvent): string | undefined {
  const value = (event.data as JsonObject)['toolId'];
  return typeof value === 'string' ? value : undefined;
}

function stepIdOf(event: AgentEvent): string | undefined {
  const value = (event.data as JsonObject)['stepId'];
  return typeof value === 'string' ? value : undefined;
}

function toolKeyOf(event: AgentEvent): string {
  const data = event.data as JsonObject;
  const actionId = data['actionId'];
  if (typeof actionId === 'string') return actionId;
  return toolIdOf(event) ?? event.id;
}

/** Stable identity of what an event is about; undefined means "its own node". */
function keyForEvent(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'tool.requested':
    case 'tool.allowed':
    case 'tool.denied':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return `tool:${toolKeyOf(event)}`;
    case 'step.started':
    case 'step.completed':
    case 'step.failed':
    case 'step.skipped': {
      const stepId = stepIdOf(event);
      return stepId ? `step:${stepId}` : undefined;
    }
    case 'recovery.started':
    case 'recovery.completed':
    case 'recovery.failed': {
      const attempt = (event.data as JsonObject)['attempt'];
      return typeof attempt === 'number' ? `recovery:${attempt}` : undefined;
    }
    case 'checkpoint.created': {
      const checkpointId = (event.data as JsonObject)['checkpointId'];
      return typeof checkpointId === 'string' ? `checkpoint:${checkpointId}` : undefined;
    }
    case 'approval.requested':
    case 'approval.granted':
    case 'approval.denied':
    case 'approval.modified': {
      const approvalId = (event.data as JsonObject)['approvalId'];
      return typeof approvalId === 'string' ? `approval:${approvalId}` : undefined;
    }
    default:
      return undefined;
  }
}

function appendMissing<T>(
  nodes: TraceNode[],
  kind: TraceNodeKind,
  claimed: Set<string>,
  records: T[],
  build: (record: T) => TraceNode,
  keyOf: (record: T) => string,
): void {
  const known = new Set(nodes.filter((node) => node.kind === kind).map((node) => node.id));
  for (const record of records) {
    const key = keyOf(record);
    const node = build(record);
    if (claimed.has(key) || known.has(node.id)) continue;
    claimed.add(key);
    known.add(node.id);
    nodes.push(node);
  }
}

function countFailures(nodes: TraceNode[]): number {
  return nodes.filter((node) => ['failed', 'denied', 'timed_out'].includes(node.status)).length;
}
