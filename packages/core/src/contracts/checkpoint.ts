import type { JsonObject } from '../json.js';
import type { AgentState, Observation, RunConfigSnapshot, RunUsage } from './run.js';
import type { Plan } from './plan.js';
import type { AgentAction } from './action.js';

export interface ContextSnapshot {
  objective: string;
  plan?: Plan;
  completedSteps: string[];
  pendingSteps: string[];
  observations: Observation[];
  memoryRefs: string[];
  verification?: { passed: boolean; summary: string; at: number };
}

export interface EnvironmentSnapshot {
  /** Opaque, environment-specific handle (e.g. docker image id + volume). */
  kind: string;
  workspaceDir: string;
  /** Files changed inside the workspace, with content hashes. */
  files?: Array<{ path: string; sha256: string; size: number }>;
  handle?: JsonObject;
  capturedAt: number;
}

export interface SerializedAgentState {
  runId: string;
  status: string;
  stateVersion: number;
  goal: string;
  config: RunConfigSnapshot;
  usage: RunUsage;
  plan?: Plan;
  currentStepId?: string;
  observations: Observation[];
  context: JsonObject;
  /** Actions that completed; replay must not re-execute these. */
  committedActions: Array<{ id: string; idempotencyKey: string; toolId: string; status: string }>;
  pendingAction?: AgentAction;
}

export interface Checkpoint {
  id: string;
  runId: string;
  sequence: number;
  state: SerializedAgentState;
  contextSnapshot: ContextSnapshot;
  environmentSnapshot?: EnvironmentSnapshot;
  stateVersion: number;
  label?: string;
  createdAt: number;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  latest(runId: string): Promise<Checkpoint | undefined>;
  get(checkpointId: string): Promise<Checkpoint | undefined>;
  list(runId: string): Promise<Checkpoint[]>;
  delete(checkpointId: string): Promise<void>;
}

export interface AgentStateStore {
  load(runId: string): Promise<SerializedAgentState | undefined>;
  save(state: SerializedAgentState, expectedVersion?: number): Promise<void>;
}

export function toAgentState(state: SerializedAgentState): AgentState {
  return {
    runId: state.runId,
    status: state.status as AgentState['status'],
    stateVersion: state.stateVersion,
    ...(state.plan ? { plan: state.plan } : {}),
    ...(state.currentStepId ? { currentStepId: state.currentStepId } : {}),
    usage: state.usage,
    context: state.context,
    observations: state.observations,
    updatedAt: Date.now(),
  };
}

