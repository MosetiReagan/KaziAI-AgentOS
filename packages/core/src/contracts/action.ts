import type { JsonObject, JsonValue } from '../json.js';
import type { ActionId, StepId, ToolCallId } from '../ids.js';

export type ActionStatus = 'pending' | 'approved' | 'denied' | 'executing' | 'succeeded' | 'failed' | 'skipped' | 'abandoned';

export interface AgentAction {
  id: ActionId;
  runId: string;
  stepId?: StepId;
  toolCallId?: ToolCallId;
  toolId: string;
  arguments: JsonValue;
  /** Deterministic key: same action replayed after a crash resolves to the same record. */
  idempotencyKey: string;
  idempotency: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  status: ActionStatus;
  risk?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  attempt: number;
  metadata?: JsonObject;
}

export interface ActionRecord extends AgentAction {
  result?: JsonValue;
  error?: JsonObject;
  policy?: JsonObject;
}

