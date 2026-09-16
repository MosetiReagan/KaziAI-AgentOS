import {
  type AgentRun,
  type AgentState,
  type Checkpoint,
  type CheckpointRef,
  type ContextSnapshot,
  type JournalEntry,
  type SerializedAgentState,
} from '@kazi-ai/agentos-core';

/**
 * Build the durable picture of a run: everything needed to continue it after a
 * crash, without reading process memory (spec §27, §42).
 */
export function serializeState(input: {
  run: AgentRun;
  state: AgentState;
  committedActions: JournalEntry[];
}): SerializedAgentState {
  const plan = input.state.plan ?? input.run.plan;
  return {
    runId: input.run.id,
    organizationId: input.run.organizationId,
    projectId: input.run.projectId,
    status: input.state.status,
    stateVersion: input.state.stateVersion,
    goal: input.run.goal,
    config: input.run.config,
    usage: input.state.usage,
    ...(plan ? { plan } : {}),
    ...(input.state.currentStepId ?? input.run.currentStepId
      ? { currentStepId: input.state.currentStepId ?? input.run.currentStepId }
      : {}),
    observations: input.state.observations,
    context: input.state.context,
    committedActions: input.committedActions.map((entry) => ({
      id: entry.actionId,
      idempotencyKey: entry.idempotencyKey,
      toolId: entry.toolId,
      status: entry.status,
    })),
  };
}

export function buildContextSnapshot(input: {
  objective: string;
  state: AgentState;
  verification?: ContextSnapshot['verification'];
}): ContextSnapshot {
  const plan = input.state.plan;
  const steps = plan?.steps ?? [];
  return {
    objective: input.objective,
    ...(plan ? { plan } : {}),
    completedSteps: steps.filter((step) => step.status === 'completed').map((step) => step.id),
    pendingSteps: steps
      .filter((step) => step.status === 'pending' || step.status === 'running')
      .map((step) => step.id),
    observations: input.state.observations,
    memoryRefs: memoryRefsOf(input.state),
    ...(input.verification ? { verification: input.verification } : {}),
  };
}

function memoryRefsOf(state: AgentState): string[] {
  const value = state.context['memoryRefs'];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function toCheckpointRef(checkpoint: Checkpoint): CheckpointRef {
  return {
    id: checkpoint.id,
    runId: checkpoint.runId,
    sequence: checkpoint.sequence,
    createdAt: checkpoint.createdAt,
    stateVersion: checkpoint.stateVersion,
    ...(checkpoint.label ? { label: checkpoint.label } : {}),
  };
}
