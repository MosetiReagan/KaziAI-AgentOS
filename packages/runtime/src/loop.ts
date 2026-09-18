import {
  AgentError,
  BudgetExceededError,
  ResourceExhaustedError,
  ValidationError,
  hashObject,
  persistedBytes,
  toAgentError,
  type AgentAction,
  type AgentRun,
  type AgentState,
  type Checkpoint,
  type FailureClassification,
  type JsonObject,
  type Plan,
  type PolicyDecision,
  type RecoveryContext,
  type RecoveryDecision,
  type RiskLevel,
  type Redactor,
  type RunState,
} from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { ActionOutcome, ExecutionOutcome, Executor } from '@kazi-ai/agentos-executor';
import type { CheckpointManager } from '@kazi-ai/agentos-checkpoints';
import type { DefaultRecoveryEngine } from '@kazi-ai/agentos-recovery';
import type { ModelStep, ModelStepResult } from './model-step.js';
import type { ProgressVerifier } from './verification.js';
import { RunSession, type RecordedStep, type RunSessionOptions } from './session.js';
type RunSessionEnvironment = NonNullable<RunSessionOptions['environment']>;
import type { RunControl } from './control.js';
import type { EventWriter } from './events.js';
import type { SpanFactory } from '@kazi-ai/agentos-tracing';
import type { ToolRegistry } from '@kazi-ai/agentos-tools';
import type { RiskClassifier } from '@kazi-ai/agentos-policies';

export type LoopOutcomeStatus = 'completed' | 'failed' | 'paused' | 'cancelled' | 'timed_out' | 'waiting';

export interface LoopOutcome {
  status: LoopOutcomeStatus;
  reason?: string;
  error?: AgentError;
  verification?: { passed: boolean; summary: string };
  checkpointId?: string;
}

export interface AgentLoopOptions {
  store: AgentOSStore;
  events: EventWriter;
  budgets: RunSessionOptions['budgets'];
  executor: Executor;
  checkpoints: CheckpointManager;
  recovery: DefaultRecoveryEngine;
  modelStep: ModelStep;
  registry: ToolRegistry;
  risk: RiskClassifier;
  /** Scrubs known secret values out of anything the loop persists. */
  redactor?: Redactor;
  spans?: SpanFactory;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void; info(msg: string, fields?: Record<string, unknown>): void };
  now?: () => number;
  revisePlan?(input: { run: AgentRun; state: AgentState; classification: FailureClassification }): Promise<Plan | undefined>;
  /** Planner for this run, or undefined when planning is disabled. */
  plannerFor?(run: AgentRun): import('@kazi-ai/agentos-core').Planner | undefined;
}

export interface AgentLoopInput {
  run: AgentRun;
  state: AgentState;
  systemPrompt: string;
  control: RunControl;
  verificationCommands?: string[];
  environment?: RunSessionEnvironment;
  verifier?: ProgressVerifier;
  maxNoProgressIterations?: number;
}

/**
 * The execution loop. Every phase from the specification is its own method, so
 * each can be tested in isolation and so the trace shows where time went:
 *
 *   check_limits → observe → plan → decide → act → record → recover →
 *   checkpoint → update_context
 */
export class AgentLoop {
  private readonly now: () => number;

  constructor(private readonly options: AgentLoopOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async run(input: AgentLoopInput): Promise<LoopOutcome> {
    const session = new RunSession(input, {
      store: this.options.store,
      events: this.options.events,
      budgets: this.options.budgets,
      ...(this.options.spans ? { spans: this.options.spans } : {}),
      persistState: (state, expectedVersion) => this.options.store.states.save(state, expectedVersion),
    });
    try {
      return await this.iterate(session, input);
    } catch (error) {
      // Nothing may escape unclassified: an exception that skipped this
      // handler used to leave the run stuck in EXECUTING with no persisted
      // failure (spec §104).
      return this.containFailure(session, error);
    }
  }

  private async iterate(session: RunSession, input: AgentLoopInput): Promise<LoopOutcome> {
    const maxNoProgress = input.maxNoProgressIterations ?? 3;
    let noProgress = 0;
    let iterations = 0;

    for (;;) {
      iterations += 1;

      const limitOutcome = await this.checkLimits(session);
      if (limitOutcome) return limitOutcome;

      if (session.control.cancelled) return this.cancel(session);
      if (session.control.paused) return this.pause(session);
      const external = await this.options.store.runs.get(session.run.id);
      if (external && external.status === 'CANCELLED') return this.cancel(session);
      if (external && external.status === 'PAUSED') return this.pause(session);

      if (iterations > session.maxSteps) {
        return this.fail(
          session,
          new ResourceExhaustedError(`Run exceeded its step limit of ${session.maxSteps}`, {
            dimension: 'steps',
            limit: session.maxSteps,
          }),
        );
      }

      await this.observe(session);

      if (!session.state.plan) {
        const planned = await this.plan(session);
        if (planned) return planned;
      }

      const step = session.currentStepRef();
      const decided = await this.decideSafely(session, step);
      if (decided.outcome) return decided.outcome;
      if (!decided.decision) continue;
      const decision = decided.decision;
      // Every model call is accounted for, including the one that ends the run
      // and any call that fails a budget: usage must not depend on the action.
      await this.accountModelCall(session, decision);
      if (decision.finished) {
        const finished = await this.finish(session, decision);
        // A failed verification sends the run back to work rather than ending it.
        if (finished) return finished;
        continue;
      }
      session.lastActions = decision.actions;

      // Repeating an identical action set is not progress, however successful
      // each individual call was (spec §"loop forever").
      const signature = hashObject(
        decision.actions.map((action) => ({ toolId: action.toolId, arguments: action.arguments })),
      );
      noProgress = signature === session.lastSignature ? noProgress + 1 : 0;
      session.lastSignature = signature;

      const execution = await this.act(session, decision.actions, step);
      const recorded = await this.record(session, decision, execution, step);
      if (recorded) return recorded;

      if (execution.awaitingApproval > 0) return this.awaitApproval(session, execution);

      if (execution.denied > 0) {
        session.denials += execution.denied;
        if (session.denials >= 3) {
          return this.fail(
            session,
            new AgentError({
              code: 'policy.repeated_denials',
              message: 'The agent repeatedly attempted actions that policy denies',
              category: 'policy',
              terminal: true,
              idempotency: 'idempotent',
            }),
          );
        }
      }

      if (execution.failed > 0) {
        const recoveryOutcome = await this.recover(session, execution, step);
        if (recoveryOutcome) return recoveryOutcome;
      }

      await this.checkpointIfRequired(session, 'after_tool_call');

      if (noProgress >= maxNoProgress) {
        return this.fail(
          session,
          new AgentError({
            code: 'run.no_progress',
            message: `No progress after ${noProgress} iterations; stopping instead of looping forever`,
            category: 'state',
            terminal: true,
            idempotency: 'unknown',
          }),
        );
      }

      await session.persist();
    }
  }

  /**
   * Storage can only be measured after a tool commits, so it is the one budget
   * dimension re-checked mid-step. Without this a single large write could
   * overshoot the quota by an entire step before the next iteration noticed.
   */
  private async checkStorageLimit(session: RunSession): Promise<LoopOutcome | undefined> {
    const status = session.budgetReport().statuses.find((item) => item.dimension === 'storageBytes');
    if (!status?.exceeded) return undefined;
    await session.emit('budget.exceeded', {
      dimension: 'storageBytes',
      used: status.used,
      limit: status.limit ?? null,
    });
    return this.fail(
      session,
      new BudgetExceededError('storageBytes', status.limit ?? 0, status.used),
    );
  }

  /** Phase 1: enforce every budget dimension independently of the model. */
  async checkLimits(session: RunSession): Promise<LoopOutcome | undefined> {
    const report = session.budgetReport();
    for (const warning of report.warnings) {
      if (session.warned.has(warning.dimension)) continue;
      session.warned.add(warning.dimension);
      await session.emit('budget.warning', {
        dimension: warning.dimension,
        used: warning.used,
        limit: warning.limit ?? null,
      });
    }
    const breach = report.exceeded[0];
    if (!breach) return undefined;
    await session.emit('budget.exceeded', {
      dimension: breach.dimension,
      used: breach.used,
      limit: breach.limit ?? null,
    });
    const error = new BudgetExceededError(breach.dimension, breach.limit ?? 0, breach.used);
    if (breach.dimension === 'durationMs') {
      await session.finishWith('TIMED_OUT', 'run.timed_out', { reason: error.message, dimension: breach.dimension }, error.message);
      return { status: 'timed_out', error, reason: error.message };
    }
    return this.fail(session, error);
  }

  /** Remove every secret value this process has resolved from a payload. */
  private scrub<T>(value: T): T {
    return this.options.redactor?.scrubDeep(value) ?? value;
  }

  /** Phase 2: look at the durable world before deciding anything. */
  async observe(session: RunSession): Promise<void> {
    const journal = await this.options.store.actions.list(session.run.id);
    session.committed = journal.filter((entry) => entry.status === 'succeeded' || entry.status === 'failed');
    session.pendingJournal = journal.filter((entry) => entry.status === 'executing');
    await session.advanceTo('OBSERVING', 'observing current state');
  }

  /** Phase 3a: create the advisory plan. */
  async plan(session: RunSession): Promise<LoopOutcome | undefined> {
    const planner = this.options.plannerFor?.(session.run);
    if (!planner) return undefined;
    await session.advanceTo('PLANNING', 'creating a plan');
    const tools = this.options.registry.resolve(session.run.config.tools);
    const plan = await planner.createPlan({
      runId: session.run.id,
      goal: session.run.goal,
      agentId: session.run.agentId,
      observations: session.state.observations.map((observation) => ({
        source: observation.source,
        trust: observation.trust,
        content: observation.summary,
      })),
      availableTools: tools.map((tool) => ({ id: tool.id, description: tool.description })),
      attempt: 0,
    });
    session.state.plan = plan;
    session.run.plan = plan;
    await session.emit('plan.created', {
      planId: plan.id,
      version: plan.version,
      steps: plan.steps.length,
      objective: plan.objective,
    });
    await session.recordStep({
      id: `plan_${plan.id}`,
      index: 0,
      description: `Plan: ${plan.objective}`,
      phase: 'plan',
      status: 'completed',
      startedAt: this.now(),
      finishedAt: this.now(),
      detail: { steps: plan.steps.length, version: plan.version },
    });
    await this.checkpointIfRequired(session, 'after_plan');
    await session.persist();
    return undefined;
  }

  /** Phase 3b: ask the model what to do next. */
  async decide(session: RunSession, step: { id: string; index: number; description: string } | undefined): Promise<ModelStepResult> {
    const tools = this.options.registry.toDefinitions(session.run.config.tools);
    if (tools.length === 0) {
      throw new ValidationError('No tools are configured for this agent; nothing can be executed', {
        agentId: session.run.agentId,
      });
    }
    await session.advanceTo('EXECUTING', 'deciding the next action');
    const span = session.span('agent.model', {
      'model.name': session.run.config.model,
      'model.provider': session.run.config.provider,
    });
    const result = await this.options.modelStep.run({
      run: session.run,
      state: session.state,
      systemPrompt: session.systemPrompt,
      tools,
      ...(step ? { stepId: step.id } : {}),
      stepIndex: session.stepIndex,
      attempt: session.attempts,
      signal: session.control.signal,
      ...(session.run.limits.stepTimeoutMs === undefined ? {} : { timeoutMs: session.run.limits.stepTimeoutMs }),
      ...(session.verification ? { verification: session.verification } : {}),
    });
    span.setAttributes({
      'model.provider': result.provider,
      'model.name': result.model,
      'model.tokens': result.usage.totalTokens,
      'model.cost_usd': result.costUsd,
    });
    span.end();

    await session.emit('model.responded', {
      provider: result.provider,
      model: result.model,
      tokens: result.usage.totalTokens,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      toolCalls: result.actions.length,
      failedOver: result.failedOver,
    });
    if (result.reflection) session.reflections.push(result.reflection);
    return result;
  }

  /** Phase 4: authorize and execute, through the executor. */
  async act(
    session: RunSession,
    actions: AgentAction[],
    step: { id: string; index: number; description: string } | undefined,
  ): Promise<ExecutionOutcome> {
    const risk = highestRisk(actions.map((action) => this.options.risk.classify(action).risk));
    await this.checkpointIfRequired(session, 'before_risky_action', { risk });

    if (step) {
      await session.emit('step.started', { stepId: step.id, index: step.index, description: step.description });
      await session.recordStep({
        id: step.id,
        index: step.index,
        description: step.description,
        phase: 'execute',
        status: 'running',
        startedAt: this.now(),
        ...(actions[0]?.toolId ? { toolId: actions[0].toolId } : {}),
      });
    }
    // One request event per action, carrying the action id the terminal event
    // will also carry: the trace can then fold a call into a single node and the
    // journal, events and trace all agree on identity.
    for (const action of actions) {
      await session.emit('tool.requested', {
        toolId: action.toolId,
        actionId: action.id,
        idempotency: action.idempotency,
        risk: this.options.risk.classify(action).risk,
        attempt: action.attempt,
        ...(step ? { stepId: step.id } : {}),
      });
    }
    if (actions.length === 0) {
      await session.emit('tool.requested', { actions: 0, tools: '', risk, ...(step ? { stepId: step.id } : {}) });
    }

    const outcome = await this.options.executor.execute({
      runId: session.run.id,
      agentId: session.run.agentId,
      organizationId: session.run.organizationId,
      projectId: session.run.projectId,
      environment: session.environment?.kind ?? 'none',
      isolatingEnvironment: session.environment?.isolating === true,
      workspaceDir: session.run.workspaceDir,
      permissions: session.run.config.permissions,
      trust: 'trusted-policy',
      requestOrigin: 'agent',
      actions,
      ...(step ? { stepId: step.id } : {}),
      signal: session.control.signal,
      remainingBudget: session.budgetSnapshot(),
    });
    return outcome;
  }

  /**
   * Phase 4b: durable model-call accounting. Steps, tokens, latency and cost
   * are persisted per call so budgets survive a crash and cost attribution does
   * not depend on whether the model happened to call a tool.
   */
  async accountModelCall(session: RunSession, decision: ModelStepResult): Promise<void> {
    const usage = session.run.usage;
    session.addUsage({
      steps: usage.steps + 1,
      modelCalls: usage.modelCalls + 1,
      tokens: {
        inputTokens: usage.tokens.inputTokens + decision.usage.inputTokens,
        outputTokens: usage.tokens.outputTokens + decision.usage.outputTokens,
        totalTokens: usage.tokens.totalTokens + decision.usage.totalTokens,
        ...(decision.usage.cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: (usage.tokens.cachedInputTokens ?? 0) + decision.usage.cachedInputTokens }),
        ...(decision.usage.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: (usage.tokens.reasoningTokens ?? 0) + decision.usage.reasoningTokens }),
      },
      costUsd: usage.costUsd + decision.costUsd,
      durationMs: session.elapsedMs(),
    });
    session.stepIndex = session.run.usage.modelCalls;
    await this.options.store.usage.record({
      id: `use_${session.run.id}_${session.run.usage.modelCalls}`,
      runId: session.run.id,
      organizationId: session.run.organizationId,
      projectId: session.run.projectId,
      provider: decision.provider,
      model: decision.model,
      inputTokens: decision.usage.inputTokens,
      outputTokens: decision.usage.outputTokens,
      ...(decision.usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: decision.usage.cachedInputTokens }),
      ...(decision.usage.reasoningTokens === undefined ? {} : { reasoningTokens: decision.usage.reasoningTokens }),
      latencyMs: decision.durationMs,
      costUsd: decision.costUsd,
      success: true,
      at: this.now(),
    });
    await this.options.store.counters.saveUsage(session.run.id, session.run.usage);
  }

  /** Phase 5: record everything the execution produced. */
  async record(
    session: RunSession,
    decision: ModelStepResult,
    execution: ExecutionOutcome,
    step: { id: string; index: number; description: string } | undefined,
  ): Promise<LoopOutcome | undefined> {
    const usage = session.run.usage;
    const committed = execution.outcomes.filter(
      (outcome) => outcome.status === 'succeeded' || outcome.status === 'already_committed',
    );
    session.addUsage({
      toolCalls: usage.toolCalls + execution.outcomes.length,
      networkRequests:
        usage.networkRequests + execution.outcomes.filter((outcome) => outcome.toolId === 'http.request').length,
      // Byte budgets can only be charged after the tool ran, so the runtime
      // derives them from what each tool reported writing (spec §25/§70).
      storageBytes: Math.max(
        0,
        usage.storageBytes +
          committed.reduce((total, outcome) => total + persistedBytes(outcome.result), 0),
      ),
      durationMs: session.elapsedMs(),
    });

    for (const outcome of execution.outcomes) {
      await this.recordOutcome(session, outcome, step);
    }

    if (step) {
      const failed = execution.failed > 0 || execution.denied > 0;
      const waiting = execution.awaitingApproval > 0;
      await session.recordStep({
        id: step.id,
        index: step.index,
        description: step.description,
        phase: 'execute',
        status: waiting ? 'running' : failed ? 'failed' : 'completed',
        startedAt: this.now(),
        ...(waiting ? {} : { finishedAt: this.now() }),
        detail: {
          succeeded: execution.succeeded,
          failed: execution.failed,
          denied: execution.denied,
          replayed: execution.replayed,
        },
      });
      if (!waiting && !failed) {
        session.markStep(step.id, 'completed');
        await session.emit('step.completed', { stepId: step.id, index: step.index, description: step.description });
      }
    }

    if (decision.reflection) {
      session.state.observations.push({
        id: `obs_reflect_${session.stepIndex}`,
        at: this.now(),
        source: 'model',
        trust: 'agent',
        summary: `Agent reflection: ${String(decision.reflection['status'] ?? 'unknown')}`,
        detail: decision.reflection,
        ...(step ? { stepId: step.id } : {}),
      });
    }

    await session.persist();
    return this.checkStorageLimit(session);
  }

  private async recordOutcome(
    session: RunSession,
    outcome: ActionOutcome,
    step: { id: string } | undefined,
  ): Promise<void> {
    if (outcome.observation) session.state.observations.push(outcome.observation);
    if (outcome.status === 'succeeded' || outcome.status === 'failed' || outcome.status === 'already_committed') {
      await this.options.store.invocations.save({
        id: outcome.actionId,
        runId: session.run.id,
        toolId: outcome.toolId,
        actionId: outcome.actionId,
        status: outcome.status,
        durationMs: outcome.durationMs,
        success: outcome.status !== 'failed',
        at: this.now(),
      });
    }
    if (outcome.error && (outcome.status === 'failed' || outcome.status === 'denied')) {
      await this.options.store.failures.save({
        id: `fail_${outcome.actionId}`,
        runId: session.run.id,
        ...(step ? { stepId: step.id } : {}),
        toolId: outcome.toolId,
        code: outcome.error.code,
        category: outcome.error.category,
        // A failure message routinely quotes the command and its output, which
        // is exactly where a resolved credential would show up (spec §66).
        message: this.scrub(outcome.error.message),
        retryable: outcome.error.retryable,
        terminal: outcome.error.terminal,
        at: this.now(),
        detail: this.scrub(outcome.error.toJSON()),
      });
    }
    const type =
      outcome.status === 'succeeded' || outcome.status === 'already_committed'
        ? 'tool.completed'
        : outcome.status === 'denied'
          ? 'tool.denied'
          : outcome.status === 'awaiting_approval'
            ? 'approval.requested'
            : 'tool.failed';
    await session.emit(type, {
      toolId: outcome.toolId,
      actionId: outcome.actionId,
      status: outcome.status,
      durationMs: outcome.durationMs,
      ...(step ? { stepId: step.id } : {}),
    });
  }

  /** Phase 6: recover, or report that recovery has given up. */
  async recover(
    session: RunSession,
    execution: ExecutionOutcome,
    step: { id: string; index: number; description: string } | undefined,
  ): Promise<LoopOutcome | undefined> {
    // An agent that declared recovery off means it: a failure is reported, not
    // silently retried or re-planned behind the operator's back (spec §6, §35).
    if (session.run.config.recoveryEnabled === false) return undefined;

    const failedOutcome = execution.outcomes.find((outcome) => outcome.status === 'failed');
    if (!failedOutcome) return undefined;

    const error =
      failedOutcome.error ??
      new AgentError({
        code: 'tool.failed',
        message: `Tool ${failedOutcome.toolId} failed without a classified error`,
        category: 'tool',
        retryable: false,
        idempotency: 'unknown',
      });
    const classification = this.options.recovery.classify(error);
    const context: RecoveryContext = {
      runId: session.run.id,
      attempt: session.recoveryAttempts + 1,
      error,
      classification,
      toolId: failedOutcome.toolId,
      ...(step ? { stepId: step.id } : {}),
      actionCommitted: session.committed.some((entry) => entry.actionId === failedOutcome.actionId),
      ...(session.state.plan ? { plan: session.state.plan } : {}),
      budgetRemaining: session.budgetSnapshot(),
      metadata: {
        journalPending: session.pendingJournal.some((entry) => entry.actionId === failedOutcome.actionId),
        dependency: `tool:${failedOutcome.toolId}`,
      },
    };

    await session.advanceTo('RECOVERING', `recovering from ${classification.kind}`);
    await this.checkpointIfRequired(session, 'before_recovery');
    const span = session.span('agent.recovery', { 'recovery.kind': classification.kind, 'tool.id': failedOutcome.toolId });
    await session.emit('recovery.started', {
      kind: classification.kind,
      toolId: failedOutcome.toolId,
      attempt: context.attempt,
      retryable: classification.retryable,
    });

    const decision = await this.options.recovery.decide(context);
    const applied = await this.options.recovery.execute(decision, context);
    session.recoveryAttempts += 1;
    session.addUsage({ recoveryCount: session.run.usage.recoveryCount + 1 });

    await this.options.store.recoveries.save({
      id: `rec_${session.run.id}_${session.recoveryAttempts}`,
      runId: session.run.id,
      attempt: session.recoveryAttempts,
      strategy: decision.strategy,
      decision: decision as unknown as JsonObject,
      result: (applied.detail ?? {}) as JsonObject,
      success: applied.applied,
      at: this.now(),
    });
    span.setAttributes({ 'recovery.strategy': decision.strategy, 'recovery.applied': applied.applied });
    span.end();
    await session.emit('recovery.completed', {
      strategy: decision.strategy,
      applied: applied.applied,
      attempt: session.recoveryAttempts,
      terminal: decision.terminal === true,
    });

    return this.applyRecovery(session, decision, context, failedOutcome, step);
  }

  private async applyRecovery(
    session: RunSession,
    decision: RecoveryDecision,
    context: RecoveryContext,
    failedOutcome: ActionOutcome,
    step: { id: string; index: number; description: string } | undefined,
  ): Promise<LoopOutcome | undefined> {
    switch (decision.strategy) {
      case 'terminate':
        return this.fail(
          session,
          new AgentError({
            code: context.error.code,
            message: `${context.error.message} (recovery terminated: ${decision.reason})`,
            category: context.error.category,
            retryable: false,
            idempotency: context.error.idempotency,
            terminal: true,
          }),
        );

      case 'retry':
      case 'retry_with_backoff': {
        const original =
          session.lastActions.find((action) => action.id === failedOutcome.actionId) ??
          ({
            id: failedOutcome.actionId as AgentAction['id'],
            runId: session.run.id,
            toolId: failedOutcome.toolId,
            arguments: null,
            idempotencyKey: `idem_retry_${failedOutcome.actionId}_${session.attempts + 1}`,
            idempotency: 'unknown',
            status: 'pending',
            createdAt: this.now(),
            attempt: session.attempts,
          } satisfies AgentAction);
        session.attempts += 1;
        const retried = await this.options.executor.executeSingle(
          { ...original, attempt: session.attempts },
          {
            runId: session.run.id,
            agentId: session.run.agentId,
            organizationId: session.run.organizationId,
            projectId: session.run.projectId,
            environment: session.environment?.kind ?? 'none',
            isolatingEnvironment: session.environment?.isolating === true,
            workspaceDir: session.run.workspaceDir,
            trust: 'trusted-policy',
            requestOrigin: 'recovery',
            signal: session.control.signal,
          },
        );
        await this.recordOutcome(session, retried, step);

        if (retried.status === 'succeeded' || retried.status === 'already_committed') {
          session.addUsage({ toolCalls: session.run.usage.toolCalls + 1 });
          if (step) session.markStep(step.id, 'completed');
          await session.persist();
          return undefined;
        }
        if (step) session.markStep(step.id, 'failed');
        if (session.recoveryAttempts >= (session.run.limits.maxRecoveryAttempts ?? 5)) {
          return this.fail(session, context.error);
        }
        return this.recover(session, { ...emptyExecution(), failed: 1, outcomes: [retried] }, step);
      }

      case 'replan': {
        const revised = this.options.revisePlan
          ? await this.options.revisePlan({ run: session.run, state: session.state, classification: context.classification })
          : undefined;
        if (revised) {
          session.state.plan = revised;
          session.run.plan = revised;
          session.run.currentStepId = undefined;
          session.state.currentStepId = undefined;
          await session.emit('plan.revised', { planId: revised.id, version: revised.version, steps: revised.steps.length });
        } else if (step) {
          session.markStep(step.id, 'failed');
        }
        await session.persist();
        return undefined;
      }

      case 'restore_checkpoint': {
        const checkpoint = decision.checkpointId
          ? await this.options.checkpoints.get(decision.checkpointId)
          : await this.options.checkpoints.latest(session.run.id);
        if (!checkpoint) return this.fail(session, context.error);
        session.state.plan = checkpoint.state.plan ?? session.state.plan;
        session.state.observations = checkpoint.state.observations;
        session.state.context = checkpoint.state.context;
        session.state.currentStepId = checkpoint.state.currentStepId;
        session.run.plan = session.state.plan;
        await session.emit('checkpoint.created', {
          checkpointId: checkpoint.id,
          sequence: checkpoint.sequence,
          trigger: 'restore',
          restored: true,
        });
        await session.persist();
        return undefined;
      }

      case 'ask_human':
        return this.awaitRecoveryApproval(session, decision, context);

      case 'modify_arguments':
      case 'switch_tool':
      case 'skip_step':
      default: {
        if (step) session.markStep(step.id, decision.strategy === 'skip_step' ? 'skipped' : 'pending');
        await session.persist();
        return undefined;
      }
    }
  }

  /** Phase 7: verify the objective against the real world, then complete. */
  async finish(session: RunSession, decision: ModelStepResult): Promise<LoopOutcome | undefined> {
    // The model's closing statement is evidence, not instruction: it is kept as
    // an agent-authored observation so a reviewer can see what the run claims.
    const summary = decision.text.trim();
    if (summary.length > 0) {
      session.state.observations.push({
        id: `obs_final_${session.stepIndex}`,
        at: this.now(),
        source: 'model',
        trust: 'agent',
        summary: summary.slice(0, 2_000),
      });
    }
    if (session.verifier && session.run.config.verificationEnabled !== false) {
      await session.advanceTo('VERIFYING', 'verifying the objective');
      await session.emit('verification.started', { commands: session.verificationCommands.join(' ') });
      const span = session.span('agent.verification', {});
      const result = await session.verifier.verify({
        runId: session.run.id,
        objective: session.run.goal,
        ...(session.state.plan ? { plan: session.state.plan } : {}),
        observations: session.state.observations,
        ...(session.environment ? { environment: session.environment } : {}),
        permissions: session.run.config.permissions,
        ...(session.verificationCommands.length > 0 ? { commands: session.verificationCommands } : {}),
        signal: session.control.signal,
      });
      span.setAttributes({ passed: result.passed, 'verification.checks': result.checks.length });
      span.end();
      session.verification = { passed: result.passed, summary: result.summary };
      session.state.observations.push({
        id: `obs_verify_${session.stepIndex}`,
        at: result.at,
        source: 'verification',
        trust: 'trusted-policy',
        summary: result.summary,
        detail: {
          checks: result.checks.map((check) => ({ name: check.name, passed: check.passed, summary: check.summary })),
        },
      });
      await session.persist();
      await session.emit('verification.completed', { passed: result.passed, summary: result.summary });

      if (!result.passed) {
        const error = new AgentError({
          code: 'verification.failed',
          message: result.summary,
          category: 'validation',
          retryable: true,
          idempotency: 'idempotent',
          details: { checks: result.checks.length, passing: result.checks.filter((check) => check.passed).length },
        });
        await session.advanceTo('RECOVERING', 'verification failed');
        const context: RecoveryContext = {
          runId: session.run.id,
          attempt: session.recoveryAttempts + 1,
          error,
          classification: this.options.recovery.classify(error),
          actionCommitted: false,
          ...(session.state.plan ? { plan: session.state.plan } : {}),
          budgetRemaining: session.budgetSnapshot(),
          metadata: { dependency: 'verification' },
        };
        const recoveryDecision = await this.options.recovery.decide(context);
        const applied = await this.options.recovery.execute(recoveryDecision, context);
        session.recoveryAttempts += 1;
        session.addUsage({ recoveryCount: session.run.usage.recoveryCount + 1 });
        await this.options.store.recoveries.save({
          id: `rec_${session.run.id}_${session.recoveryAttempts}`,
          runId: session.run.id,
          attempt: session.recoveryAttempts,
          strategy: recoveryDecision.strategy,
          decision: recoveryDecision as unknown as JsonObject,
          result: (applied.detail ?? {}) as JsonObject,
          success: applied.applied,
          at: this.now(),
        });
        await session.emit('recovery.completed', {
          strategy: recoveryDecision.strategy,
          applied: applied.applied,
          attempt: session.recoveryAttempts,
          terminal: recoveryDecision.terminal === true,
        });

        const exhausted = session.recoveryAttempts > (session.run.limits.maxRecoveryAttempts ?? 5);
        if (recoveryDecision.terminal || recoveryDecision.strategy === 'terminate' || exhausted) {
          return this.fail(session, error, session.verification);
        }
        if (recoveryDecision.strategy === 'ask_human') {
          return this.awaitRecoveryApproval(session, recoveryDecision, context);
        }
        // Replan: put the completed steps back into play so the agent can fix
        // what verification found.
        if (session.state.plan) {
          for (const planStep of session.state.plan.steps) {
            if (planStep.status === 'completed' || planStep.status === 'failed') {
              planStep.status = 'pending';
              delete planStep.startedAt;
              delete planStep.finishedAt;
            }
          }
          session.state.plan.version += 1;
          session.run.plan = session.state.plan;
          await session.emit('plan.revised', {
            planId: session.state.plan.id,
            version: session.state.plan.version,
            reason: 'verification failed',
          });
        }
        session.run.currentStepId = undefined;
        session.state.currentStepId = undefined;
        await this.checkpointIfRequired(session, 'state_change', { force: true, label: 'verification-failed' });
        await session.persist();
        return undefined;
      }
    }

    await session.complete();
    return {
      status: 'completed',
      verification: session.verification ?? { passed: true, summary: 'no verification configured' },
    };
  }

  /** Phase 8: durable point-in-time capture. */
  async checkpointIfRequired(
    session: RunSession,
    trigger: Parameters<CheckpointManager['maybeCreate']>[0]['trigger'],
    options: { risk?: RiskLevel; force?: boolean; label?: string } = {},
  ): Promise<Checkpoint | undefined> {
    const input = {
      run: session.run,
      state: session.state,
      committedActions: session.committed,
      trigger,
      stepsSinceCheckpoint: session.stepsSinceCheckpoint,
      ...(options.risk ? { risk: options.risk } : {}),
      ...(options.label ? { label: options.label } : {}),
    };
    const checkpoint = options.force
      ? await this.options.checkpoints.create(input)
      : await this.options.checkpoints.maybeCreate(input);
    if (!checkpoint) return undefined;
    session.stepsSinceCheckpoint = 0;
    session.addUsage({ checkpointCount: session.run.usage.checkpointCount + 1 });
    await session.emit('checkpoint.created', {
      checkpointId: checkpoint.id,
      sequence: checkpoint.sequence,
      trigger,
      stateVersion: checkpoint.stateVersion,
    });
    return checkpoint;
  }

  /**
   * Ask the model for the next action, and if the ask itself fails (provider
   * outage, protocol error, malformed tool request) classify it and let the
   * recovery engine decide instead of throwing out of the run.
   */
  private async decideSafely(
    session: RunSession,
    step: { id: string; index: number; description: string } | undefined,
  ): Promise<{ decision?: ModelStepResult; outcome?: LoopOutcome }> {
    try {
      return { decision: await this.decide(session, step) };
    } catch (error) {
      if (session.control.cancelled) return { outcome: await this.cancel(session) };
      const agentError = toAgentError(error);
      const classification = this.options.recovery.classify(agentError);
      if (classification.kind === 'cancelled') return { outcome: await this.cancel(session) };
      return { outcome: await this.recoverFromDecisionFailure(session, agentError, classification) };
    }
  }

  /** Recovery for failures that happened before any action could be authorized. */
  private async recoverFromDecisionFailure(
    session: RunSession,
    error: AgentError,
    classification: FailureClassification,
  ): Promise<LoopOutcome | undefined> {
    await session.advanceTo('RECOVERING', `recovering from ${classification.kind}`);
    const context: RecoveryContext = {
      runId: session.run.id,
      attempt: session.recoveryAttempts + 1,
      error,
      classification,
      actionCommitted: false,
      ...(session.state.plan ? { plan: session.state.plan } : {}),
      budgetRemaining: session.budgetSnapshot(),
      metadata: { phase: 'decide' },
    };
    await session.emit('recovery.started', {
      kind: classification.kind,
      toolId: null,
      attempt: context.attempt,
      retryable: classification.retryable,
    });
    const decision = await this.options.recovery.decide(context);
    const applied = await this.options.recovery.execute(decision, context);
    session.recoveryAttempts += 1;
    session.addUsage({ recoveryCount: session.run.usage.recoveryCount + 1 });
    await this.options.store.recoveries.save({
      id: `rec_${session.run.id}_${session.recoveryAttempts}`,
      runId: session.run.id,
      attempt: session.recoveryAttempts,
      strategy: decision.strategy,
      decision: decision as unknown as JsonObject,
      result: (applied.detail ?? {}) as JsonObject,
      success: applied.applied,
      at: this.now(),
    });
    await session.emit('recovery.completed', {
      strategy: decision.strategy,
      applied: applied.applied,
      attempt: session.recoveryAttempts,
      terminal: decision.terminal === true,
    });
    await session.persist();

    if (decision.terminal || decision.strategy === 'terminate') {
      return this.fail(session, error);
    }
    if (decision.strategy === 'ask_human') {
      return this.awaitRecoveryApproval(session, decision, context);
    }
    if (decision.strategy === 'restore_checkpoint') {
      const checkpoint = decision.checkpointId
        ? await this.options.checkpoints.get(decision.checkpointId)
        : await this.options.checkpoints.latest(session.run.id);
      if (checkpoint) {
        session.state.plan = checkpoint.state.plan ?? session.state.plan;
        session.state.observations = checkpoint.state.observations;
        session.state.context = checkpoint.state.context;
        session.run.plan = session.state.plan;
        await session.emit('checkpoint.created', {
          checkpointId: checkpoint.id,
          sequence: checkpoint.sequence,
          trigger: 'restore',
          restored: true,
        });
        await session.persist();
        return undefined;
      }
      return this.fail(session, error);
    }
    if (decision.strategy === 'replan') {
      const revised = this.options.revisePlan
        ? await this.options.revisePlan({ run: session.run, state: session.state, classification })
        : undefined;
      if (revised) {
        session.state.plan = revised;
        session.run.plan = revised;
        await session.emit('plan.revised', { planId: revised.id, version: revised.version, steps: revised.steps.length });
        await session.persist();
        return undefined;
      }
      return this.fail(session, error);
    }
    if (decision.strategy === 'retry' || decision.strategy === 'retry_with_backoff' || decision.strategy === 'switch_provider') {
      const maxAttempts = session.run.limits.maxRecoveryAttempts ?? 3;
      if (session.recoveryAttempts < maxAttempts) return undefined;
      return this.fail(session, error);
    }
    // Strategies that only make sense against a concrete action (modify
    // arguments, switch tool, skip step) cannot be applied to a failed model
    // call: end the run loudly rather than looping on a broken agent (spec §104).
    return this.fail(session, error);
  }

  /** Last-resort containment for an exception from any other loop phase. */
  private async containFailure(session: RunSession, error: unknown): Promise<LoopOutcome> {
    if (session.control.cancelled) return this.cancel(session);
    const agentError = toAgentError(error);
    this.options.logger?.warn('agent loop aborted with an unhandled error', {
      runId: session.run.id,
      code: agentError.code,
      message: agentError.message,
    });
    await session.emit('run.error', {
      code: agentError.code,
      category: agentError.category,
      message: agentError.message,
    });
    const classification = this.options.recovery.classify(agentError);
    if (classification.kind === 'cancelled') return this.cancel(session);
    return this.fail(session, agentError);
  }

  private async awaitApproval(session: RunSession, execution: ExecutionOutcome): Promise<LoopOutcome> {
    const pending = execution.outcomes.find((outcome) => outcome.status === 'awaiting_approval');
    await this.checkpointIfRequired(session, 'before_risky_action', { force: true, label: 'awaiting-approval' });
    await session.advanceTo('WAITING', 'waiting for human approval');
    await session.persist();
    return {
      status: 'waiting',
      reason: pending?.error?.message ?? 'approval required',
      ...(pending?.error ? { error: pending.error } : {}),
    };
  }

  private async awaitRecoveryApproval(
    session: RunSession,
    decision: RecoveryDecision,
    context: RecoveryContext,
  ): Promise<LoopOutcome> {
    await session.advanceTo('WAITING', 'recovery needs a human decision');
    await session.emit('approval.requested', {
      toolId: context.toolId ?? null,
      risk: context.classification.risk,
      reason: `${decision.reason} (${context.classification.kind})`,
      recovery: true,
    });
    await session.persist();
    return { status: 'waiting', reason: decision.reason, error: context.error };
  }

  private async pause(session: RunSession): Promise<LoopOutcome> {
    const checkpoint = await this.checkpointIfRequired(session, 'before_pause', { force: true });
    await session.advanceTo('PAUSED', 'paused by operator');
    await session.emit('run.paused', { checkpointId: checkpoint?.id ?? null });
    await session.persist();
    return { status: 'paused', ...(checkpoint ? { checkpointId: checkpoint.id } : {}) };
  }

  private async cancel(session: RunSession): Promise<LoopOutcome> {
    const reason = session.control.cancelReason ?? 'cancelled';
    await session.finishWith('CANCELLED', 'run.cancelled', { reason }, reason);
    return { status: 'cancelled', reason };
  }

  private async fail(
    session: RunSession,
    error: AgentError,
    verification?: { passed: boolean; summary: string },
  ): Promise<LoopOutcome> {
    session.run.error = error.toJSON();
    const toolId = typeof error.details?.['toolId'] === 'string' ? (error.details['toolId'] as string) : 'runtime';
    await this.options.store.failures.save({
      id: `fail_${session.run.id}_${error.code.replace(/[^a-zA-Z0-9]+/g, '_')}_${session.run.usage.steps}`,
      runId: session.run.id,
      toolId,
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      terminal: true,
      at: this.now(),
      detail: error.toJSON(),
    });
    await session.finishWith(
      'FAILED',
      'run.failed',
      { code: error.code, message: error.message, category: error.category },
      error.message,
    );
    return { status: 'failed', error, reason: error.message, ...(verification ? { verification } : {}) };
  }
}

export function highestRisk(risks: RiskLevel[]): RiskLevel {
  const order: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return risks.reduce<RiskLevel>((highest, current) => (order[current] > order[highest] ? current : highest), 'LOW');
}

function emptyExecution(): ExecutionOutcome {
  return { outcomes: [], waves: 0, succeeded: 0, failed: 0, denied: 0, awaitingApproval: 0, replayed: 0 };
}

/** Every phase name, used by the trace and by tests. */
export const LOOP_PHASES: readonly RunState[] = [
  'CREATED',
  'QUEUED',
  'INITIALIZING',
  'PLANNING',
  'EXECUTING',
  'OBSERVING',
  'VERIFYING',
  'RECOVERING',
  'WAITING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
];

export type { PolicyDecision, RecordedStep };
