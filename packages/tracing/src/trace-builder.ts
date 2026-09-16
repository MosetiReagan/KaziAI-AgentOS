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
  const openTools = new Map<string, TraceNode>();

  for (const event of events) {
    const node = nodeForEvent(event);
    if (!node) continue;
    if (event.type === 'tool.started') {
      openTools.set(toolKeyOf(event), node);
      children.push(node);
      continue;
    }
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const open = openTools.get(toolKeyOf(event));
      if (open) {
        open.status = node.status;
        open.finishedAt = node.startedAt;
        open.durationMs = Math.max(0, node.startedAt - open.startedAt);
        openTools.delete(toolKeyOf(event));
        continue;
      }
    }
    children.push(node);
  }

  appendMissing(children, 'step', input.steps ?? [], (step) => ({
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
  }));

  appendMissing(children, 'tool', input.invocations ?? [], (invocation) => ({
    id: invocation.id,
    kind: 'tool',
    label: invocation.toolId,
    status: invocation.status,
    startedAt: invocation.at,
    durationMs: invocation.durationMs,
    toolId: invocation.toolId,
    detail: { actionId: invocation.actionId, success: invocation.success },
  }));

  appendMissing(children, 'checkpoint', input.checkpoints ?? [], (checkpoint) => ({
    id: checkpoint.id,
    kind: 'checkpoint',
    label: `CHECKPOINT #${checkpoint.sequence}`,
    status: 'created',
    startedAt: checkpoint.createdAt,
    detail: { sequence: checkpoint.sequence, stateVersion: checkpoint.stateVersion },
  }));

  appendMissing(children, 'recovery', input.recoveries ?? [], (recovery) => ({
    id: recovery.id,
    kind: 'recovery',
    label: `RECOVERY ${recovery.strategy}`,
    status: recovery.success ? 'succeeded' : 'failed',
    startedAt: recovery.at,
    detail: { attempt: recovery.attempt },
  }));

  appendMissing(children, 'approval', input.approvals ?? [], (approval) => ({
    id: approval.id,
    kind: 'approval',
    label: `APPROVAL ${approval.toolId}`,
    status: approval.status,
    startedAt: approval.requestedAt,
    ...(approval.decidedAt === undefined ? {} : { finishedAt: approval.decidedAt }),
    risk: approval.risk as TraceNode['risk'],
  }));

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
      durationMs: (run.finishedAt ?? Date.now()) - run.createdAt,
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
  const base = {
    id: event.id,
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

function appendMissing<T>(
  nodes: TraceNode[],
  kind: TraceNodeKind,
  records: T[],
  build: (record: T) => TraceNode,
): void {
  const known = new Set(nodes.filter((node) => node.kind === kind).map((node) => node.id));
  for (const record of records) {
    const node = build(record);
    if (known.has(node.id)) continue;
    known.add(node.id);
    nodes.push(node);
  }
}

function countFailures(nodes: TraceNode[]): number {
  return nodes.filter((node) => ['failed', 'denied', 'timed_out'].includes(node.status)).length;
}
