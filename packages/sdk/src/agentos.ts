import {
  ConfigurationError,
  type AgentTool,
  type Clock,
  type JsonObject,
  type Logger,
  type ModelProvider,
  type Planner,
  type RunLimits,
  type SecretProvider,
  type SecretResolver,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import { createStore, type AgentOSStore } from '@kazi-ai/agentos-persistence';
import {
  DefaultToolRegistry,
  createBuiltinTools,
  type BuiltinToolsOptions,
  type EnvironmentProviderConfig,
  type ToolRegistry,
} from '@kazi-ai/agentos-tools';
import {
  ApprovalManager,
  DefaultPolicyEngine,
  RiskClassifier,
  type RiskRule,
} from '@kazi-ai/agentos-policies';
import { MemoryManager } from '@kazi-ai/agentos-memory';
import { ContextManager } from '@kazi-ai/agentos-context';
import { ModelProviderRegistry } from '@kazi-ai/agentos-providers';
import type { SpanRecorder } from '@kazi-ai/agentos-tracing';
import {
  AgentOSRuntime,
  type AgentOSRuntimeOptions,
  type ProgressVerifier,
} from '@kazi-ai/agentos-runtime';
import type { AgentDefinition } from '@kazi-ai/agentos-agent';
import { McpManager, type McpServerConfigInput, type McpServerStatus } from '@kazi-ai/agentos-mcp';
import { Agent, type AgentSpec } from './agent.js';
import { providersFromEnv } from './providers-from-env.js';

export interface AgentOSOptions {
  /** Where the durable store lives. Defaults to `./.kazi`. */
  dataDir?: string;
  /** `memory` is the zero-dependency durable JSONL store; `postgres` uses Prisma. */
  driver?: 'memory' | 'postgres';
  databaseUrl?: string;
  /** Register these providers instead of (or in addition to) the ones in the environment. */
  providers?: ModelProvider[];
  /** Discover providers from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...). */
  providersFromEnv?: boolean;
  env?: Record<string, string | undefined>;
  /** Extra tools registered alongside the built-ins. */
  tools?: AgentTool[];
  builtinTools?: BuiltinToolsOptions | false;
  policies?: DefaultPolicyEngine;
  /** Risk classification rules used when no policy engine is supplied. */
  policyRules?: RiskRule[];
  approvals?: ApprovalManager;
  memory?: MemoryManager;
  context?: ContextManager;
  environment?: EnvironmentProviderConfig;
  logger?: Logger;
  clock?: Clock;
  secrets?: SecretProvider | SecretResolver;
  recorder?: SpanRecorder;
  defaultLimits?: RunLimits;
  permissions?: ToolPermissions;
  organizationId?: string;
  projectId?: string;
  /**
   * MCP servers to connect at startup (spec §19). Their discovered tools are
   * registered as `mcp.<server>.<tool>` and are governed by the same policy
   * engine as local tools.
   */
  mcp?: { servers?: McpServerConfigInput[]; strict?: boolean };
  /** Escape hatch: options passed straight to the runtime (spec §74). */
  runtime?: Partial<AgentOSRuntimeOptions>;
}

/** Result of connecting the configured MCP servers. */
export interface McpStartupReport {
  statuses: McpServerStatus[];
  registeredTools: string[];
}

/**
 * The AgentOS product surface (spec §72): one durable store, one provider
 * registry, one tool registry and one runtime, with agents declared on top.
 *
 * Replacing the planner, verifier, memory, context or recovery engine is a
 * constructor argument, not a fork of the runtime.
 */
export class AgentOS {
  readonly runtime: AgentOSRuntime;
  readonly store: AgentOSStore;
  readonly providers: ModelProviderRegistry;
  readonly tools: DefaultToolRegistry;
  readonly organizationId?: string;
  readonly projectId?: string;

  private closed = false;

  private constructor(
    private readonly options: AgentOSOptions,
    store: AgentOSStore,
    providers: ModelProviderRegistry,
    tools: DefaultToolRegistry,
    runtime: AgentOSRuntime,
    private readonly planners: Map<string, Planner>,
    private readonly verifiers: Map<string, ProgressVerifier>,
  ) {
    this.store = store;
    this.providers = providers;
    this.tools = tools;
    this.runtime = runtime;
    if (options.organizationId) this.organizationId = options.organizationId;
    if (options.projectId) this.projectId = options.projectId;
  }

  /** Build an AgentOS instance: store, providers, tools, policies and runtime. */
  static async create(options: AgentOSOptions = {}): Promise<AgentOS> {
    const dataDir = options.dataDir ?? `${process.cwd()}/.kazi`;
    const store =
      options.driver === 'postgres'
        ? await createStore({
            driver: 'postgres',
            ...(options.databaseUrl ? { databaseUrl: options.databaseUrl } : {}),
          })
        : await createStore({ driver: 'memory', dataDir });

    const providers = new ModelProviderRegistry();
    for (const provider of options.providers ?? []) providers.register(provider);
    if (options.providersFromEnv !== false) {
      for (const provider of providersFromEnv({ ...(options.env ? { env: options.env } : {}) })) {
        if (!providers.get(provider.id)) providers.register(provider);
      }
    }

    const toolsList =
      options.builtinTools === false ? [] : await createBuiltinTools(options.builtinTools ?? {});
    const tools = new DefaultToolRegistry(toolsList);
    for (const tool of options.tools ?? []) tools.override(tool);

    const policies =
      options.policies ??
      new DefaultPolicyEngine({
        classifier: new RiskClassifier(options.policyRules, undefined, {
          toolRisk: (toolId) => tools.get(toolId)?.risk,
        }),
      });

    // Per-agent components are resolved through these maps, so calling
    // `os.agent({ planner })` replaces planning for that agent alone.
    const planners = new Map<string, Planner>();
    const verifiers = new Map<string, ProgressVerifier>();

    const runtimeOptions: AgentOSRuntimeOptions = {
      ...(options.runtime ?? {}),
      store,
      providers,
      tools: tools as ToolRegistry,
      policies,
      environment: options.runtime?.environment ??
        options.environment ?? {
          kind: 'local',
          workspaceRoot: `${dataDir}/workspaces`,
          snapshotStoreRoot: `${dataDir}/snapshots`,
        },
      // Both factories may decline; the runtime then falls back to the LLM
      // planner and the verification commands in the agent definition.
      planner: (input) => planners.get(input.run.agentId),
      verifier: (input) => verifiers.get(input.run.agentId),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.recorder ? { recorder: options.recorder } : {}),
      ...(options.defaultLimits ? { defaultLimits: options.defaultLimits } : {}),
    };
    if (options.runtime?.planner) runtimeOptions.planner = options.runtime.planner;
    if (options.runtime?.verifier) runtimeOptions.verifier = options.runtime.verifier;

    const runtime = new AgentOSRuntime(runtimeOptions);
    const os = new AgentOS(options, store, providers, tools, runtime, planners, verifiers);

    const configuredServers = options.mcp?.servers ?? [];
    if (configuredServers.length > 0) {
      const manager = new McpManager({
        strict: options.mcp?.strict ?? true,
        ...(options.logger ? { logger: options.logger } : {}),
        resolveSecret: (reference) => resolveMcpSecret(reference),
      });
      for (const server of configuredServers) manager.addServer(server);
      const statuses = await manager.start();
      const registeredTools = manager.registerInto(tools);
      os.attachMcp(manager, { statuses, registeredTools });
    }
    return os;
  }

  /** Declare an agent on this AgentOS (spec §72). */
  agent(spec: AgentSpec): Agent {
    return new Agent(this, {
      ...spec,
      ...((spec.organizationId ?? this.organizationId)
        ? { organizationId: spec.organizationId ?? this.organizationId }
        : {}),
      ...((spec.projectId ?? this.projectId)
        ? { projectId: spec.projectId ?? this.projectId }
        : {}),
    });
  }

  /** Called by the `Agent` constructor; replacement components are per agent. */
  registerAgent(agent: Agent): void {
    if (agent.planner) this.planners.set(agent.id, agent.planner);
    if (agent.verifier) this.verifiers.set(agent.id, agent.verifier);
  }

  plannerFor(agentId: string): Planner | undefined {
    return this.planners.get(agentId);
  }

  verifierFor(agentId: string): ProgressVerifier | undefined {
    return this.verifiers.get(agentId);
  }

  /** Register an agent's validated definition with the runtime's registry. */
  async registerDefinition(agent: Agent): Promise<AgentDefinition> {
    const organizationId = agent.scope.organizationId ?? this.organizationId;
    const projectId = agent.scope.projectId ?? this.projectId;
    if (!organizationId || !projectId) {
      throw new ConfigurationError(
        'Registering an agent needs an organizationId and a projectId; set them on the agent or on AgentOS',
        { agentId: agent.id },
      );
    }
    return this.runtime.agents.register({
      organizationId,
      projectId,
      definition: agent.definition,
      source: JSON.stringify(agent.definition),
    });
  }

  private mcp?: { manager: McpManager; report: McpStartupReport };

  /** Attach the MCP manager that was started during `create()`. */
  attachMcp(manager: McpManager, report: McpStartupReport): void {
    this.mcp = { manager, report };
  }

  /** MCP server health, or an empty report when no servers are configured. */
  mcpReport(): McpStartupReport {
    return this.mcp?.report ?? { statuses: [], registeredTools: [] };
  }

  /** The deployment's own view of what it can do (used by `kazi-agent doctor`). */
  info(): JsonObject {
    return {
      dataDir: this.options.dataDir ?? `${process.cwd()}/.kazi`,
      driver: this.options.driver ?? 'memory',
      providers: this.providers.describe() as unknown as JsonObject,
      tools: this.tools.describe() as unknown as JsonObject,
      agents: this.planners.size + this.verifiers.size,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.mcp?.manager.close().catch(() => undefined);
    await this.runtime.close().catch(() => undefined);
    await this.store.close().catch(() => undefined);
  }
}

/** Convenience factory: `const os = await createAgentOS({ ... })`. */
export async function createAgentOS(options: AgentOSOptions = {}): Promise<AgentOS> {
  return AgentOS.create(options);
}

function resolveMcpSecret(reference: string): Promise<string> {
  const name = reference.startsWith('secret://')
    ? `KAZI_SECRET_${reference
        .slice('secret://'.length)
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .toUpperCase()}`
    : reference;
  const value = process.env[name];
  if (value === undefined) {
    return Promise.reject(
      new ConfigurationError(`Secret ${reference} is not available in the environment`, { name }),
    );
  }
  return Promise.resolve(value);
}
