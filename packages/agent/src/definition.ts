import { ValidationError, type ModelRef, type RunLimits, type ToolPermissions } from '@kazi-ai/agentos-core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseRecoveryPolicies, type RecoveryPolicyMap } from '@kazi-ai/agentos-recovery';
import type { CheckpointPolicy } from '@kazi-ai/agentos-checkpoints';
import type { PromptSource } from './prompt.js';

export interface AgentModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

export interface AgentMemoryConfig {
  enabled: boolean;
  ttlSeconds?: number;
  scopes?: string[];
  maxEntries?: number;
}

export interface AgentPlanningConfig {
  enabled: boolean;
  planner?: string;
  maxSteps?: number;
}

export interface AgentVerificationConfig {
  enabled: boolean;
  checks?: string[];
  /** Commands the verifier is allowed to run, e.g. `pnpm test`. */
  commands?: string[];
}

export interface AgentRecoveryConfig {
  enabled: boolean;
  policies: RecoveryPolicyMap;
}

/**
 * The declarative agent definition (spec §6). Everything the runtime needs to
 * execute an agent, with no code required.
 */
export interface AgentDefinition {
  id: string;
  version: string;
  name?: string;
  description?: string;
  model: AgentModelConfig;
  providers?: { primary: ModelRef; fallback?: ModelRef[] };
  systemPrompt: PromptSource;
  tools: string[];
  memory: AgentMemoryConfig;
  planning: AgentPlanningConfig;
  verification: AgentVerificationConfig;
  recovery: AgentRecoveryConfig;
  limits: RunLimits;
  permissions: ToolPermissions;
  checkpointing?: Partial<CheckpointPolicy>;
  experiment?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const promptSourceSchema = z.union([
  z.string(),
  z.strictObject({ registry: z.string().min(1), version: z.string().optional() }),
]);

const modelSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  base_url: z.string().url().optional(),
});

const modelRefSchema = z.strictObject({ provider: z.string().min(1), model: z.string().min(1) });

const limitsSchema = z
  .strictObject({
    max_steps: z.number().int().nonnegative().optional(),
    max_tool_calls: z.number().int().nonnegative().optional(),
    max_tokens: z.number().int().nonnegative().optional(),
    max_cost_usd: z.number().nonnegative().optional(),
    max_duration_seconds: z.number().positive().optional(),
    max_network_requests: z.number().int().nonnegative().optional(),
    max_storage_bytes: z.number().int().nonnegative().optional(),
    max_recovery_attempts: z.number().int().nonnegative().optional(),
    step_timeout_ms: z.number().int().positive().optional(),
    tool_timeout_ms: z.number().int().positive().optional(),
  })
  .default({});

const permissionsSchema = z
  .strictObject({
    filesystem: z
      .strictObject({
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        delete: z.boolean().optional(),
        roots: z.array(z.string()).optional(),
      })
      .optional(),
    terminal: z
      .strictObject({
        execute: z.boolean().optional(),
        allow_commands: z.array(z.string()).optional(),
        deny_commands: z.array(z.string()).optional(),
      })
      .optional(),
    network: z
      .strictObject({
        enabled: z.boolean().optional(),
        allowed_hosts: z.array(z.string()).optional(),
        methods: z.array(z.string()).optional(),
      })
      .optional(),
    git: z
      .strictObject({
        read: z.boolean().optional(),
        commit: z.boolean().optional(),
        push: z.boolean().optional(),
      })
      .optional(),
    database: z
      .strictObject({
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        connections: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .default({});

const checkpointingSchema = z
  .strictObject({
    after_plan: z.boolean().optional(),
    after_tool_call: z.boolean().optional(),
    after_state_change: z.boolean().optional(),
    before_risky_action: z.boolean().optional(),
    before_recovery: z.boolean().optional(),
    before_pause: z.boolean().optional(),
    interval_ms: z.number().int().nonnegative().optional(),
    every_n_steps: z.number().int().positive().optional(),
    retain: z.number().int().positive().optional(),
    workspace_snapshots: z.boolean().optional(),
  })
  .optional();

export const agentDefinitionSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'agent ids use lowercase segments such as developer-agent'),
  version: z.string().regex(/^\d+\.\d+\.\d+/, 'version must be semver, e.g. 1.0.0'),
  name: z.string().optional(),
  description: z.string().optional(),
  model: modelSchema,
  providers: z
    .strictObject({ primary: modelRefSchema, fallback: z.union([modelRefSchema, z.array(modelRefSchema)]).optional() })
    .optional(),
  system_prompt: promptSourceSchema,
  tools: z.array(z.string()).default([]),
  memory: z
    .union([
      z.boolean(),
      z.strictObject({
        enabled: z.boolean().default(true),
        ttl_seconds: z.number().int().positive().optional(),
        scopes: z.array(z.string()).optional(),
        max_entries: z.number().int().positive().optional(),
      }),
    ])
    .default(false),
  planning: z
    .union([
      z.boolean(),
      z.strictObject({
        enabled: z.boolean().default(true),
        planner: z.string().optional(),
        max_steps: z.number().int().positive().optional(),
      }),
    ])
    .default(true),
  verification: z
    .union([
      z.boolean(),
      z.strictObject({
        enabled: z.boolean().default(true),
        checks: z.array(z.string()).optional(),
        commands: z.array(z.string()).optional(),
      }),
    ])
    .default(true),
  recovery: z
    .union([z.boolean(), z.strictObject({ enabled: z.boolean().default(true) }).catchall(z.unknown())])
    .default(true),
  limits: limitsSchema,
  permissions: permissionsSchema,
  checkpointing: checkpointingSchema,
  experiment: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type RawAgentDefinition = z.input<typeof agentDefinitionSchema>;

/**
 * Validate a raw agent definition object. Unknown keys are rejected so a typo
 * in a YAML file fails loudly at load time rather than silently changing
 * runtime behaviour (spec §77).
 */
export function parseAgentDefinition(input: unknown): AgentDefinition {
  const result = agentDefinitionSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Invalid agent definition: ${result.error.issues.map(describeIssue).join('; ')}`, {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  const raw = result.data;
  return {
    id: raw.id,
    version: raw.version,
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    model: {
      provider: raw.model.provider,
      model: raw.model.model,
      ...(raw.model.temperature === undefined ? {} : { temperature: raw.model.temperature }),
      ...(raw.model.max_tokens === undefined ? {} : { maxTokens: raw.model.max_tokens }),
      ...(raw.model.base_url === undefined ? {} : { baseUrl: raw.model.base_url }),
    },
    ...(raw.providers
      ? {
          providers: {
            primary: raw.providers.primary,
            ...(raw.providers.fallback === undefined
              ? {}
              : { fallback: Array.isArray(raw.providers.fallback) ? raw.providers.fallback : [raw.providers.fallback] }),
          },
        }
      : {}),
    systemPrompt: raw.system_prompt,
    tools: raw.tools,
    memory: memoryOf(raw.memory),
    planning: planningOf(raw.planning),
    verification: verificationOf(raw.verification),
    recovery: {
      enabled: recoveryEnabled(raw.recovery),
      policies: parseRecoveryPolicies({ recovery: recoveryPolicies(raw.recovery) }),
    },
    limits: limitsOf(raw.limits),
    permissions: permissionsOf(raw.permissions),
    ...(raw.checkpointing ? { checkpointing: checkpointingOf(raw.checkpointing) } : {}),
    ...(raw.experiment ? { experiment: raw.experiment } : {}),
    ...(raw.metadata ? { metadata: raw.metadata } : {}),
  };
}

export function parseAgentDefinitionYaml(text: string): AgentDefinition {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new ValidationError(`Agent definition is not valid YAML: ${(error as Error).message}`, {
      cause: (error as Error).message,
    });
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ValidationError('Agent definition must be a YAML mapping');
  }
  return parseAgentDefinition(document);
}

function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

function memoryOf(value: boolean | Record<string, unknown>): AgentDefinition['memory'] {
  if (value === false) return { enabled: false };
  if (value === true) return { enabled: true };
  const scopes = value['scopes'];
  return {
    enabled: value['enabled'] !== false,
    ...(typeof value['ttl_seconds'] === 'number' ? { ttlSeconds: value['ttl_seconds'] } : {}),
    ...(Array.isArray(scopes) ? { scopes: scopes.filter((item): item is string => typeof item === 'string') } : {}),
    ...(typeof value['max_entries'] === 'number' ? { maxEntries: value['max_entries'] } : {}),
  };
}

function planningOf(value: boolean | Record<string, unknown>): AgentDefinition['planning'] {
  if (value === false) return { enabled: false };
  if (value === true) return { enabled: true };
  return {
    enabled: value['enabled'] !== false,
    ...(typeof value['planner'] === 'string' ? { planner: value['planner'] } : {}),
    ...(typeof value['max_steps'] === 'number' ? { maxSteps: value['max_steps'] } : {}),
  };
}

function verificationOf(value: boolean | Record<string, unknown>): AgentDefinition['verification'] {
  if (value === false) return { enabled: false };
  if (value === true) return { enabled: true };
  const checks = value['checks'];
  const commands = value['commands'];
  return {
    enabled: value['enabled'] !== false,
    ...(Array.isArray(checks) ? { checks: checks.filter((item): item is string => typeof item === 'string') } : {}),
    ...(Array.isArray(commands) ? { commands: commands.filter((item): item is string => typeof item === 'string') } : {}),
  };
}

function recoveryEnabled(value: boolean | Record<string, unknown>): boolean {
  if (typeof value === 'boolean') return value;
  return value['enabled'] !== false;
}

function recoveryPolicies(
  value: boolean | Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof value === 'boolean') return undefined;
  const policies: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'enabled') continue;
    policies[key] = entry;
  }
  return policies;
}

function limitsOf(raw: z.infer<typeof limitsSchema>): RunLimits {
  const limits: RunLimits = {};
  if (raw.max_steps !== undefined) limits.maxSteps = raw.max_steps;
  if (raw.max_tool_calls !== undefined) limits.maxToolCalls = raw.max_tool_calls;
  if (raw.max_tokens !== undefined) limits.maxTokens = raw.max_tokens;
  if (raw.max_cost_usd !== undefined) limits.maxCostUsd = raw.max_cost_usd;
  if (raw.max_duration_seconds !== undefined) limits.maxDurationSeconds = raw.max_duration_seconds;
  if (raw.max_network_requests !== undefined) limits.maxNetworkRequests = raw.max_network_requests;
  if (raw.max_storage_bytes !== undefined) limits.maxStorageBytes = raw.max_storage_bytes;
  if (raw.max_recovery_attempts !== undefined) limits.maxRecoveryAttempts = raw.max_recovery_attempts;
  if (raw.step_timeout_ms !== undefined) limits.stepTimeoutMs = raw.step_timeout_ms;
  if (raw.tool_timeout_ms !== undefined) limits.toolTimeoutMs = raw.tool_timeout_ms;
  return limits;
}

function permissionsOf(raw: z.infer<typeof permissionsSchema>): ToolPermissions {
  const permissions: ToolPermissions = {};
  if (raw.filesystem) {
    permissions.filesystem = {
      ...(raw.filesystem.read === undefined ? {} : { read: raw.filesystem.read }),
      ...(raw.filesystem.write === undefined ? {} : { write: raw.filesystem.write }),
      ...(raw.filesystem.delete === undefined ? {} : { delete: raw.filesystem.delete }),
      ...(raw.filesystem.roots === undefined ? {} : { roots: raw.filesystem.roots }),
    };
  }
  if (raw.terminal) {
    permissions.terminal = {
      ...(raw.terminal.execute === undefined ? {} : { execute: raw.terminal.execute }),
      ...(raw.terminal.allow_commands === undefined ? {} : { allowCommands: raw.terminal.allow_commands }),
      ...(raw.terminal.deny_commands === undefined ? {} : { denyCommands: raw.terminal.deny_commands }),
    };
  }
  if (raw.network) {
    permissions.network = {
      ...(raw.network.enabled === undefined ? {} : { enabled: raw.network.enabled }),
      ...(raw.network.allowed_hosts === undefined ? {} : { allowedHosts: raw.network.allowed_hosts }),
      ...(raw.network.methods === undefined ? {} : { methods: raw.network.methods }),
    };
  }
  if (raw.git) {
    permissions.git = {
      ...(raw.git.read === undefined ? {} : { read: raw.git.read }),
      ...(raw.git.commit === undefined ? {} : { commit: raw.git.commit }),
      ...(raw.git.push === undefined ? {} : { push: raw.git.push }),
    };
  }
  if (raw.database) {
    permissions.database = {
      ...(raw.database.read === undefined ? {} : { read: raw.database.read }),
      ...(raw.database.write === undefined ? {} : { write: raw.database.write }),
      ...(raw.database.connections === undefined ? {} : { connections: raw.database.connections }),
    };
  }
  return permissions;
}

function checkpointingOf(raw: NonNullable<z.infer<typeof checkpointingSchema>>): Partial<CheckpointPolicy> {
  return {
    ...(raw.after_plan === undefined ? {} : { afterPlan: raw.after_plan }),
    ...(raw.after_tool_call === undefined ? {} : { afterToolCall: raw.after_tool_call }),
    ...(raw.after_state_change === undefined ? {} : { afterStateChange: raw.after_state_change }),
    ...(raw.before_risky_action === undefined ? {} : { beforeRiskyAction: raw.before_risky_action }),
    ...(raw.before_recovery === undefined ? {} : { beforeRecovery: raw.before_recovery }),
    ...(raw.before_pause === undefined ? {} : { beforePause: raw.before_pause }),
    ...(raw.interval_ms === undefined ? {} : { intervalMs: raw.interval_ms }),
    ...(raw.every_n_steps === undefined ? {} : { everyNSteps: raw.every_n_steps }),
    ...(raw.retain === undefined ? {} : { retain: raw.retain }),
    ...(raw.workspace_snapshots === undefined ? {} : { workspaceSnapshots: raw.workspace_snapshots }),
  };
}
