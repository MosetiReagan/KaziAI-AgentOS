import {
  NotFoundError,
  ValidationError,
  hashObject,
  type JsonValue,
  type Logger,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import type { CheckpointPolicy } from '@kazi-ai/agentos-checkpoints';
import { compareVersions } from './prompt.js';
import { parseAgentDefinition, type AgentDefinition } from './definition.js';

export interface AgentDefinitionRecordLike {
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

export interface AgentDefinitionStoreLike {
  save(record: AgentDefinitionRecordLike): Promise<void>;
  get(organizationId: string, agentId: string, version?: string): Promise<AgentDefinitionRecordLike | undefined>;
  list(organizationId: string, projectId?: string): Promise<AgentDefinitionRecordLike[]>;
}

export interface RegisterAgentInput {
  organizationId: string;
  projectId: string;
  definition: AgentDefinition;
  /** Original YAML/JSON text, retained so the definition can be re-parsed. */
  source?: string;
}

const NOOP_STORE: AgentDefinitionStoreLike = {
  save: async () => {},
  get: async () => undefined,
  list: async () => [],
};

/**
 * Resolves agent definitions by id and version, with newest-version-default
 * semantics. Definitions are immutable once registered: a change is a new
 * version, so a run can always be replayed against the definition it used.
 */
export class AgentRegistry {
  private readonly memory = new Map<string, AgentDefinition>();
  private readonly store: AgentDefinitionStoreLike;
  private readonly logger?: Logger;

  constructor(options: { store?: AgentDefinitionStoreLike; logger?: Logger } = {}) {
    this.store = options.store ?? NOOP_STORE;
    if (options.logger) this.logger = options.logger;
  }

  static key(organizationId: string, agentId: string, version: string): string {
    return `${organizationId}/${agentId}@${version}`;
  }

  async register(input: RegisterAgentInput): Promise<AgentDefinition> {
    const definition = parseAgentDefinition(serializeAgentDefinition(input.definition));
    const existing = this.memory.get(AgentRegistry.key(input.organizationId, definition.id, definition.version));
    if (existing) {
      if (hashObject(serializeAgentDefinition(existing)) !== hashObject(serializeAgentDefinition(definition))) {
        throw new ValidationError(
          `Agent ${definition.id}@${definition.version} is already registered with different content; bump the version`,
          { agentId: definition.id, version: definition.version },
        );
      }
      return existing;
    }
    this.memory.set(AgentRegistry.key(input.organizationId, definition.id, definition.version), definition);
    await this.store.save({
      // The record's id is the agent id; (organization, id, version) is the
      // natural key, and the store keeps one row per version.
      id: definition.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      version: definition.version,
      name: definition.name ?? definition.id,
      source: input.source ?? JSON.stringify(serializeAgentDefinition(definition)),
      definition: serializeAgentDefinition(definition) as JsonValue,
      hash: hashObject(serializeAgentDefinition(definition)),
      createdAt: Date.now(),
    });
    this.logger?.info('agent definition registered', { agentId: definition.id, version: definition.version });
    return definition;
  }

  registerSync(input: RegisterAgentInput): AgentDefinition {
    const definition = parseAgentDefinition(serializeAgentDefinition(input.definition));
    const key = AgentRegistry.key(input.organizationId, definition.id, definition.version);
    const existing = this.memory.get(key);
    if (existing && hashObject(serializeAgentDefinition(existing)) !== hashObject(serializeAgentDefinition(definition))) {
      throw new ValidationError(
        `Agent ${definition.id}@${definition.version} is already registered with different content; bump the version`,
        { agentId: definition.id, version: definition.version },
      );
    }
    this.memory.set(key, definition);
    return definition;
  }

  async get(organizationId: string, agentId: string, version?: string): Promise<AgentDefinition> {
    if (version) {
      const key = AgentRegistry.key(organizationId, agentId, version);
      const found = this.memory.get(key) ?? (await this.loadFromStore(organizationId, agentId, version));
      if (!found) throw new NotFoundError('agent', `${agentId}@${version}`);
      return found;
    }
    const versions = this.versions(organizationId, agentId);
    const latest = versions.at(-1);
    if (!latest) {
      const loaded = await this.loadFromStore(organizationId, agentId);
      if (!loaded) throw new NotFoundError('agent', agentId);
      return loaded;
    }
    return this.get(organizationId, agentId, latest);
  }

  has(organizationId: string, agentId: string, version?: string): boolean {
    if (version) return this.memory.has(AgentRegistry.key(organizationId, agentId, version));
    return this.versions(organizationId, agentId).length > 0;
  }

  versions(organizationId: string, agentId: string): string[] {
    const prefix = `${organizationId}/${agentId}@`;
    return [...this.memory.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort(compareVersions);
  }

  list(organizationId: string): AgentDefinition[] {
    const prefix = `${organizationId}/`;
    return [...this.memory.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([, left], [, right]) => left.id.localeCompare(right.id) || compareVersions(left.version, right.version))
      .map(([, definition]) => definition);
  }

  async loadFromStore(organizationId: string, agentId: string, version?: string): Promise<AgentDefinition | undefined> {
    const record = await this.store.get(organizationId, agentId, version);
    if (!record) return undefined;
    const definition = parseAgentDefinition(record.definition);
    this.memory.set(AgentRegistry.key(organizationId, definition.id, definition.version), definition);
    return definition;
  }
}

/**
 * Serialize a definition back to the on-disk (snake_case) shape.
 * `parseAgentDefinition(serializeAgentDefinition(x))` is a fixed point, which is
 * what makes stored definitions re-parsable.
 */
export function serializeAgentDefinition(definition: AgentDefinition): Record<string, unknown> {
  const limits: Record<string, number> = {};
  if (definition.limits.maxSteps !== undefined) limits['max_steps'] = definition.limits.maxSteps;
  if (definition.limits.maxToolCalls !== undefined) limits['max_tool_calls'] = definition.limits.maxToolCalls;
  if (definition.limits.maxTokens !== undefined) limits['max_tokens'] = definition.limits.maxTokens;
  if (definition.limits.maxCostUsd !== undefined) limits['max_cost_usd'] = definition.limits.maxCostUsd;
  if (definition.limits.maxDurationSeconds !== undefined) limits['max_duration_seconds'] = definition.limits.maxDurationSeconds;
  if (definition.limits.maxNetworkRequests !== undefined) limits['max_network_requests'] = definition.limits.maxNetworkRequests;
  if (definition.limits.maxStorageBytes !== undefined) limits['max_storage_bytes'] = definition.limits.maxStorageBytes;
  if (definition.limits.maxRecoveryAttempts !== undefined) limits['max_recovery_attempts'] = definition.limits.maxRecoveryAttempts;
  if (definition.limits.stepTimeoutMs !== undefined) limits['step_timeout_ms'] = definition.limits.stepTimeoutMs;
  if (definition.limits.toolTimeoutMs !== undefined) limits['tool_timeout_ms'] = definition.limits.toolTimeoutMs;

  const recovery: Record<string, unknown> = { enabled: definition.recovery.enabled };
  for (const [kind, policy] of Object.entries(definition.recovery.policies)) {
    recovery[kind] = {
      strategy: policy.strategy,
      ...(policy.maxAttempts === undefined ? {} : { max_attempts: policy.maxAttempts }),
      ...(policy.baseDelayMs === undefined ? {} : { base_delay_ms: policy.baseDelayMs }),
      ...(policy.maxDelayMs === undefined ? {} : { max_delay_ms: policy.maxDelayMs }),
    };
  }

  return {
    id: definition.id,
    version: definition.version,
    ...(definition.name ? { name: definition.name } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    model: {
      provider: definition.model.provider,
      model: definition.model.model,
      ...(definition.model.temperature === undefined ? {} : { temperature: definition.model.temperature }),
      ...(definition.model.maxTokens === undefined ? {} : { max_tokens: definition.model.maxTokens }),
      ...(definition.model.baseUrl === undefined ? {} : { base_url: definition.model.baseUrl }),
    },
    ...(definition.providers
      ? {
          providers: {
            primary: definition.providers.primary,
            ...(definition.providers.fallback ? { fallback: definition.providers.fallback } : {}),
          },
        }
      : {}),
    system_prompt: definition.systemPrompt,
    tools: definition.tools,
    memory: {
      enabled: definition.memory.enabled,
      ...(definition.memory.ttlSeconds === undefined ? {} : { ttl_seconds: definition.memory.ttlSeconds }),
      ...(definition.memory.scopes === undefined ? {} : { scopes: definition.memory.scopes }),
      ...(definition.memory.maxEntries === undefined ? {} : { max_entries: definition.memory.maxEntries }),
    },
    planning: {
      enabled: definition.planning.enabled,
      ...(definition.planning.planner === undefined ? {} : { planner: definition.planning.planner }),
      ...(definition.planning.maxSteps === undefined ? {} : { max_steps: definition.planning.maxSteps }),
    },
    verification: {
      enabled: definition.verification.enabled,
      ...(definition.verification.checks === undefined ? {} : { checks: definition.verification.checks }),
      ...(definition.verification.commands === undefined ? {} : { commands: definition.verification.commands }),
    },
    recovery,
    limits,
    permissions: toRawPermissions(definition.permissions),
    ...(definition.checkpointing ? { checkpointing: toRawCheckpointing(definition.checkpointing) } : {}),
    ...(definition.experiment ? { experiment: definition.experiment } : {}),
    ...(definition.metadata ? { metadata: definition.metadata } : {}),
  };
}

function toRawPermissions(permissions: ToolPermissions): Record<string, unknown> {
  return {
    ...(permissions.filesystem ? { filesystem: { ...permissions.filesystem } } : {}),
    ...(permissions.terminal
      ? {
          terminal: {
            ...(permissions.terminal.execute === undefined ? {} : { execute: permissions.terminal.execute }),
            ...(permissions.terminal.allowCommands === undefined ? {} : { allow_commands: permissions.terminal.allowCommands }),
            ...(permissions.terminal.denyCommands === undefined ? {} : { deny_commands: permissions.terminal.denyCommands }),
          },
        }
      : {}),
    ...(permissions.network
      ? {
          network: {
            ...(permissions.network.enabled === undefined ? {} : { enabled: permissions.network.enabled }),
            ...(permissions.network.allowedHosts === undefined ? {} : { allowed_hosts: permissions.network.allowedHosts }),
            ...(permissions.network.methods === undefined ? {} : { methods: permissions.network.methods }),
          },
        }
      : {}),
    ...(permissions.git ? { git: { ...permissions.git } } : {}),
    ...(permissions.database ? { database: { ...permissions.database } } : {}),
  };
}

function toRawCheckpointing(policy: Partial<CheckpointPolicy>): Record<string, unknown> {
  return {
    ...(policy.afterPlan === undefined ? {} : { after_plan: policy.afterPlan }),
    ...(policy.afterToolCall === undefined ? {} : { after_tool_call: policy.afterToolCall }),
    ...(policy.afterStateChange === undefined ? {} : { after_state_change: policy.afterStateChange }),
    ...(policy.beforeRiskyAction === undefined ? {} : { before_risky_action: policy.beforeRiskyAction }),
    ...(policy.beforeRecovery === undefined ? {} : { before_recovery: policy.beforeRecovery }),
    ...(policy.beforePause === undefined ? {} : { before_pause: policy.beforePause }),
    ...(policy.intervalMs === undefined ? {} : { interval_ms: policy.intervalMs }),
    ...(policy.everyNSteps === undefined ? {} : { every_n_steps: policy.everyNSteps }),
    ...(policy.retain === undefined ? {} : { retain: policy.retain }),
    ...(policy.workspaceSnapshots === undefined ? {} : { workspace_snapshots: policy.workspaceSnapshots }),
  };
}
