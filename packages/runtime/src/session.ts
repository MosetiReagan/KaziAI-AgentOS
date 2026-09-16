import {
  allowedTargets,
  canTransition,
  createEvent,
  nextStateFor,
  type AgentEvent,
  type AgentEventType,
  type AgentRun,
  type AgentState,
  type BudgetManager,
  type ExecutionEnvironment,
  type JournalEntry,
  type JsonObject,
  type RunState,
  type RunUsage,
} from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { EventWriter } from './events.js';
import type { RunControl } from './control.js';
import type { RunStepRecord } from '@kazi-ai/agentos-persistence';
import type { SpanFactory, ActiveSpan } from '@kazi-ai/agentos-tracing';
import { toAgentRunResult } from './support.js';

export interface RunSessionOptions {
  store: AgentOSStore;
  events: EventWriter;
  budgets: BudgetManager;
  spans?: SpanFactory;
  environment?: ExecutionEnvironment;
}

export interface RunSessionInput {
  run: AgentRun;
  state: AgentState;
  systemPrompt: string;
  control: RunControl;
  verificationCommands?: string[];
  environment?: ExecutionEnvironment;
  verifier?: import('./verification.js').ProgressVerifier;
}

export interface RecordedStep {
  id: string;
  index: number;
  description: string;
  phase: RunStepRecord['phase'];
  status: RunStepRecord['status'];
  toolId?: string;
  startedAt?: number;
  finishedAt?: number;
  detail?: JsonObject;
}

/**
 * Mutable view of one executing run. Every mutation that matters is persisted
 * with an optimistic `stateVersion` check, so a stale worker can never overwrite
 * newer state (spec §82).
 */
export class RunSession {
  run: AgentRun;
  state: AgentState;
  readonly systemPrompt: string;
  readonly control: RunControl;
  readonly verificationCommands: string[];
  readonly verifier?: import('./verification.js').ProgressVerifier;
  readonly environment?: ExecutionEnvironment;
  readonly maxSteps: number;

  committed: JournalEntry[] = [];
  pendingJournal: JournalEntry[] = [];
  lastActions: import('@kazi-ai/agentos-core').AgentAction[] = [];
  /** Fingerprint of the previous decision, used to detect an agent in a loop. */
  lastSignature: string | undefined;
  reflections: JsonObject[] = [];
  recordedSteps: RecordedStep[] = [];
  warned = new Set<string>();
  verification?: { passed: boolean; summary: string };
  stepIndex = 0;
  attempts = 0;
  recoveryAttempts = 0;
  denials = 0;
  stepsSinceCheckpoint = 0;
  events: AgentEvent[] = [];

  constructor(
    input: RunSessionInput,
    private readonly options: RunSessionOptions,
  ) {
    this.run = { ...input.run, usage: { ...input.run.usage } };
    this.state = { ...input.state, usage: { ...input.state.usage } };
    this.systemPrompt = input.systemPrompt;
    this.control = input.control;
    this.verificationCommands = input.verificationCommands ?? [];
    if (input.verifier) this.verifier = input.verifier;
    if (input.environment) this.environment = input.environment;
    this.maxSteps = input.run.limits.maxSteps ?? 100;
    // A run's position in its own history is the number of model calls it has
    // made. Deriving it from durable usage keeps retries of the *same* position
    // idempotent across a crash, while allowing a later identical action (run
    // the tests again after an edit) to have its own identity.
    this.stepIndex = input.run.usage.modelCalls;
  }

  get now(): number {
    return Date.now();
  }

  elapsedMs(): number {
    return this.now - (this.run.startedAt ?? this.run.createdAt);
  }

  budgetSnapshot(): JsonObject {
    const report = this.options.budgets.check(this.run.id, this.run.usage, this.run.limits, this.elapsedMs());
    const snapshot: JsonObject = {};
    for (const status of report.statuses) {
      if (status.limit === undefined) continue;
      snapshot[status.dimension] = Math.max(0, status.limit - status.used);
    }
    return snapshot;
  }

  budgetReport(): ReturnType<BudgetManager['check']> {
    return this.options.budgets.check(this.run.id, this.run.usage, this.run.limits, this.elapsedMs());
  }

  addUsage(patch: Partial<RunUsage>): void {
    this.run.usage = { ...this.run.usage, ...patch };
    this.state.usage = this.run.usage;
  }

  currentStepRef(): { id: string; index: number; description: string; startedAt?: number } | undefined {
    const plan = this.state.plan;
    if (!plan) return undefined;
    const step = plan.steps.find((candidate) => candidate.status === 'pending' || candidate.status === 'running');
    if (!step) return undefined;
    if (step.status === 'pending') {
      step.status = 'running';
      step.startedAt = step.startedAt ?? this.now;
    }
    this.run.currentStepId = step.id;
    this.state.currentStepId = step.id;
    return {
      id: step.id,
      index: step.index,
      description: step.description,
      ...(step.startedAt === undefined ? {} : { startedAt: step.startedAt }),
    };
  }

  markStep(stepId: string, status: 'completed' | 'failed' | 'skipped' | 'pending' | 'running'): void {
    const plan = this.state.plan;
    if (plan) {
      const step = plan.steps.find((candidate) => candidate.id === stepId);
      if (step) {
        step.status = status;
        step.startedAt = step.startedAt ?? this.now;
        if (status === 'completed' || status === 'failed' || status === 'skipped') step.finishedAt = this.now;
      }
    }
    this.stepsSinceCheckpoint += 1;
    if (status === 'completed' || status === 'failed' || status === 'skipped') {
      this.run.currentStepId = undefined;
      this.state.currentStepId = undefined;
    }
  }

  span(name: Parameters<SpanFactory['start']>[0], attributes: Record<string, unknown>): ActiveSpan {
    const factory = this.options.spans;
    if (!factory) return inactiveSpan();
    return factory.start(name, {
      traceId: this.run.traceId,
      runId: this.run.id,
      agentId: this.run.agentId,
      attributes,
    });
  }

  async emit(type: AgentEventType, data: JsonObject): Promise<AgentEvent> {
    const event = await this.options.events.emit({
      type,
      runId: this.run.id,
      organizationId: this.run.organizationId,
      projectId: this.run.projectId,
      traceId: this.run.traceId,
      data,
    });
    this.events.push(event);
    return event;
  }

  async recordStep(step: RecordedStep): Promise<void> {
    const existing = this.recordedSteps.find((candidate) => candidate.id === step.id);
    if (existing) Object.assign(existing, step);
    else this.recordedSteps.push(step);
    await this.options.store.steps.save({ runId: this.run.id, ...step });
  }

  /** Walk the validated transition table to reach `target`, if it is reachable. */
  async advanceTo(target: RunState, reason: string): Promise<void> {
    const path = findPath(this.run.status, target);
    if (path.length === 0) return;
    for (const hop of path) {
      this.run.status = hop.to;
      this.state.status = hop.to;
      await this.emit('state.transitioned', {
        from: hop.from,
        to: hop.to,
        trigger: hop.trigger ?? 'act',
        reason,
      });
    }
    await this.options.store.runs.update(this.run, this.run.stateVersion);
  }

  async persist(): Promise<void> {
    const expected = this.run.stateVersion;
    this.run.stateVersion = expected + 1;
    this.run.updatedAt = this.now;
    this.state.stateVersion = this.run.stateVersion;
    this.state.runId = this.run.id;
    this.state.usage = this.run.usage;
    await this.options.store.runs.update(this.run, expected);
    await this.options.store.counters.saveUsage(this.run.id, this.run.usage);
  }

  async complete(): Promise<void> {
    const plan = this.state.plan;
    if (plan) {
      for (const step of plan.steps) {
        if (step.status === 'pending' || step.status === 'running') step.status = 'skipped';
      }
      this.run.plan = plan;
    }
    this.run.finishedAt = this.now;
    this.run.usage = { ...this.run.usage, durationMs: this.elapsedMs() };
    this.state.usage = this.run.usage;
    await this.advanceTo('COMPLETED', 'objective completed');
    await this.emit('run.completed', {
      durationMs: this.run.usage.durationMs,
      steps: this.run.usage.steps,
      toolCalls: this.run.usage.toolCalls,
      costUsd: this.run.usage.costUsd,
      tokens: this.run.usage.tokens.totalTokens,
      recoveryCount: this.run.usage.recoveryCount,
    });
    await this.persist();
  }

  async finishWith(state: RunState, type: AgentEventType, data: JsonObject, reason: string): Promise<void> {
    this.run.finishedAt = this.now;
    this.run.usage = { ...this.run.usage, durationMs: this.elapsedMs() };
    this.state.usage = this.run.usage;
    await this.advanceTo(state, reason);
    await this.emit(type, data);
    await this.persist();
  }

  result(artifactsInput: { policyViolations: number; artifacts: import('@kazi-ai/agentos-core').ArtifactRef[] }) {
    return toAgentRunResult({
      run: this.run,
      state: this.state,
      policyViolations: artifactsInput.policyViolations,
      artifacts: artifactsInput.artifacts,
      ...(this.verification ? { verification: this.verification } : {}),
    });
  }
}

interface Hop {
  from: RunState;
  to: RunState;
  trigger: ReturnType<typeof triggerFor>;
}

const TRIGGERS = ['queue', 'initialize', 'plan', 'act', 'observe', 'verify', 'recover', 'await_approval', 'pause', 'resume', 'complete', 'fail', 'cancel', 'timeout', 'retry'] as const;

function triggerFor(from: RunState, to: RunState): (typeof TRIGGERS)[number] | undefined {
  for (const trigger of TRIGGERS) {
    if (nextStateFor(from, trigger) === to) return trigger;
  }
  return undefined;
}

/** Breadth-first search over the legal transition table. */
function findPath(from: RunState, to: RunState): Hop[] {
  if (from === to) return [];
  const queue: Array<{ state: RunState; path: Hop[] }> = [{ state: from, path: [] }];
  const seen = new Set<RunState>([from]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const next of allowedTargets(current.state)) {
      if (seen.has(next)) continue;
      const trigger = triggerFor(current.state, next);
      if (!trigger) continue;
      const path = [...current.path, { from: current.state, to: next, trigger }];
      if (next === to) return path;
      seen.add(next);
      queue.push({ state: next, path });
    }
  }
  return [];
}

function inactiveSpan(): ActiveSpan {
  const span = {
    spanId: 'inactive',
    traceId: 'inactive',
    name: 'inactive',
    startedAt: 0,
    status: 'unset' as const,
    attributes: {},
  };
  return {
    span,
    setAttribute: () => {},
    setAttributes: () => {},
    setStatus: () => {},
    end: () => span,
  };
}

export { createEvent, canTransition };
