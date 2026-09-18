import type { JsonObject, JsonValue } from '@kazi-ai/agentos-core';

export interface RunStepRecord {
  id: string;
  runId: string;
  index: number;
  description: string;
  phase: 'plan' | 'execute' | 'observe' | 'verify' | 'recover';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  toolId?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  detail?: JsonObject;
  error?: JsonObject;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  organizationId: string;
  projectId: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
  mimeType: string;
  createdAt: number;
}

export interface ModelUsageRecord {
  id: string;
  runId: string;
  organizationId: string;
  projectId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  latencyMs: number;
  costUsd?: number;
  success: boolean;
  at: number;
}

export interface FailureRecord {
  id: string;
  runId: string;
  stepId?: string;
  toolId?: string;
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  terminal: boolean;
  at: number;
  detail?: JsonObject;
}

export interface RecoveryAttemptRecord {
  id: string;
  runId: string;
  failureId?: string;
  attempt: number;
  strategy: string;
  decision: JsonObject;
  result?: JsonObject;
  success: boolean;
  at: number;
}

export interface ToolInvocationRecord {
  id: string;
  runId: string;
  toolId: string;
  actionId: string;
  status: string;
  durationMs: number;
  success: boolean;
  at: number;
}

export interface PolicyDecisionRecord {
  id: string;
  runId: string;
  actionId?: string;
  toolId: string;
  outcome: string;
  ruleId: string;
  reason: string;
  risk: string;
  at: number;
}

export interface AgentDefinitionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  version: string;
  name: string;
  source: string;
  definition: JsonValue;
  hash: string;
  createdAt: number;
}

export interface PolicyDefinitionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  version: number;
  definition: JsonValue;
  createdAt: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface RunListFilter {
  organizationId?: string;
  projectId?: string;
  status?: string[];
  agentId?: string;
  parentRunId?: string;
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'updatedAt';
  direction?: 'asc' | 'desc';
}


/**
 * A webhook subscription belongs to a tenant and (optionally) a project. The
 * signing secret is only ever used to compute an HMAC over the delivery body
 * (spec §98); it is never echoed back by the API.
 */
export interface WebhookSubscriptionRecord {
  id: string;
  organizationId: string;
  projectId: string;
  url: string;
  /** Event types to deliver; an empty list means every event. */
  events: string[];
  secret: string;
  active: boolean;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDeliveryRecord {
  id: string;
  subscriptionId: string;
  organizationId: string;
  eventId: string;
  eventType: string;
  runId?: string;
  url: string;
  status: 'delivered' | 'failed';
  attempts: number;
  responseStatus?: number;
  error?: string;
  at: number;
  durationMs: number;
}

export interface WebhookListFilter {
  organizationId?: string;
  projectId?: string;
  active?: boolean;
}

/** Durable webhook subscriptions and their delivery log (spec §98). */
export interface WebhookStore {
  save(subscription: WebhookSubscriptionRecord): Promise<void>;
  get(id: string): Promise<WebhookSubscriptionRecord | undefined>;
  list(filter?: WebhookListFilter): Promise<WebhookSubscriptionRecord[]>;
  remove(id: string): Promise<void>;
  recordDelivery(delivery: WebhookDeliveryRecord): Promise<void>;
  listDeliveries(subscriptionId: string, options?: { limit?: number }): Promise<WebhookDeliveryRecord[]>;
}
