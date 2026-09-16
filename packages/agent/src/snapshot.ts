import {
  mergePermissions,
  type AgentRunInput,
  type JsonObject,
  type JsonValue,
  type ModelRef,
  type RunConfigSnapshot,
  type RunLimits,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import type { AgentDefinition } from './definition.js';
import type { ResolvedPrompt } from './prompt.js';

export interface EffectiveConfigInput {
  definition: AgentDefinition;
  resolvedPrompt?: ResolvedPrompt;
  /** Overrides applied after the definition, in precedence order (spec §77). */
  overrides?: {
    limits?: RunLimits;
    permissions?: ToolPermissions;
    providers?: { primary: ModelRef; fallback?: ModelRef[] };
    tools?: string[];
    model?: { provider?: string; model?: string };
  };
  research?: JsonObject;
}

export interface EffectiveConfig {
  config: RunConfigSnapshot;
  metadata: JsonObject;
}

/**
 * Snapshot the effective configuration of a run so it is reproducible even if
 * the agent definition is later edited (spec §78).
 */
export function effectiveConfig(input: EffectiveConfigInput): EffectiveConfig {
  const { definition } = input;
  const overrides = input.overrides ?? {};
  const primary = overrides.providers?.primary ?? definition.providers?.primary ?? {
    provider: overrides.model?.provider ?? definition.model.provider,
    model: overrides.model?.model ?? definition.model.model,
  };
  const fallback = overrides.providers?.fallback ?? definition.providers?.fallback;
  const tools = overrides.tools ?? definition.tools;
  const limits: RunLimits = { ...definition.limits, ...(overrides.limits ?? {}) };
  // Overrides can only narrow: permissions are intersected, never widened.
  const permissions = overrides.permissions
    ? mergePermissions([definition.permissions, overrides.permissions])
    : definition.permissions;

  const config: RunConfigSnapshot = {
    agentId: definition.id,
    agentVersion: definition.version,
    model: primary.model,
    provider: primary.provider,
    ...(fallback && fallback.length > 0 ? { fallbackProviders: fallback } : {}),
    tools,
    limits,
    permissions,
    memoryEnabled: definition.memory.enabled,
    planningEnabled: definition.planning.enabled,
    verificationEnabled: definition.verification.enabled,
    recoveryEnabled: definition.recovery.enabled,
    ...(input.research ? { research: input.research } : {}),
  };

  const metadata: JsonObject = {};
  if (input.resolvedPrompt) {
    metadata['prompt'] = {
      id: input.resolvedPrompt.id,
      version: input.resolvedPrompt.version,
      hash: input.resolvedPrompt.hash,
    };
  }
  metadata['agent'] = { id: definition.id, version: definition.version } as JsonValue;
  if (definition.experiment) metadata['experiment'] = definition.experiment as JsonValue;

  return { config, metadata };
}

export interface RunInputFromDefinitionInput {
  definition: AgentDefinition;
  goal: string;
  organizationId: string;
  projectId: string;
  resolvedPrompt?: ResolvedPrompt;
  overrides?: EffectiveConfigInput['overrides'];
  parentRunId?: string;
  labels?: Record<string, string>;
  metadata?: JsonObject;
  research?: JsonObject;
}

export function runInputFromDefinition(input: RunInputFromDefinitionInput): AgentRunInput {
  const { config, metadata } = effectiveConfig({
    definition: input.definition,
    ...(input.resolvedPrompt ? { resolvedPrompt: input.resolvedPrompt } : {}),
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.research ? { research: input.research } : {}),
  });
  return {
    goal: input.goal,
    agentId: input.definition.id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    config,
    limits: config.limits,
    permissions: config.permissions,
    metadata: { ...metadata, ...(input.metadata ?? {}) },
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.labels ? { labels: input.labels } : {}),
  };
}
