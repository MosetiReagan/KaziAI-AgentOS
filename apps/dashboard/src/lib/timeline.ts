import type { AgentEvent, RunState } from '../api/types.js';

/**
 * Turns the durable event log into the timeline an operator reads (spec §51,
 * §53). This is operational metadata only: AgentOS never captures hidden
 * reasoning, so nothing here can show it even by accident.
 */

export type TimelineKind =
  | 'lifecycle'
  | 'state'
  | 'plan'
  | 'step'
  | 'model'
  | 'tool'
  | 'verification'
  | 'recovery'
  | 'checkpoint'
  | 'approval'
  | 'budget'
  | 'memory'
  | 'artifact'
  | 'circuit'
  | 'workspace'
  | 'other';

export type TimelineTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger';

export interface TimelineEntry {
  id: string;
  sequence: number;
  at: number;
  type: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  tone: TimelineTone;
  toolId?: string;
  risk?: string;
  /** Present when the event names a step, so the view can group by step. */
  stepId?: string;
}

function data(event: AgentEvent): Record<string, unknown> {
  return (event.data ?? {}) as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length === 0 ? undefined : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function describe(event: AgentEvent): { kind: TimelineKind; title: string; detail?: string; tone: TimelineTone } {
  const payload = data(event);
  const tool = text(payload.toolId) ?? text(payload.tools);
  const step = text(payload.description) ?? text(payload.stepId);
  const suffix = tool === undefined ? '' : ` ${tool}`;

  switch (event.type) {
    case 'run.created':
      return { kind: 'lifecycle', title: 'Run created', tone: 'info' };
    case 'run.queued':
      return { kind: 'lifecycle', title: 'Queued', tone: 'info' };
    case 'run.started':
      return { kind: 'lifecycle', title: 'Started', tone: 'info' };
    case 'run.paused':
      return { kind: 'lifecycle', title: 'Paused', detail: text(payload.reason), tone: 'warn' };
    case 'run.resumed':
      return { kind: 'lifecycle', title: 'Resumed', tone: 'info' };
    case 'run.retried':
      return { kind: 'lifecycle', title: 'Retried', tone: 'info' };
    case 'run.forked':
      return { kind: 'lifecycle', title: 'Forked', detail: text(payload.parentRunId), tone: 'info' };
    case 'run.completed':
      return { kind: 'lifecycle', title: 'Completed', tone: 'success' };
    case 'run.failed':
      return {
        kind: 'lifecycle',
        title: 'Failed',
        detail: text(payload.message) ?? text(payload.code),
        tone: 'danger',
      };
    case 'run.error':
      return {
        kind: 'lifecycle',
        title: 'Error',
        detail: text(payload.message) ?? text(payload.code),
        tone: 'danger',
      };
    case 'run.cancelled':
      return { kind: 'lifecycle', title: 'Cancelled', tone: 'warn' };
    case 'run.timed_out':
      return { kind: 'lifecycle', title: 'Timed out', tone: 'danger' };
    case 'state.transitioned': {
      const from = text(payload.from) ?? '?';
      const to = text(payload.to) ?? '?';
      return { kind: 'state', title: `${from} → ${to}`, detail: text(payload.reason), tone: 'neutral' };
    }
    case 'plan.created':
      return {
        kind: 'plan',
        title: `Plan v${text(payload.version) ?? '1'}`,
        detail: text(payload.objective) ?? `${text(payload.steps) ?? '?'} steps`,
        tone: 'info',
      };
    case 'plan.updated':
    case 'plan.revised':
      return {
        kind: 'plan',
        title: `Plan revised (v${text(payload.version) ?? '?'})`,
        detail: text(payload.reason) ?? text(payload.objective),
        tone: 'warn',
      };
    case 'step.started':
      return { kind: 'step', title: `Step ${text(payload.index) ?? '?'}`, detail: step, tone: 'info' };
    case 'step.completed':
      return { kind: 'step', title: `Step ${text(payload.index) ?? '?'} done`, detail: step, tone: 'success' };
    case 'step.failed':
      return {
        kind: 'step',
        title: `Step ${text(payload.index) ?? '?'} failed`,
        detail: text(payload.message) ?? step,
        tone: 'danger',
      };
    case 'step.skipped':
      return { kind: 'step', title: 'Step skipped', detail: step, tone: 'neutral' };
    case 'model.requested':
      return {
        kind: 'model',
        title: `Model call ${text(payload.provider) ?? ''}/${text(payload.model) ?? ''}`.trim(),
        tone: 'neutral',
      };
    case 'model.responded': {
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      const tokens = [text(usage.inputTokens), text(usage.outputTokens)].filter(
        (value) => value !== undefined,
      );
      return {
        kind: 'model',
        title: 'Model answered',
        detail: tokens.length === 2 ? `${tokens[0]} in / ${tokens[1]} out` : text(payload.finishReason),
        tone: 'neutral',
      };
    }
    case 'model.failed':
      return { kind: 'model', title: 'Model call failed', detail: text(payload.message), tone: 'danger' };
    case 'model.failover':
      return {
        kind: 'model',
        title: 'Provider failover',
        detail: `${text(payload.from) ?? '?'} → ${text(payload.to) ?? '?'}`,
        tone: 'warn',
      };
    case 'tool.requested':
      return { kind: 'tool', title: `Requested${suffix}`, detail: text(payload.risk), tone: 'neutral' };
    case 'tool.allowed':
      return { kind: 'tool', title: `Allowed${suffix}`, detail: text(payload.ruleId), tone: 'info' };
    case 'tool.denied':
      return {
        kind: 'tool',
        title: `Denied${suffix}`,
        detail: text(payload.reason) ?? text(payload.ruleId),
        tone: 'danger',
      };
    case 'tool.started':
      return { kind: 'tool', title: `Running${suffix}`, tone: 'info' };
    case 'tool.completed':
      return {
        kind: 'tool',
        title: `Completed${suffix}`,
        detail: text(payload.durationMs) === undefined ? undefined : `${text(payload.durationMs)}ms`,
        tone: 'success',
      };
    case 'tool.failed':
      return {
        kind: 'tool',
        title: `Failed${suffix}`,
        detail: text(payload.message) ?? text(payload.code),
        tone: 'danger',
      };
    case 'verification.started':
      return { kind: 'verification', title: 'Verification started', tone: 'info' };
    case 'verification.completed': {
      const passed = payload.passed === true;
      return {
        kind: 'verification',
        title: passed ? 'Verification passed' : 'Verification failed',
        detail: text(payload.summary),
        tone: passed ? 'success' : 'danger',
      };
    }
    case 'recovery.started':
      return {
        kind: 'recovery',
        title: `Recovery started (${text(payload.kind) ?? 'failure'})`,
        detail: text(payload.toolId),
        tone: 'warn',
      };
    case 'recovery.completed': {
      const applied = payload.applied === true;
      return {
        kind: 'recovery',
        title: `Recovery ${applied ? 'applied' : 'not applied'}: ${text(payload.strategy) ?? ''}`.trim(),
        detail: text(payload.reason),
        tone: applied ? 'info' : 'danger',
      };
    }
    case 'recovery.failed':
      return { kind: 'recovery', title: 'Recovery failed', detail: text(payload.message), tone: 'danger' };
    case 'checkpoint.created':
      return {
        kind: 'checkpoint',
        title: payload.restored === true ? 'Checkpoint restored' : 'Checkpoint',
        detail: [text(payload.trigger), text(payload.checkpointId)].filter(Boolean).join(' · '),
        tone: 'neutral',
      };
    case 'approval.requested':
      return {
        kind: 'approval',
        title: `Approval required${suffix}`,
        detail: text(payload.reason),
        tone: 'warn',
      };
    case 'approval.granted':
      return { kind: 'approval', title: 'Approved', detail: text(payload.decidedBy), tone: 'success' };
    case 'approval.denied':
      return { kind: 'approval', title: 'Denied', detail: text(payload.decidedBy), tone: 'danger' };
    case 'approval.modified':
      return { kind: 'approval', title: 'Modified', detail: text(payload.decidedBy), tone: 'warn' };
    case 'budget.warning':
      return {
        kind: 'budget',
        title: 'Budget warning',
        detail: text(payload.dimension) ?? text(payload.message),
        tone: 'warn',
      };
    case 'budget.exceeded':
      return {
        kind: 'budget',
        title: 'Budget exceeded',
        detail: text(payload.dimension) ?? text(payload.message),
        tone: 'danger',
      };
    case 'memory.written':
      return { kind: 'memory', title: 'Memory written', detail: text(payload.type), tone: 'neutral' };
    case 'memory.searched':
      return { kind: 'memory', title: 'Memory searched', detail: text(payload.query), tone: 'neutral' };
    case 'artifact.created':
      return { kind: 'artifact', title: 'Artifact', detail: text(payload.name), tone: 'info' };
    case 'circuit.opened':
      return { kind: 'circuit', title: 'Circuit opened', detail: text(payload.name), tone: 'warn' };
    case 'circuit.closed':
      return { kind: 'circuit', title: 'Circuit closed', detail: text(payload.name), tone: 'success' };
    case 'workspace.created':
      return { kind: 'workspace', title: 'Workspace created', detail: text(payload.dir), tone: 'neutral' };
    case 'workspace.cleaned':
      return { kind: 'workspace', title: 'Workspace cleaned', tone: 'neutral' };
    default:
      return { kind: 'other', title: event.type, tone: 'neutral' };
  }
}

export function toTimelineEntry(event: AgentEvent): TimelineEntry {
  const description = describe(event);
  const payload = data(event);
  return {
    id: event.id,
    sequence: event.sequence,
    at: event.at,
    type: event.type,
    kind: description.kind,
    title: description.title,
    ...(description.detail === undefined || description.detail === ''
      ? {}
      : { detail: description.detail }),
    tone: description.tone,
    ...(text(payload.toolId) === undefined ? {} : { toolId: text(payload.toolId) as string }),
    ...(text(payload.risk) === undefined ? {} : { risk: text(payload.risk) as string }),
    ...(text(payload.stepId) === undefined ? {} : { stepId: text(payload.stepId) as string }),
  };
}

/** Events are deduplicated by id and ordered by sequence, so a replay is safe. */
export function toTimeline(events: AgentEvent[]): TimelineEntry[] {
  const seen = new Set<string>();
  const entries: TimelineEntry[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    entries.push(toTimelineEntry(event));
  }
  return entries.sort((left, right) => left.sequence - right.sequence);
}

export interface EventStats {
  events: number;
  toolCalls: number;
  toolFailures: number;
  denials: number;
  recoveries: number;
  checkpoints: number;
  approvals: number;
  verifications: number;
  failedVerifications: number;
  modelCalls: number;
  failovers: number;
  budgetWarnings: number;
  lastSequence: number;
  lastState?: RunState;
}

export function summarizeEvents(events: AgentEvent[]): EventStats {
  const stats: EventStats = {
    events: 0,
    toolCalls: 0,
    toolFailures: 0,
    denials: 0,
    recoveries: 0,
    checkpoints: 0,
    approvals: 0,
    verifications: 0,
    failedVerifications: 0,
    modelCalls: 0,
    failovers: 0,
    budgetWarnings: 0,
    lastSequence: 0,
  };
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    stats.events += 1;
    stats.lastSequence = Math.max(stats.lastSequence, event.sequence);
    const payload = data(event);
    if (event.type === 'state.transitioned') {
      const to = text(payload.to);
      if (to !== undefined) stats.lastState = to as RunState;
    }
    if (event.type === 'tool.completed') stats.toolCalls += 1;
    if (event.type === 'tool.failed') stats.toolFailures += 1;
    if (event.type === 'tool.denied') stats.denials += 1;
    if (event.type === 'recovery.completed') stats.recoveries += 1;
    if (event.type === 'checkpoint.created') stats.checkpoints += 1;
    if (event.type === 'approval.requested') stats.approvals += 1;
    if (event.type === 'verification.completed') {
      stats.verifications += 1;
      if (payload.passed !== true) stats.failedVerifications += 1;
    }
    if (event.type === 'model.responded') stats.modelCalls += 1;
    if (event.type === 'model.failover') stats.failovers += 1;
    if (event.type === 'budget.warning') stats.budgetWarnings += 1;
  }
  return stats;
}

export interface ToolCallStat {
  toolId: string;
  calls: number;
  failures: number;
  denials: number;
  totalMs: number;
  lastStatus: string;
}

/** Per-tool statistics, derived from the same events the timeline renders. */
export function toolStats(events: AgentEvent[]): ToolCallStat[] {
  const byTool = new Map<string, ToolCallStat>();
  for (const event of events) {
    const payload = data(event);
    const toolId = text(payload.toolId);
    if (toolId === undefined) continue;
    const entry =
      byTool.get(toolId) ?? { toolId, calls: 0, failures: 0, denials: 0, totalMs: 0, lastStatus: '—' };
    if (event.type === 'tool.completed') {
      entry.calls += 1;
      entry.lastStatus = 'completed';
      const duration = payload.durationMs;
      if (typeof duration === 'number') entry.totalMs += duration;
    } else if (event.type === 'tool.failed') {
      entry.failures += 1;
      entry.lastStatus = 'failed';
    } else if (event.type === 'tool.denied') {
      entry.denials += 1;
      entry.lastStatus = 'denied';
    }
    byTool.set(toolId, entry);
  }
  return [...byTool.values()].sort((left, right) => right.calls - left.calls);
}
