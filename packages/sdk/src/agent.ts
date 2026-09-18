import {
  ConfigurationError,
  ValidationError,
  mergePermissions,
  type AgentRun,
  type AgentRunInput,
  type AgentRunResult,
  type AgentState,
  type CheckpointRef,
  type JsonObject,
  type RunLimits,
  type ToolPermissions,
  type Trace,
} from '@kazi-ai/agentos-core';
import {
  expandToolFamilies,
  parseAgentDefinition,
  type AgentDefinition,
} from '@kazi-ai/agentos-agent';
import type { DefaultToolRegistry } from '@kazi-ai/agentos-tools';
import type { ProgressVerifier } from '@kazi-ai/agentos-runtime';
import type { Planner } from '@kazi-ai/agentos-core';
import type { AgentOS } from './agentos.js';

export interface AgentModelOptions {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
}

export interface AgentOptions {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  model: AgentModelOptions;
  systemPrompt?: string;
  /** Tool ids; a family such as `filesystem` expands to `filesystem.*`. */
  tools?: string[];
  memory?: boolean;
  planning?: boolean;
  verification?: boolean;
  recovery?: boolean;
  limits?: RunLimits;
  permissions?: ToolPermissions;
  /** Optional fallback models, tried only for retryable provider failures (spec §38). */
  fallback?: AgentModelOptions[];
  organizationId?: string;
  projectId?: string;
  /**
   * Replace the planner for this agent only (spec §74).
   */
  planner?: Planner;
  /** Replace progress verification for this agent only (spec §74). */
  verifier?: ProgressVerifier;
}

/**
 * An agent is either declared in code (`AgentOptions`) or handed over as an
 * already-parsed definition, e.g. one loaded from `agents/developer-agent.yaml`.
 */
export type AgentSpec = AgentOptions | AgentDefinitionSpec;

export interface AgentDefinitionSpec extends AgentDefinition {
  organizationId?: string;
  projectId?: string;
}

export function isDefinitionSpec(spec: AgentSpec): spec is AgentDefinitionSpec {
  return 'systemPrompt' in spec && typeof spec.model === 'object' && 'provider' in spec.model;
}

export interface AgentRunRequest {
  goal: string;
  organizationId?: string;
  projectId?: string;
  limits?: RunLimits;
  permissions?: ToolPermissions;
  metadata?: JsonObject;
  labels?: Record<string, string>;
  parentRunId?: string;
}

export const DEFAULT_AGENT_TOOLS = ['filesystem', 'terminal'];

/**
 * What an agent may do without asking, following the permission example in the
 * specification (spec §21): its own workspace is readable and writable, the
 * terminal is available, but the network is off and nothing can be pushed to a
 * remote repository. Everything else is default-deny.
 *
 * Note what is *not* here: `terminal.allowUnisolated`. A tool that declares
 * `sandbox.requiresIsolation` is refused on an environment that does not
 * isolate it, so an agent on a host-process environment has to opt in
 * explicitly — and that choice is then visible in the run's configuration
 * snapshot and in the policy decision that allowed it (spec §15).
 */
export const DEFAULT_AGENT_PERMISSIONS: ToolPermissions = {
  filesystem: { read: true, write: true, delete: false },
  terminal: { execute: true },
  network: { enabled: false },
  git: { read: true, commit: true, push: false },
  database: { read: false, write: false },
};

/**
 * A declaratively configured agent (spec §6, §72).
 *
 * `Agent` is a thin, deliberate façade: it builds a validated definition,
 * registers it, snapshots the effective configuration onto every run, and hands
 * the actual execution to the runtime. Nothing about durability, policy or
 * recovery is re-implemented here.
 */
export class Agent {
  readonly id: string;
  readonly version: string;
  readonly definition: AgentDefinition;
  /** Tenant scope this agent runs in. */
  readonly scope: { organizationId?: string; projectId?: string };
  /** Optional per-agent replacements resolved by the runtime (spec §74). */
  readonly planner?: Planner;
  readonly verifier?: ProgressVerifier;
  /** The shared tool registry, so `agent.tools.register(customTool)` works. */
  readonly tools: DefaultToolRegistry;

  constructor(
    private readonly os: AgentOS,
    spec: AgentSpec,
  ) {
    if (!spec.id) throw new ValidationError('An agent needs an id');
    this.id = spec.id;
    this.version = spec.version ?? '1.0.0';
    this.tools = os.tools;
    this.scope = {
      ...(spec.organizationId ? { organizationId: spec.organizationId } : {}),
      ...(spec.projectId ? { projectId: spec.projectId } : {}),
    };
    if (isDefinitionSpec(spec)) {
      // Already validated by `parseAgentDefinition`; re-validating would only
      // risk rejecting a definition the caller legitimately owns.
      this.definition = spec;
    } else {
      this.definition = parseAgentDefinition(buildRawDefinition(spec));
      if (spec.planner) this.planner = spec.planner;
      if (spec.verifier) this.verifier = spec.verifier;
    }
    os.registerAgent(this);
  }

  /** Register the definition with the runtime's registry for this organization. */
  async register(): Promise<AgentDefinition> {
    return this.os.registerDefinition(this);
  }

  /** Create a run without executing it — the durable, inspectable unit of work. */
  async createRun(request: AgentRunRequest): Promise<AgentRun> {
    await this.register();
    return this.os.runtime.createRun(this.runInput(request));
  }

  /**
   * Create a run, execute it, and return its measured result.
   *
   * Execution is durable: if the worker dies mid-run the run is resumed from its
   * last checkpoint, not started over.
   */
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const run = await this.createRun(request);
    await this.os.runtime.start(run.id);
    return this.os.runtime.result(run.id);
  }

  async start(runId: string): Promise<void> {
    return this.os.runtime.start(runId);
  }

  async pause(runId: string): Promise<void> {
    return this.os.runtime.pause(runId);
  }

  async resume(runId: string): Promise<void> {
    return this.os.runtime.resume(runId);
  }

  async cancel(runId: string): Promise<void> {
    return this.os.runtime.cancel(runId);
  }

  async retry(runId: string): Promise<void> {
    return this.os.runtime.retry(runId);
  }

  async getRun(runId: string): Promise<AgentRun> {
    return this.os.runtime.getRun(runId);
  }

  async getState(runId: string): Promise<AgentState> {
    return this.os.runtime.getState(runId);
  }

  async getTrace(runId: string): Promise<Trace> {
    return this.os.runtime.getTrace(runId);
  }

  async result(runId: string): Promise<AgentRunResult> {
    return this.os.runtime.result(runId);
  }

  async checkpoint(runId: string): Promise<CheckpointRef> {
    return this.os.runtime.checkpoint(runId);
  }

  /** Fork this agent's run at a checkpoint into a brand-new run (spec §56). */
  async fork(
    runId: string,
    options: { checkpointId?: string; goal?: string } = {},
  ): Promise<AgentRun> {
    return this.os.runtime.fork(runId, options);
  }

  /** The configuration a run of this agent will use, before it is created (spec §78). */
  runInput(request: AgentRunRequest): AgentRunInput {
    const organizationId = request.organizationId ?? this.scope.organizationId;
    const projectId = request.projectId ?? this.scope.projectId;
    if (!organizationId || !projectId) {
      throw new ConfigurationError(
        'A run needs an organizationId and a projectId; set them on the agent or on AgentOS',
        { agentId: this.id },
      );
    }
    const limits = { ...this.definition.limits, ...(request.limits ?? {}) };
    // The definition carries the effective grant, and a run may only narrow it.
    // Spreading here would let a caller replace a whole permission family and
    // thereby widen what the agent definition allowed (spec §21, §47).
    const permissions = mergePermissions([this.definition.permissions, request.permissions]);
    return {
      goal: request.goal,
      agentId: this.id,
      organizationId,
      projectId,
      config: {
        agentId: this.id,
        agentVersion: this.version,
        model: this.definition.model.model,
        provider: this.definition.model.provider,
        ...(this.definition.providers?.fallback
          ? {
              fallbackProviders: Array.isArray(this.definition.providers.fallback)
                ? this.definition.providers.fallback
                : [this.definition.providers.fallback],
            }
          : {}),
        tools: this.definition.tools,
        limits,
        permissions,
        memoryEnabled: this.definition.memory.enabled,
        planningEnabled: this.definition.planning.enabled,
        verificationEnabled: this.definition.verification.enabled,
        recoveryEnabled: this.definition.recovery.enabled,
      },
      limits,
      permissions,
      metadata: { ...(request.metadata ?? {}), agentVersion: this.version },
      labels: request.labels ?? {},
      ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
    };
  }
}

function buildRawDefinition(options: AgentOptions): Record<string, unknown> {
  const fallback = options.fallback?.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
  }));
  return {
    id: options.id,
    version: options.version ?? '1.0.0',
    ...(options.name ? { name: options.name } : {}),
    ...(options.description ? { description: options.description } : {}),
    model: {
      provider: options.model.provider,
      model: options.model.model,
      ...(options.model.temperature === undefined
        ? {}
        : { temperature: options.model.temperature }),
      ...(options.model.maxTokens === undefined ? {} : { max_tokens: options.model.maxTokens }),
      ...(options.model.baseUrl === undefined ? {} : { base_url: options.model.baseUrl }),
    },
    ...(fallback && fallback.length > 0
      ? {
          providers: {
            primary: { provider: options.model.provider, model: options.model.model },
            fallback,
          },
        }
      : {}),
    system_prompt:
      options.systemPrompt ??
      `You are ${options.id}. Achieve the goal using the tools you have been given, and verify your work before finishing.`,
    tools: expandToolFamilies(options.tools ?? DEFAULT_AGENT_TOOLS),
    memory: options.memory ?? false,
    planning: options.planning ?? true,
    verification: options.verification ?? true,
    recovery: options.recovery ?? true,
    limits: toRawLimits(options.limits ?? {}),
    permissions: toRawPermissions(options.permissions ?? DEFAULT_AGENT_PERMISSIONS),
  };
}

function toRawLimits(limits: RunLimits): Record<string, unknown> {
  return {
    ...(limits.maxSteps === undefined ? {} : { max_steps: limits.maxSteps }),
    ...(limits.maxToolCalls === undefined ? {} : { max_tool_calls: limits.maxToolCalls }),
    ...(limits.maxTokens === undefined ? {} : { max_tokens: limits.maxTokens }),
    ...(limits.maxCostUsd === undefined ? {} : { max_cost_usd: limits.maxCostUsd }),
    ...(limits.maxDurationSeconds === undefined
      ? {}
      : { max_duration_seconds: limits.maxDurationSeconds }),
    ...(limits.maxNetworkRequests === undefined
      ? {}
      : { max_network_requests: limits.maxNetworkRequests }),
    ...(limits.maxStorageBytes === undefined ? {} : { max_storage_bytes: limits.maxStorageBytes }),
    ...(limits.maxRecoveryAttempts === undefined
      ? {}
      : { max_recovery_attempts: limits.maxRecoveryAttempts }),
    ...(limits.stepTimeoutMs === undefined ? {} : { step_timeout_ms: limits.stepTimeoutMs }),
    ...(limits.toolTimeoutMs === undefined ? {} : { tool_timeout_ms: limits.toolTimeoutMs }),
  };
}

function toRawPermissions(permissions: ToolPermissions): Record<string, unknown> {
  return {
    ...(permissions.filesystem
      ? {
          filesystem: {
            ...(permissions.filesystem.read === undefined
              ? {}
              : { read: permissions.filesystem.read }),
            ...(permissions.filesystem.write === undefined
              ? {}
              : { write: permissions.filesystem.write }),
            ...(permissions.filesystem.delete === undefined
              ? {}
              : { delete: permissions.filesystem.delete }),
            ...(permissions.filesystem.roots === undefined
              ? {}
              : { roots: permissions.filesystem.roots }),
          },
        }
      : {}),
    ...(permissions.terminal
      ? {
          terminal: {
            ...(permissions.terminal.execute === undefined
              ? {}
              : { execute: permissions.terminal.execute }),
            ...(permissions.terminal.allowCommands === undefined
              ? {}
              : { allow_commands: permissions.terminal.allowCommands }),
            ...(permissions.terminal.denyCommands === undefined
              ? {}
              : { deny_commands: permissions.terminal.denyCommands }),
            ...(permissions.terminal.allowUnisolated === undefined
              ? {}
              : { allow_unisolated: permissions.terminal.allowUnisolated }),
          },
        }
      : {}),
    ...(permissions.network
      ? {
          network: {
            ...(permissions.network.enabled === undefined
              ? {}
              : { enabled: permissions.network.enabled }),
            ...(permissions.network.allowedHosts === undefined
              ? {}
              : { allowed_hosts: permissions.network.allowedHosts }),
            ...(permissions.network.methods === undefined
              ? {}
              : { methods: permissions.network.methods }),
          },
        }
      : {}),
    ...(permissions.git
      ? {
          git: {
            ...(permissions.git.read === undefined ? {} : { read: permissions.git.read }),
            ...(permissions.git.commit === undefined ? {} : { commit: permissions.git.commit }),
            ...(permissions.git.push === undefined ? {} : { push: permissions.git.push }),
          },
        }
      : {}),
    ...(permissions.database
      ? {
          database: {
            ...(permissions.database.read === undefined ? {} : { read: permissions.database.read }),
            ...(permissions.database.write === undefined
              ? {}
              : { write: permissions.database.write }),
            ...(permissions.database.connections === undefined
              ? {}
              : { connections: permissions.database.connections }),
          },
        }
      : {}),
  };
}
