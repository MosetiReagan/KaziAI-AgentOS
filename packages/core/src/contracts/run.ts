import type { JsonObject, JsonValue } from '../json.js';
import type { RunId } from '../ids.js';
import type { RunState } from '../state-machine.js';
import type { Plan } from './plan.js';
import type { RiskLevel } from './policy.js';
import type { TokenUsage } from './model.js';
import type { ToolPermissions } from './tool.js';

export type RunStatus = RunState;

export interface RunLimits {
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationSeconds?: number;
  maxNetworkRequests?: number;
  maxStorageBytes?: number;
  maxRecoveryAttempts?: number;
  stepTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export interface RunUsage {
  steps: number;
  toolCalls: number;
  tokens: TokenUsage;
  costUsd: number;
  networkRequests: number;
  storageBytes: number;
  durationMs: number;
  recoveryCount: number;
  checkpointCount: number;
  modelCalls: number;
}

export function emptyUsage(): RunUsage {
  return {
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
  };
}

export interface ModelRef {
  provider: string;
  model: string;
}

export interface AgentRunInput {
  goal: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  /** Snapshot of effective configuration for reproducibility. */
  config?: RunConfigSnapshot;
  limits?: RunLimits;
  permissions?: ToolPermissions;
  metadata?: JsonObject;
  parentRunId?: string;
  /** Optional override for the provider chain used by this run. */
  providers?: { primary: ModelRef; fallback?: ModelRef[] };
  labels?: Record<string, string>;
  /**
   * What the run's workspace starts with (spec §70). A coding agent needs the
   * repository in front of it, and a caller that could not put it there would
   * have to reach around the runtime's own boundary to do it.
   */
  workspace?: WorkspaceSeedInput;
}

export interface WorkspaceSeedInput {
  /** Files written into the workspace before the run starts. */
  files?: Record<string, string>;
  /** A host directory copied into the workspace; resolved by the caller. */
  copyFrom?: string;
  /** Path segments skipped while copying, e.g. `node_modules`. */
  ignore?: string[];
}

export interface RunConfigSnapshot {
  agentId: string;
  agentVersion?: string;
  model: string;
  provider: string;
  fallbackProviders?: ModelRef[];
  tools: string[];
  limits: RunLimits;
  permissions: ToolPermissions;
  memoryEnabled: boolean;
  planningEnabled: boolean;
  verificationEnabled: boolean;
  recoveryEnabled: boolean;
  research?: JsonObject;
}

export interface AgentRun {
  id: RunId;
  goal: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  status: RunState;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  config: RunConfigSnapshot;
  limits: RunLimits;
  usage: RunUsage;
  plan?: Plan;
  currentStepId?: string;
  parentRunId?: string;
  rootRunId: string;
  traceId: string;
  workspaceDir: string;
  error?: JsonObject;
  labels?: Record<string, string>;
  metadata?: JsonObject;
}

export interface AgentState {
  runId: string;
  status: RunState;
  stateVersion: number;
  plan?: Plan;
  currentStepId?: string;
  usage: RunUsage;
  context: JsonObject;
  observations: Observation[];
  updatedAt: number;
}

export interface Observation {
  id: string;
  at: number;
  source: 'tool' | 'model' | 'verification' | 'recovery' | 'human' | 'system';
  trust: 'trusted-policy' | 'untrusted-tool' | 'untrusted-external' | 'agent' | 'user' | 'trusted-system';
  summary: string;
  detail?: JsonValue;
  stepId?: string;
  toolId?: string;
}

export interface AgentRunResult {
  runId: string;
  status: RunState;
  success: boolean;
  durationMs: number;
  steps: number;
  toolCalls: number;
  tokenUsage: TokenUsage;
  costUsd?: number;
  recoveryCount: number;
  policyViolations: number;
  artifacts: ArtifactRef[];
  traceId: string;
  verification?: { passed: boolean; summary: string };
  error?: JsonObject;
  labels?: Record<string, string>;
}

export interface ArtifactRef {
  artifactId: string;
  runId: string;
  name: string;
  sha256: string;
  size: number;
  mimeType: string;
  createdAt: number;
  path?: string;
}

export interface AgentRuntime {
  createRun(input: AgentRunInput): Promise<AgentRun>;
  start(runId: string): Promise<void>;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  retry(runId: string): Promise<void>;
  getRun(runId: string): Promise<AgentRun>;
  getState(runId: string): Promise<AgentState>;
  getTrace(runId: string): Promise<Trace>;
  checkpoint(runId: string): Promise<CheckpointRef>;
}

export interface Trace {
  runId: string;
  traceId: string;
  nodes: TraceNode[];
  summary: {
    steps: number;
    toolCalls: number;
    failures: number;
    recoveries: number;
    checkpoints: number;
    durationMs: number;
    costUsd: number;
    tokens: number;
  };
}

export type TraceNodeKind =
  | 'run'
  | 'plan'
  | 'step'
  | 'tool'
  | 'observation'
  | 'verification'
  | 'recovery'
  | 'checkpoint'
  | 'approval'
  | 'model';

export interface TraceNode {
  id: string;
  kind: TraceNodeKind;
  label: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  risk?: RiskLevel;
  toolId?: string;
  stepId?: string;
  /** How many events folded into this node (e.g. retries of one action). */
  attempts?: number;
  detail?: JsonObject;
  children?: TraceNode[];
}

export interface CheckpointRef {
  id: string;
  runId: string;
  sequence: number;
  createdAt: number;
  stateVersion: number;
  label?: string;
}

