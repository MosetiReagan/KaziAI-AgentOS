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
import { Agent, type AgentOptions } from './agent.js';
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
  /** Escape hatch: options passed straight to the runtime (spec §74). */
  runtime?: Partial<AgentOSRuntimeOptions>;
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
    return new AgentOS(options, store, providers, tools, runtime, planners, verifiers);
  }

  /** Declare an agent on this AgentOS (spec §72). */
  agent(options: AgentOptions): Agent {
    return new Agent(this, {
      ...options,
      ...((options.organizationId ?? this.organizationId)
        ? { organizationId: options.organizationId ?? this.organizationId }
        : {}),
      ...((options.projectId ?? this.projectId)
        ? { projectId: options.projectId ?? this.projectId }
        : {}),
    });
  }

  /** Called by the `Agent` constructor; replacement components are per agent. */
  registerAgent(agent: Agent): void {
    if (agent.options.planner) this.planners.set(agent.id, agent.options.planner);
    if (agent.options.verifier) this.verifiers.set(agent.id, agent.options.verifier);
  }

  plannerFor(agentId: string): Planner | undefined {
    return this.planners.get(agentId);
  }

  verifierFor(agentId: string): ProgressVerifier | undefined {
    return this.verifiers.get(agentId);
  }

  /** Register an agent's validated definition with the runtime's registry. */
  async registerDefinition(agent: Agent): Promise<AgentDefinition> {
    const organizationId = agent.options.organizationId ?? this.organizationId;
    const projectId = agent.options.projectId ?? this.projectId;
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
    await this.runtime.close().catch(() => undefined);
    await this.store.close().catch(() => undefined);
  }
}

/** Convenience factory: `const os = await createAgentOS({ ... })`. */
export async function createAgentOS(options: AgentOSOptions = {}): Promise<AgentOS> {
  return AgentOS.create(options);
}
