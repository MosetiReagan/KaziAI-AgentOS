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

