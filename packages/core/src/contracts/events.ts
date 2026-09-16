import type { JsonObject } from '../json.js';

export const EVENT_VERSION = 1;

export const EVENT_TYPES = [
  'run.created',
  'run.queued',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.timed_out',
  'run.retried',
  'run.forked',
  'state.transitioned',
  'plan.created',
  'plan.updated',
  'plan.revised',
  'step.started',
  'step.completed',
  'step.failed',
  'step.skipped',
  'model.requested',
  'model.responded',
  'model.failed',
  'model.failover',
  'tool.requested',
  'tool.allowed',
  'tool.denied',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'verification.started',
  'verification.completed',
  'recovery.started',
  'recovery.completed',
  'recovery.failed',
  'checkpoint.created',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'approval.modified',
  'budget.warning',
  'budget.exceeded',
  'memory.written',
  'memory.searched',
  'artifact.created',
  'circuit.opened',
  'circuit.closed',
  'workspace.created',
  'workspace.cleaned',
] as const;

export type AgentEventType = (typeof EVENT_TYPES)[number];

export interface AgentEvent<T extends JsonObject = JsonObject> {
  id: string;
  type: AgentEventType;
  version: number;
  runId: string;
  organizationId: string;
  projectId: string;
  /** Monotonic per-run sequence used to order the execution history. */
  sequence: number;
  at: number;
  traceId?: string;
  data: T;
}

export interface EventSubscriptionOptions {
  runId?: string;
  organizationId?: string;
  types?: AgentEventType[];
}

export type EventListener = (event: AgentEvent) => void;

export interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(listener: EventListener, options?: EventSubscriptionOptions): () => void;
}

