import type {
  AgentEvent,
  AgentRun,
  AgentState,
  Approval,
  Checkpoint,
  CheckpointRef,
  MemoryEntry,
  Observation,
  Plan,
  RiskLevel,
  RunLimits,
  RunState,
  RunUsage,
  Trace,
  TraceNode,
} from '@kazi-ai/agentos-core';

/**
 * The dashboard reuses the runtime's own contracts instead of restating them,
 * so a change to a run's shape is a compile error here rather than a blank
 * panel in production.
 */
export type {
  AgentEvent,
  AgentRun,
  AgentState,
  Approval,
  Checkpoint,
  CheckpointRef,
  MemoryEntry,
  Observation,
  Plan,
  RiskLevel,
  RunLimits,
  RunState,
  RunUsage,
  Trace,
  TraceNode,
};

/** Append-only journal records, as served by `/api/runs/:id/...`. */
export interface StepRecord {
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
  detail?: Record<string, unknown>;
  error?: Record<string, unknown>;
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
  detail?: Record<string, unknown>;
}

export interface RecoveryAttemptRecord {
  id: string;
  runId: string;
  failureId?: string;
  attempt: number;
  strategy: string;
  decision: Record<string, unknown>;
  result?: Record<string, unknown>;
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

export interface Page<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
}

export interface AgentSummary {
  id: string;
  version: string;
  name?: string;
  description?: string;
  model: { provider: string; model: string };
  tools: string[];
  source: 'store' | 'file';
  dir?: string;
}

export interface ToolSummary {
  id: string;
  description: string;
  kind: string;
  risk: string;
  timeoutMs?: number;
}

export interface ProviderSummary {
  id: string;
  kind: string;
  supportsStreaming: boolean;
}

export interface PolicyRuleView {
  id: string;
  description?: string;
  effect?: string;
  risk?: RiskLevel;
  tools?: string[];
}

export interface RiskRuleView {
  id: string;
  description?: string;
  risk: RiskLevel;
  tool?: string;
  conditional: boolean;
}

export interface Principal {
  id: string;
  kind: string;
  role: 'admin' | 'operator' | 'developer' | 'viewer';
  organizationId: string;
  projectId?: string;
  name?: string;
}

export interface Identity {
  organization: { id: string; name?: string; slug?: string; createdAt?: number } | null;
  project: { id: string; name?: string; organizationId?: string; createdAt?: number } | null;
  principal: { id: string; kind: string; role: string };
}

export interface RunResult {
  runId: string;
  status: RunState;
  success: boolean;
  durationMs: number;
  steps: number;
  toolCalls: number;
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  costUsd?: number;
  recoveryCount: number;
  policyViolations: number;
  artifacts?: { id: string; name?: string; mimeType?: string; size?: number }[];
  traceId?: string;
}

export interface MemorySummary {
  byType: Record<string, number>;
  expired: number;
  averageImportance: number;
}

export interface RuntimeInfo {
  dataDir: string;
  driver: string;
  providers?: { id: string; kind: string; supportsStreaming: boolean }[];
  tools?: { id: string; kind: string; risk: string }[];
  agents: number;
}
