import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigurationError,
  NotFoundError,
  NullLogger,
  SystemClock,
  ValidationError,
  DefaultBudgetManager,
  InMemoryEventBus,
  InMemoryLockManager,
  SecretRedactor,
  emptyUsage,
  hashObject,
  isTerminalState,
  newRunId,
  newTraceId,
  type AgentAction,
  type AgentRun,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
  type AgentState,
  type Approval,
  type ArtifactRef,
  type ArtifactSink,
  type BudgetManager,
  type CheckpointRef,
  type Clock,
  type EventBus,
  type ExecutionEnvironment,
  type JsonObject,
  type JsonValue,
  type LockManager,
  type Logger,
  type ModelProvider,
  type Plan,
  type Planner,
  type RunLimits,
  type SecretResolver,
  type SecretProvider,
  type ToolContext,
  type ToolPermissions,
  type Trace,
} from '@kazi-ai/agentos-core';
import { createStore, type AgentOSStore } from '@kazi-ai/agentos-persistence';
import {
  DefaultToolRegistry,
  WorkspaceManager,
  captureWorkspace,
  createBuiltinTools,
  createEnvironmentProvider,
  restoreWorkspace,
  type EnvironmentProviderConfig,
  type ToolRegistry,
} from '@kazi-ai/agentos-tools';
import {
  ApprovalManager,
  DEFAULT_RULES,
  DefaultPolicyEngine,
  RiskClassifier,
} from '@kazi-ai/agentos-policies';
import { ContextManager } from '@kazi-ai/agentos-context';
import { MemoryManager } from '@kazi-ai/agentos-memory';
import { CheckpointManager, serializeState, type CheckpointPolicy } from '@kazi-ai/agentos-checkpoints';
import { DefaultRecoveryEngine, RetryEngine } from '@kazi-ai/agentos-recovery';
import { Executor } from '@kazi-ai/agentos-executor';
import { DeterministicPlanner, LlmPlanner } from '@kazi-ai/agentos-planner';
import { ModelGateway, ModelProviderRegistry } from '@kazi-ai/agentos-providers';
import { InMemorySpanRecorder, SpanFactory, buildTrace, type SpanRecorder } from '@kazi-ai/agentos-tracing';
import { AgentRegistry, type AgentDefinition, type PromptResolver } from '@kazi-ai/agentos-agent';
import { AgentLoop, type LoopOutcome } from './loop.js';
import { ModelStep } from './model-step.js';
import { GatewayProvider } from './adapter.js';
import { EventWriter } from './events.js';
import { Backpressure, type BackpressureLimits } from './backpressure.js';
import { InProcessRunControl } from './control.js';
import { CommandVerifier, CompositeVerifier, FilesystemVerifier, type ProgressVerifier, type VerificationResult } from './verification.js';
import { replayRun, type ReplayOptions, type ReplayReport } from './replay.js';
import { advanceRunTo } from './transition.js';
import { emptyState, requireRun, requireString, toAgentRunResult } from './support.js';

export interface AgentOSRuntimeOptions {
  store?: AgentOSStore;
  dataDir?: string;
  providers: ModelProviderRegistry;
  tools?: ToolRegistry | Awaited<ReturnType<typeof createBuiltinTools>>;
  policies?: DefaultPolicyEngine;
  approvals?: ApprovalManager;
  budgets?: BudgetManager;
  bus?: EventBus;
  locks?: LockManager;
  logger?: Logger;
  clock?: Clock;
  memory?: MemoryManager;
  context?: ContextManager;
  checkpoints?: CheckpointManager;
  /** Override the checkpoint scheduling policy (spec §30, §77). */
  checkpointPolicy?: Partial<CheckpointPolicy>;
  recovery?: DefaultRecoveryEngine;
  agents?: AgentRegistry;
  /**
   * Replace the planner entirely (spec §74): a custom planner, or a factory
   * that decides per run. Overrides the built-in LLM planner.
   */
  planner?: Planner | ((input: { run: AgentRun }) => Planner | undefined);
  prompts?: PromptResolver;
  /** Resolve the system prompt for a run (defaults to the agent definition or inline metadata). */
  resolveSystemPrompt?(input: { run: AgentRun; definition?: AgentDefinition }): Promise<string>;
  verifier?: ProgressVerifier | ((input: { run: AgentRun; definition?: AgentDefinition }) => ProgressVerifier | undefined);
  environment?: EnvironmentProviderConfig;
  secrets?: SecretProvider | SecretResolver;
  backpressure?: Partial<BackpressureLimits>;
  defaultLimits?: RunLimits;
  spans?: SpanFactory;
  recorder?: SpanRecorder;
  maxToolCallsPerStep?: number;
  now?: () => number;
}

export interface ForkRunOptions {
  checkpointId?: string;
  goal?: string;
  labels?: Record<string, string>;
}

/**
 * KaziAI AgentOS runtime: durable, observable, controllable execution of
 * autonomous agents. The runtime owns the run lifecycle; workers own nothing.
 */
export class AgentOSRuntime implements AgentRuntime {
  readonly store: AgentOSStore;
  readonly providers: ModelProviderRegistry;
  readonly tools: ToolRegistry;
  readonly policies: DefaultPolicyEngine;
  readonly approvals: ApprovalManager;
  readonly agents: AgentRegistry;
  readonly checkpoints: CheckpointManager;
  readonly recovery: DefaultRecoveryEngine;
  readonly workspace: WorkspaceManager;
  readonly backpressure: Backpressure;
  readonly logger: Logger;
  readonly spans: SpanFactory;
  readonly recorder: SpanRecorder;
  /**
   * The runtime's event bus. Every event is persisted *and* published here, so
   * a dashboard, a webhook dispatcher or another service in the same process
   * can follow a run without polling (spec §48).
   */
  readonly bus: EventBus;

  private readonly events: EventWriter;
  private readonly loop: AgentLoop;
  private readonly executor: Executor;
  private readonly controls = new Map<string, InProcessRunControl>();
  private readonly environments = new Map<string, ExecutionEnvironment>();
  private readonly contextManager: ContextManager;
  private readonly memory?: MemoryManager;
  private readonly secrets: SecretResolver;
  /**
   * Every secret this process has resolved. Anything it writes down is scrubbed
   * against this first, so a credential the runtime was handed can never end up
   * in an event, a journal entry or an observation (spec §66).
   */
  private readonly redactor: SecretRedactor = new SecretRedactor();
  private readonly environmentProvider?: EnvironmentProviderConfig;
  private readonly artifacts = new Map<string, ArtifactRef[]>();
  private readonly spansBuffer: SpanRecorder;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly options: AgentOSRuntimeOptions) {
    this.logger = options.logger ?? new NullLogger();
    this.now = options.now ?? (() => Date.now());
    this.store = options.store ?? (undefined as unknown as AgentOSStore);
    this.providers = options.providers;    // The documented defaults are always in force unless an operator replaces
    // the engine outright: force-pushing, deleting production data and pushing
    // to a remote are not merely discouraged, they are policy (spec §22).
    this.policies =
      options.policies ??
      new DefaultPolicyEngine({ classifier: this.defaultClassifier(), rules: DEFAULT_RULES });
    this.recorder = options.recorder ?? new InMemorySpanRecorder();
    this.spansBuffer = this.recorder;
    this.spans = options.spans ?? new SpanFactory(this.spansBuffer, this.now);
    this.contextManager = options.context ?? new ContextManager({ logger: this.logger });
    if (options.memory) this.memory = options.memory;
    this.approvals = options.approvals ?? new ApprovalManager({ store: this.store.approvals });
    this.agents =
      options.agents ??
      new AgentRegistry({
        // Definitions are durable: another worker, or this one after a restart,
        // must be able to resolve the agent a queued run was created against.
        ...(options.store ? { store: options.store.agentDefinitions } : {}),
        logger: this.logger,
      });
    this.backpressure = new Backpressure(options.backpressure ?? {}, this.store, this.logger);
    this.environmentProvider = options.environment;
    const resolvedSecrets = normalizeSecrets(options.secrets);
    // Resolving a secret is also the moment we learn its value: record it so it
    // can be scrubbed from anything persisted afterwards.
    this.secrets = {
      resolve: async (reference: string) => {
        const value = await resolvedSecrets.resolve(reference);
        this.redactor.remember(value);
        return value;
      },
      has: (reference: string) => resolvedSecrets.has(reference),
    };

    const registry = options.tools ?? new DefaultToolRegistry([]);
    this.tools = registry instanceof DefaultToolRegistry ? registry : (registry as ToolRegistry);

    this.workspace = new WorkspaceManager({
      root: options.environment?.workspaceRoot ?? join(process.cwd(), '.kazi', 'workspaces'),
      logger: this.logger,
    });

    this.checkpoints =
      options.checkpoints ??
      new CheckpointManager({
        store: this.store.checkpoints,
        logger: this.logger,
        ...(options.checkpointPolicy ? { policy: options.checkpointPolicy } : {}),
        captureEnvironment: async ({ run }) => {
          const dir = join(this.storeRoot(), 'snapshots', run.id);
          return captureWorkspace({ workspaceDir: run.workspaceDir, storeDir: dir, kind: 'workspace' });
        },
        restoreEnvironment: async (snapshot) => {
          restoreWorkspace(snapshot, { removeExtra: false });
        },
      });

    this.recovery =
      options.recovery ??
      new DefaultRecoveryEngine({
        checkpoints: {
          get: (id) => this.store.checkpoints.get(id),
          latest: (runId) => this.store.checkpoints.latest(runId),
        },
        failover: async ({ runId }) => this.nextProviderFor(runId),
        switchProvider: async ({ to }) => to,
        // The agent definition's `recovery:` block is a promise to the author,
        // so it is resolved per run rather than ignored in favour of the
        // deployment defaults (spec §6, §35).
        policiesFor: async (runId) => {
          const run = await this.store.runs.get(runId);
          if (!run) return undefined;
          const definition = await this.definitionFor(run);
          const policies = definition?.recovery.policies;
          return policies && Object.keys(policies).length > 0 ? policies : undefined;
        },
        requestHuman: async ({ runId, summary, reason }) => {
          const run = await this.store.runs.get(runId);
          if (!run) return undefined;
          const approval = await this.approvals.request({
            runId,
            organizationId: run.organizationId,
            projectId: run.projectId,
            action: {
              id: `act_recovery_${runId}` as AgentAction['id'],
              runId,
              toolId: 'recovery',
              arguments: { summary, reason },
              idempotencyKey: `idem_recovery_${runId}`,
              idempotency: 'idempotent',
              status: 'pending',
              createdAt: this.now(),
              attempt: 0,
            },
            risk: 'HIGH',
            reason,
            summary,
          });
          return { approvalId: approval.id };
        },
        retry: new RetryEngine({ classifier: undefined }),
      });

    this.executor = new Executor({
      redactor: this.redactor,
      registry: this.tools,
      journal: this.store.actions,
      policy: this.policies,
      approvals: this.approvals,
      permissions: (request) => this.permissionCache.get(request.runId) ?? {},
      createToolContext: (request, tool, signal) => {
        void tool;
        return {
          runId: request.runId as ToolContext['runId'],
          organizationId: request.organizationId,
          projectId: request.projectId,
          workspaceDir: request.workspaceDir,
          permissions: this.permissionCache.get(request.runId) ?? {},
          logger: this.logger.child({ runId: request.runId }),
          clock: options.clock ?? new SystemClock(),
          signal,
          secrets: this.secrets,
          environment: {
            execute: (command, execOptions) => this.environmentForId(request.runId).then((env) => env.execute(command, execOptions)),
            workspaceDir: () => request.workspaceDir,
          },
          artifacts: this.artifactSinkById(request.runId),
        };
      },
      logger: this.logger,
      defaultToolTimeoutMs: options.defaultLimits?.toolTimeoutMs,
      hooks: {
        onPolicyDecision: async ({ action, decision }) => {
          await this.store.policyDecisions.save({
            id: `pol_${action.id}`,
            runId: action.runId,
            actionId: action.id,
            toolId: action.toolId,
            outcome: decision.outcome,
            ruleId: decision.ruleId,
            reason: decision.reason,
            risk: decision.risk,
            at: this.now(),
          });
        },
      },
    });
    this.bus = options.bus ?? new InMemoryEventBus();
    this.events = new EventWriter({
      store: this.store,
      bus: this.bus,
      logger: this.logger,
    });

    const modelStep = new ModelStep({
      gateway: {
        generate: async (request) => {
          const run = await this.latestRunFromRequest(request.metadata);
          return this.gatewayFor(run).generate(request);
        },
      },
      registry: this.tools,
      context: this.contextManager,
      ...(this.memory ? { memory: this.memory } : {}),
      now: this.now,
      ...(options.maxToolCallsPerStep === undefined ? {} : { maxToolCallsPerStep: options.maxToolCallsPerStep }),
    });

    this.loop = new AgentLoop({
      store: this.store,
      events: this.events,
      budgets: options.budgets ?? new DefaultBudgetManager(),
      executor: this.executor,
      checkpoints: this.checkpoints,
      recovery: this.recovery,
      modelStep,
      registry: this.tools,
      // Tool-declared risk is a floor: an MCP server or custom tool that marks
      // itself CRITICAL always gets an approval gate (spec §24).
      risk: this.defaultClassifier(),
      redactor: this.redactor,
      spans: this.spans,
      logger: this.logger,
      now: this.now,
      plannerFor: (run) => this.plannerFor(run),
      revisePlan: async ({ run, state, classification }) => this.revisePlan(run, state, classification),
      ...(options.verifier === undefined ? {} : {}),
    });
  }

  /**
   * The classifier every policy decision goes through. It consults the tool
   * registry so a tool that declares its own risk can never be classified
   * below it, however the built-in rules are configured.
   */
  private defaultClassifier(): RiskClassifier {
    return new RiskClassifier(undefined, undefined, { toolRisk: (toolId) => this.tools?.get(toolId)?.risk });
  }

  static async create(options: Omit<AgentOSRuntimeOptions, 'store'> & { store?: AgentOSStore }): Promise<AgentOSRuntime> {
    const store = options.store ?? (await createStore({ driver: 'memory', ...(options.dataDir ? { dataDir: options.dataDir } : {}) }));
    const tools = options.tools ?? new DefaultToolRegistry(await createBuiltinTools());
    return new AgentOSRuntime({ ...options, store, tools: tools as ToolRegistry });
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async close(): Promise<void> {
    await this.shutdown();
    await this.store.close();
  }

  // ---------------------------------------------------------------- lifecycle

  async createRun(input: AgentRunInput): Promise<AgentRun> {
    requireString(input.goal, 'goal');
    requireString(input.agentId, 'agentId');
    requireString(input.organizationId, 'organizationId');
    requireString(input.projectId, 'projectId');
    await this.backpressure.assertAccepting({ organizationId: input.organizationId });

    const runId = newRunId(this.now());
    const config = input.config ?? this.defaultConfig(input);
    const limits = { ...(this.options.defaultLimits ?? {}), ...(config.limits ?? {}), ...(input.limits ?? {}) };
    const usage = emptyUsage();
    const workspace = this.workspace.create({ runId, organizationId: input.organizationId });
    // The workspace is seeded before the run row exists: a caller that pointed a
    // run at a directory it cannot read gets an error, not a run that is
    // already executing against an empty workspace (spec §70, §94).
    let seededFiles = 0;
    if (input.workspace?.files) {
      this.workspace.seed(runId, input.workspace.files);
      seededFiles += Object.keys(input.workspace.files).length;
    }
    if (input.workspace?.copyFrom) {
      seededFiles += this.workspace.seedFrom(runId, input.workspace.copyFrom, {
        ...(input.workspace.ignore ? { ignore: input.workspace.ignore } : {}),
      });
    }
    const run: AgentRun = {
      id: runId,
      goal: input.goal,
      agentId: input.agentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      status: 'CREATED',
      stateVersion: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
      config: { ...config, limits },
      limits,
      usage,
      rootRunId: input.parentRunId ?? runId,
      traceId: newTraceId(this.now()),
      workspaceDir: workspace.path,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
      metadata: { ...(input.metadata ?? {}) },
    };

    await this.store.runs.create(run);
    this.permissionCache.set(runId, run.config.permissions);
    await this.store.counters.saveUsage(runId, usage);
    await this.store.states.save(
      serializeState({ run, state: emptyState(run), committedActions: [] }),
      0,
    );
    await this.events.emit({
      type: 'run.created',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { agentId: run.agentId, goal: run.goal, workspace: run.workspaceDir },
    });
    await this.events.emit({
      type: 'workspace.created',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { path: workspace.path, ...(seededFiles > 0 ? { seededFiles } : {}) },
    });
    return run;
  }

  /**
   * Execute a run to its next resting point. The caller (API, worker or CLI)
   * holds nothing durable: everything needed is reloaded from the store.
   */
  async start(runId: string): Promise<void> {
    const lock = await this.locks().acquire(`run:${runId}`, { wait: false });
    this.backpressure.reserve();
    try {
      const run = requireRun(await this.store.runs.get(runId), runId);
      if (isTerminalState(run.status)) {
        this.logger.debug('run already finished', { runId, status: run.status });
        return;
      }
      if (run.status === 'PAUSED') {
        throw new ValidationError(`Run ${runId} is paused; call resume instead`, { runId });
      }
      const control = new InProcessRunControl(runId);
      this.controls.set(runId, control);
      this.permissionCache.set(runId, run.config.permissions);
      const started = this.now();
      run.startedAt = run.startedAt ?? started;
      run.status = 'INITIALIZING';
      run.stateVersion += 1;
      await this.store.runs.update(run, run.stateVersion - 1);
      await this.events.emit({
        type: 'run.started',
        runId,
        organizationId: run.organizationId,
        projectId: run.projectId,
        traceId: run.traceId,
        data: { agentId: run.agentId, model: run.config.model, provider: run.config.provider },
      });

      const definition = await this.definitionFor(run);
      const systemPrompt = await this.systemPromptFor(run, definition);
      const state = await this.stateFor(run);
      const environment = await this.environmentFor(run);
      const verifier = await this.verifierFor(run, definition);
      const outcome = await this.loop.run({
        run,
        state,
        systemPrompt,
        control,
        verificationCommands: definition?.verification.commands ?? [],
        environment,
        ...(verifier ? { verifier } : {}),
      });
      await this.afterOutcome(run, outcome);
    } finally {
      this.controls.delete(runId);
      this.permissionCache.delete(runId);
      this.backpressure.release();
      await this.locks().release(lock);
    }
  }

  async pause(runId: string): Promise<void> {
    const control = this.controls.get(runId);
    if (control) {
      control.pause();
      return;
    }
    const run = requireRun(await this.store.runs.get(runId), runId);
    if (isTerminalState(run.status)) throw new ValidationError(`Run ${runId} already finished`, { runId });
    if (run.status === 'PAUSED') return;
    const state = await this.stateFor(run);
    await this.checkpoints.create({
      run,
      state,
      committedActions: await this.store.actions.list(runId),
      trigger: 'before_pause',
      label: 'paused',
    });
    await this.advance(run, 'PAUSED', 'paused by operator');
    await this.events.emit({
      type: 'run.paused',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: {},
    });
  }

  async resume(runId: string): Promise<void> {
    const run = requireRun(await this.store.runs.get(runId), runId);
    if (isTerminalState(run.status)) throw new ValidationError(`Run ${runId} already finished`, { runId });
    if (run.status === 'PAUSED') {
      await this.advance(run, 'QUEUED', 'resumed by operator');
    }
    await this.events.emit({
      type: 'run.resumed',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { status: run.status },
    });
    await this.start(runId);
  }

  async cancel(runId: string): Promise<void> {
    const control = this.controls.get(runId);
    if (control) {
      control.cancel('cancelled by operator');
      return;
    }
    const run = requireRun(await this.store.runs.get(runId), runId);
    if (isTerminalState(run.status)) return;
    await this.approvals.cancelForRun(runId, 'run cancelled');
    await this.advance(run, 'CANCELLED', 'cancelled by operator');
    await this.events.emit({
      type: 'run.cancelled',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { reason: 'cancelled by operator' },
    });
  }

  async retry(runId: string): Promise<void> {
    const run = requireRun(await this.store.runs.get(runId), runId);
    if (!['FAILED', 'TIMED_OUT', 'PAUSED'].includes(run.status)) {
      throw new ValidationError(`Run ${runId} cannot be retried from ${run.status}`, { runId, status: run.status });
    }
    run.error = undefined;
    await this.advance(run, 'QUEUED', 'retry requested');
    await this.events.emit({
      type: 'run.retried',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { attempt: run.usage.recoveryCount + 1 },
    });
    await this.start(runId);
  }

  async getRun(runId: string): Promise<AgentRun> {
    return requireRun(await this.store.runs.get(runId), runId);
  }

  async getState(runId: string): Promise<AgentState> {
    const run = await this.getRun(runId);
    const stored = await this.store.states.load(runId);
    if (!stored) return { ...emptyState(run), usage: run.usage };
    return {
      runId,
      status: run.status,
      stateVersion: stored.stateVersion,
      ...(stored.plan ? { plan: stored.plan } : {}),
      ...(stored.currentStepId ? { currentStepId: stored.currentStepId } : {}),
      usage: run.usage,
      context: stored.context,
      observations: stored.observations,
      updatedAt: run.updatedAt,
    };
  }

  async getTrace(runId: string): Promise<Trace> {
    const run = await this.getRun(runId);
    const [events, steps, invocations, checkpoints, recoveries, approvals] = await Promise.all([
      this.store.events.list(runId),
      this.store.steps.list(runId),
      this.store.invocations.list(runId),
      this.store.checkpoints.list(runId),
      this.store.recoveries.list(runId),
      this.store.approvals.list({ runId }),
    ]);
    return buildTrace({
      run,
      events,
      steps,
      invocations,
      checkpoints: checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        runId: checkpoint.runId,
        sequence: checkpoint.sequence,
        createdAt: checkpoint.createdAt,
        stateVersion: checkpoint.stateVersion,
        ...(checkpoint.label ? { label: checkpoint.label } : {}),
      })),
      recoveries: recoveries.map((recovery) => ({
        id: recovery.id,
        attempt: recovery.attempt,
        strategy: recovery.strategy,
        success: recovery.success,
        at: recovery.at,
      })),
      approvals: approvals.map((approval: Approval) => ({
        id: approval.id,
        toolId: approval.toolId,
        status: approval.status,
        risk: approval.risk,
        requestedAt: approval.requestedAt,
        ...(approval.decidedAt === undefined ? {} : { decidedAt: approval.decidedAt }),
      })),
    });
  }

  async checkpoint(runId: string): Promise<CheckpointRef> {
    const run = await this.getRun(runId);
    const state = await this.getState(runId);
    const checkpoint = await this.checkpoints.create({
      run,
      state,
      committedActions: await this.store.actions.list(runId),
      trigger: 'manual',
    });
    await this.events.emit({
      type: 'checkpoint.created',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { checkpointId: checkpoint.id, sequence: checkpoint.sequence, trigger: 'manual' },
    });
    return {
      id: checkpoint.id,
      runId,
      sequence: checkpoint.sequence,
      createdAt: checkpoint.createdAt,
      stateVersion: checkpoint.stateVersion,
      ...(checkpoint.label ? { label: checkpoint.label } : {}),
    };
  }

  async result(runId: string): Promise<AgentRunResult> {
    const run = await this.getRun(runId);
    const state = await this.getState(runId);
    const decisions = await this.store.policyDecisions.list(runId);
    const artifacts = await this.store.artifacts.list(runId);
    const checkpoint = await this.store.checkpoints.latest(runId);
    // Verification evidence outlives the worker that produced it: prefer the
    // checkpoint snapshot, else the last durable verification event.
    const verification =
      checkpoint?.contextSnapshot.verification ??
      lastVerificationFromEvents(await this.store.events.list(runId));
    return toAgentRunResult({
      run,
      state,
      policyViolations: decisions.filter((decision) => decision.outcome === 'DENY').length,
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        runId: artifact.runId,
        name: artifact.name,
        sha256: artifact.sha256,
        size: artifact.size,
        mimeType: artifact.mimeType,
        createdAt: artifact.createdAt,
        path: artifact.path,
      })),
      ...(verification ? { verification } : {}),
    });
  }

  /**
   * Restore a run to an earlier checkpoint: durable state and workspace go back
   * to that point, and the run is queued so a worker picks it up again.
   */
  async restore(runId: string, checkpointId: string): Promise<AgentRun> {
    const run = await this.getRun(runId);
    if (isTerminalState(run.status)) {
      throw new ValidationError(`Run ${runId} already finished; fork it instead of restoring it`, {
        runId,
        status: run.status,
      });
    }
    const { checkpoint, state } = await this.checkpoints.restore(checkpointId);
    if (checkpoint.runId !== runId) {
      throw new ValidationError(`Checkpoint ${checkpointId} belongs to run ${checkpoint.runId}`, { runId, checkpointId });
    }
    await this.store.states.save(state, await this.currentStateVersion(runId));
    await this.events.emit({
      type: 'checkpoint.created',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { checkpointId, sequence: checkpoint.sequence, trigger: 'restore', restored: true },
    });
    return this.advance(run, 'QUEUED', `restored to checkpoint ${checkpointId}`);
  }

  private async currentStateVersion(runId: string): Promise<number | undefined> {
    const stored = await this.store.states.load(runId);
    return stored?.stateVersion;
  }

  async fork(runId: string, options: ForkRunOptions = {}): Promise<AgentRun> {
    const run = await this.getRun(runId);
    const checkpoint = options.checkpointId
      ? await this.checkpoints.get(options.checkpointId)
      : await this.store.checkpoints.latest(runId);
    if (!checkpoint) throw new NotFoundError('checkpoint', options.checkpointId ?? runId);
    const plan = await this.checkpoints.fork(checkpoint.id, {
      organizationId: run.organizationId,
      projectId: run.projectId,
      ...(options.goal ? { goal: options.goal } : {}),
      ...(options.labels ? { labels: options.labels } : {}),
    });
    const forked = await this.createRun(plan.input);
    await this.copyWorkspace(runId, forked.id);
    await this.events.emit({
      type: 'run.forked',
      runId,
      organizationId: run.organizationId,
      projectId: run.projectId,
      traceId: run.traceId,
      data: { childRunId: forked.id, checkpointId: checkpoint.id },
    });
    return forked;
  }

  async replay(runId: string, options: ReplayOptions = {}): Promise<ReplayReport> {
    return replayRun(runId, {
      store: this.store,
      registry: this.tools,
      createToolContext: async (input) => {
        const run = await this.store.runs.get(input.runId);
        if (!run) return undefined;
        const environment = await this.environmentFor(run);
        return {
          runId: run.id,
          organizationId: run.organizationId,
          projectId: run.projectId,
          workspaceDir: run.workspaceDir,
          permissions: run.config.permissions,
          logger: this.logger.child({ runId: run.id }),
          clock: this.options.clock ?? new SystemClock(),
          signal: new AbortController().signal,
          secrets: this.secrets,
          environment: {
            execute: (command, execOptions) => environment.execute(command, execOptions),
            workspaceDir: () => environment.workspaceDir(),
          },
          artifacts: this.artifactSink(run),
        };
      },
    }, options);
  }

  async listRuns(filter?: Parameters<AgentOSStore['runs']['list']>[0]): Promise<AgentRun[]> {
    const page = await this.store.runs.list(filter ?? {});
    return page.items;
  }

  async pendingApprovals(organizationId?: string): Promise<Approval[]> {
    return this.store.approvals.pending(organizationId);
  }

  async decideApproval(input: {
    approvalId: string;
    decision: 'approve' | 'deny' | 'modify';
    decidedBy: string;
    reason?: string;
    modifiedArguments?: JsonValue;
  }): Promise<Approval> {
    const approval = await this.approvals.decide(input);
    await this.events.emit({
      type: approval.status === 'granted' ? 'approval.granted' : approval.status === 'denied' ? 'approval.denied' : 'approval.modified',
      runId: approval.runId,
      organizationId: approval.organizationId,
      projectId: approval.projectId,
      data: {
        approvalId: approval.id,
        toolId: approval.toolId,
        decidedBy: input.decidedBy,
        risk: approval.risk,
      },
    });
    return approval;
  }

  /** Stop accepting work: checkpoint active runs and release resources. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [runId, control] of this.controls) {
      control.pause();
      this.logger.info('graceful shutdown: pausing run', { runId });
    }
    for (const [runId, environment] of this.environments) {
      try {
        await environment.destroy();
      } catch (error) {
        this.logger.warn('failed to destroy environment during shutdown', {
          runId,
          error: (error as Error).message,
        });
      }
    }
    this.environments.clear();
  }

  // ------------------------------------------------------------------ helpers

  private locks(): LockManager {
    return this.options.locks ?? defaultLocks;
  }

  private storeRoot(): string {
    return this.options.dataDir ?? join(process.cwd(), '.kazi');
  }

  private defaultConfig(input: AgentRunInput): AgentRun['config'] {
    const provider = this.providers.list()[0];
    if (!provider) {
      throw new ConfigurationError('No model providers are registered', { agentId: input.agentId });
    }
    return {
      agentId: input.agentId,
      model: input.providers?.primary.model ?? 'default',
      provider: input.providers?.primary.provider ?? provider.id,
      tools: [],
      limits: {},
      permissions: input.permissions ?? {},
      memoryEnabled: false,
      planningEnabled: false,
      verificationEnabled: false,
      recoveryEnabled: true,
    };
  }

  private gatewayFor(run: AgentRun): ModelGateway {
    const chain = [
      { provider: run.config.provider, model: run.config.model },
      ...(run.config.fallbackProviders ?? []),
    ];
    return new ModelGateway({
      registry: this.providers,
      chain,
      onEvent: (event) => {
        if (event.type !== 'failover' && event.type !== 'circuit_open') return;
        void this.events.emit({
          type: 'model.failover',
          runId: run.id,
          organizationId: run.organizationId,
          projectId: run.projectId,
          traceId: run.traceId,
          data: { provider: event.provider, model: event.model, attempt: event.attempt, reason: event.reason ?? event.type },
        });
      },
    });
  }

  private async nextProviderFor(runId: string): Promise<{ provider: string; model: string } | undefined> {
    const run = await this.store.runs.get(runId);
    if (!run) return undefined;
    return run.config.fallbackProviders?.[0];
  }

  private async latestRunFromRequest(metadata?: JsonObject): Promise<AgentRun> {
    const runId = metadata?.['runId'];
    if (typeof runId !== 'string') throw new ValidationError('Model requests must carry a runId');
    return this.getRun(runId);
  }

  private plannerFor(run: AgentRun): Planner | undefined {
    const injected =
      typeof this.options.planner === 'function' ? this.options.planner({ run }) : this.options.planner;
    if (injected) return injected;
    if (!run.config.planningEnabled) return undefined;
    const provider = this.providerFor(run);
    return new LlmPlanner({ provider, model: run.config.model, maxSteps: run.limits.maxSteps ?? 12 });
  }

  private deterministicPlanner(): Planner {
    return new DeterministicPlanner({});
  }

  private providerFor(run: AgentRun): ModelProvider {
    return new GatewayProvider({
      gateway: this.gatewayFor(run),
      id: `gateway:${run.config.provider}`,
      defaultModel: run.config.model,
    });
  }

  private async revisePlan(
    run: AgentRun,
    state: AgentState,
    classification: { kind: string; message: string; category: string },
  ): Promise<Plan | undefined> {
    const planner = this.plannerFor(run);
    if (!planner || !state.plan) return undefined;
    try {
      return await planner.revisePlan(
        {
          runId: run.id,
          goal: run.goal,
          agentId: run.agentId,
          observations: state.observations.map((observation) => ({
            source: observation.source,
            trust: observation.trust,
            content: observation.summary,
          })),
          availableTools: this.tools.resolve(run.config.tools).map((tool) => ({ id: tool.id, description: tool.description })),
          previousPlan: state.plan,
          failure: { code: classification.kind, message: classification.message, category: classification.category },
          attempt: state.plan.version,
        },
        state.plan,
        { code: classification.kind, message: classification.message, category: classification.category },
      );
    } catch (error) {
      this.logger.warn('re-planning failed; continuing with the existing plan', {
        runId: run.id,
        error: (error as Error).message,
      });
      return undefined;
    }
  }

  private async definitionFor(run: AgentRun): Promise<AgentDefinition | undefined> {
    try {
      return await this.agents.get(run.organizationId, run.agentId, run.config.agentVersion);
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }

  private async systemPromptFor(run: AgentRun, definition?: AgentDefinition): Promise<string> {
    if (this.options.resolveSystemPrompt) {
      return this.options.resolveSystemPrompt({ run, ...(definition ? { definition } : {}) });
    }
    if (definition && this.options.prompts) {
      const resolved = await this.options.prompts.resolve(definition.systemPrompt);
      const recorded = run.metadata?.['prompt'];
      if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
        const hash = (recorded as JsonObject)['hash'];
        if (typeof hash === 'string' && hash !== resolved.hash) {
          throw new ValidationError('The resolved system prompt does not match the prompt recorded for this run', {
            runId: run.id,
            expected: hash,
            actual: resolved.hash,
          });
        }
      }
      return resolved.text;
    }
    const inline = run.metadata?.['systemPrompt'];
    if (typeof inline === 'string' && inline.trim().length > 0) return inline;
    if (definition) return `You are ${definition.id}. Objective: ${run.goal}`;
    return `You are an autonomous software agent operating as ${run.agentId}. Pursue the objective with the tools you are given.`;
  }

  private async stateFor(run: AgentRun): Promise<AgentState> {
    const stored = await this.store.states.load(run.id);
    if (!stored) return { ...emptyState(run), usage: run.usage };
    return {
      runId: run.id,
      status: run.status,
      stateVersion: stored.stateVersion,
      ...(stored.plan ? { plan: stored.plan } : {}),
      ...(stored.currentStepId ? { currentStepId: stored.currentStepId } : {}),
      usage: run.usage,
      context: stored.context,
      observations: stored.observations,
      updatedAt: run.updatedAt,
    };
  }

  private async environmentFor(run: AgentRun): Promise<ExecutionEnvironment> {
    const existing = this.environments.get(run.id);
    if (existing) return existing;
    const config: EnvironmentProviderConfig = this.environmentProvider ?? {
      kind: 'local',
      workspaceRoot: this.workspace.rootDir,
      snapshotStoreRoot: join(this.storeRoot(), 'snapshots', run.id),
    };
    const provider = createEnvironmentProvider(config);
    const environment = await provider.create({
      runId: run.id,
      organizationId: run.organizationId,
      workspaceDir: run.workspaceDir,
    });
    await environment.create();
    this.environments.set(run.id, environment);
    return environment;
  }

  private async environmentForId(runId: string): Promise<ExecutionEnvironment> {
    const run = await this.getRun(runId);
    return this.environmentFor(run);
  }

  private readonly permissionCache = new Map<string, ToolPermissions>();

  private artifactSink(run: AgentRun): ArtifactSink {
    return {
      write: async (input) => {
        const buffer = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
        const sha256 = hashObject({ size: buffer.byteLength, content: buffer.toString('base64') });
        const dir = join(run.workspaceDir, '.kazi-artifacts');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, input.name);
        await import('node:fs').then((fs) => fs.writeFileSync(path, buffer));
        const artifact: ArtifactRef = {
          artifactId: `art_${sha256.slice(0, 26)}`,
          runId: run.id,
          name: input.name,
          sha256,
          size: buffer.byteLength,
          mimeType: input.mimeType ?? 'application/octet-stream',
          createdAt: this.now(),
          path,
        };
        const list = this.artifacts.get(run.id) ?? [];
        list.push(artifact);
        this.artifacts.set(run.id, list);
        await this.store.artifacts.save({
          id: artifact.artifactId,
          runId: run.id,
          organizationId: run.organizationId,
          projectId: run.projectId,
          name: artifact.name,
          path,
          sha256: artifact.sha256,
          size: artifact.size,
          mimeType: artifact.mimeType,
          createdAt: artifact.createdAt,
        });
        return { artifactId: artifact.artifactId, sha256: artifact.sha256, size: artifact.size };
      },
    };
  }

  private artifactSinkById(runId: string): ArtifactSink {
    return {
      write: async (input) => {
        const run = await this.getRun(runId);
        return this.artifactSink(run).write(input);
      },
    };
  }

  private async advance(run: AgentRun, target: AgentRun['status'], reason: string): Promise<AgentRun> {
    return advanceRunTo({ store: this.store, events: this.events, run, target, reason });
  }

  private async afterOutcome(run: AgentRun, outcome: LoopOutcome): Promise<void> {
    this.logger.info('run reached a resting point', {
      runId: run.id,
      status: outcome.status,
      reason: outcome.reason ?? '',
    });
    if (outcome.status === 'completed' || outcome.status === 'failed' || outcome.status === 'cancelled' || outcome.status === 'timed_out') {
      const environment = this.environments.get(run.id);
      this.environments.delete(run.id);
      if (environment) {
        // A finished run keeps its workspace on disk (artifacts and diffs are
        // evidence) but releases the execution environment.
        await environment.destroy().catch(() => undefined);
      }
    }
  }

  private async copyWorkspace(sourceRunId: string, targetRunId: string): Promise<void> {
    const source = await this.store.runs.get(sourceRunId);
    const target = await this.store.runs.get(targetRunId);
    if (!source || !target) return;
    const snapshot = await this.store.checkpoints.latest(sourceRunId);
    if (!snapshot?.environmentSnapshot) return;
    restoreWorkspace({ ...snapshot.environmentSnapshot, workspaceDir: target.workspaceDir }, { removeExtra: false });
  }

  /** Load the definition and expose the verifier for a run. */
  private async verifierFor(run: AgentRun, definition?: AgentDefinition): Promise<ProgressVerifier | undefined> {
    // A factory that declines (returns undefined) means "no override for this
    // run", not "this run has no verification": otherwise an agent whose
    // definition declares verification commands would silently skip it.
    const override =
      typeof this.options.verifier === 'function'
        ? await this.options.verifier({ run, ...(definition ? { definition } : {}) })
        : this.options.verifier;
    if (override) return override;
    const commands = definition?.verification.commands ?? [];
    if (commands.length === 0) return undefined;
    return new CompositeVerifier([
      new CommandVerifier({ commands }),
      new FilesystemVerifier({ checks: [] }, (path) => {
        try {
          return readFileSync(join(run.workspaceDir, path), 'utf8');
        } catch {
          return undefined;
        }
      }),
    ]);
  }

  /** Exposed for the loop wiring and for tests. */
  async verifyRun(runId: string): Promise<VerificationResult | undefined> {
    const run = await this.getRun(runId);
    const definition = await this.definitionFor(run);
    const verifier = await this.verifierFor(run, definition);
    if (!verifier) return undefined;
    const environment = await this.environmentFor(run);
    const state = await this.stateFor(run);
    return verifier.verify({
      runId,
      objective: run.goal,
      ...(state.plan ? { plan: state.plan } : {}),
      observations: state.observations,
      environment,
      permissions: run.config.permissions,
      commands: definition?.verification.commands ?? [],
    });
  }

}

/** The most recent verification outcome recorded for a run, if any. */
function lastVerificationFromEvents(
  events: Array<{ type: string; data: JsonObject }>,
): { passed: boolean; summary: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'verification.completed') continue;
    const passed = event.data['passed'];
    const summary = event.data['summary'];
    if (typeof passed !== 'boolean') return undefined;
    return { passed, summary: typeof summary === 'string' ? summary : passed ? 'verification passed' : 'verification failed' };
  }
  return undefined;
}

const defaultLocks = new InMemoryLockManager(5 * 60_000);

function normalizeSecrets(input?: SecretProvider | SecretResolver): SecretResolver {
  if (!input) {
    return {
      resolve: async (reference: string) => {
        const value = process.env[envNameFor(reference)];
        if (value === undefined) throw new ConfigurationError(`Secret not configured: ${reference}`, { reference });
        return value;
      },
      has: async (reference: string) => process.env[envNameFor(reference)] !== undefined,
    };
  }
  if ('resolve' in input) return input;
  return {
    resolve: (reference) => input.get(reference),
    has: async (reference) => (input.has ? input.has(reference) : (await input.get(reference)) !== undefined),
  };
}

/** `secret://github/token` and `github/token` both map to `KAZI_SECRET_GITHUB_TOKEN`. */
export function envNameFor(reference: string): string {
  const name = reference.replace(/^secret:\/\//, '');
  return `KAZI_SECRET_${name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
}
