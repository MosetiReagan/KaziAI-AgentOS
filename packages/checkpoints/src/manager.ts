import {
  NotFoundError,
  ValidationError,
  newCheckpointId,
  type AgentAction,
  type AgentRun,
  type AgentRunInput,
  type AgentState,
  type Checkpoint,
  type CheckpointRef,
  type CheckpointStore,
  type EnvironmentSnapshot,
  type JournalEntry,
  type JsonObject,
  type Logger,
  type RiskLevel,
  type SerializedAgentState,
} from '@kazi-ai/agentos-core';
import {
  DEFAULT_CHECKPOINT_POLICY,
  shouldCheckpoint,
  type CheckpointDecision,
  type CheckpointDecisionContext,
  type CheckpointPolicy,
  type CheckpointTrigger,
} from './policy.js';
import { buildContextSnapshot, serializeState, toCheckpointRef } from './serialize.js';

export interface CheckpointEnvironmentCaptureInput {
  run: AgentRun;
  state: AgentState;
}

export interface CheckpointManagerOptions {
  store: CheckpointStore;
  policy?: Partial<CheckpointPolicy>;
  /** Capture an environment snapshot (workspace files, container handle, ...). */
  captureEnvironment?(input: CheckpointEnvironmentCaptureInput): Promise<EnvironmentSnapshot | undefined>;
  /** Restore a previously captured environment snapshot. */
  restoreEnvironment?(snapshot: EnvironmentSnapshot): Promise<void>;
  /** Called after a checkpoint is durably written, used to emit run events. */
  onCreated?(checkpoint: Checkpoint): Promise<void> | void;
  logger?: Logger;
  now?(): number;
}

export interface CreateCheckpointInput {
  run: AgentRun;
  state: AgentState;
  /** Committed journal entries; they prove which actions must never be replayed. */
  committedActions?: JournalEntry[];
  trigger: CheckpointTrigger;
  label?: string;
  risk?: RiskLevel;
  stepsSinceCheckpoint?: number;
  verification?: { passed: boolean; summary: string; at: number };
  pendingAction?: AgentAction;
  /** Skip the environment snapshot for this checkpoint even if the policy enables it. */
  skipEnvironmentSnapshot?: boolean;
}

export interface RestoreResult {
  checkpoint: Checkpoint;
  state: SerializedAgentState;
  environmentRestored: boolean;
}

export interface ForkOptions {
  organizationId?: string;
  projectId?: string;
  goal?: string;
  labels?: Record<string, string>;
  metadata?: JsonObject;
}

export interface ForkPlan {
  checkpoint: Checkpoint;
  input: AgentRunInput;
}

/**
 * Owns the checkpoint lifecycle: when to capture, what to capture, how much to
 * retain, and how to restore or fork from a captured point.
 */
export class CheckpointManager {
  private readonly policy: CheckpointPolicy;
  private readonly store: CheckpointStore;
  private readonly options: CheckpointManagerOptions;
  private readonly now: () => number;

  constructor(options: CheckpointManagerOptions) {
    this.options = options;
    this.store = options.store;
    this.policy = { ...DEFAULT_CHECKPOINT_POLICY, ...options.policy };
    this.now = options.now ?? (() => Date.now());
  }

  checkpointPolicy(): CheckpointPolicy {
    return { ...this.policy };
  }

  /** Pure scheduling decision, exposed for tests and for the CLI `inspect` view. */
  decide(context: CheckpointDecisionContext): CheckpointDecision {
    return shouldCheckpoint(this.policy, context);
  }

  /** Create a checkpoint only if the policy says this trigger warrants one. */
  async maybeCreate(input: CreateCheckpointInput): Promise<Checkpoint | undefined> {
    const last = await this.store.latest(input.run.id);
    const decision = this.decide({
      trigger: input.trigger,
      now: this.now(),
      stepsSinceCheckpoint: input.stepsSinceCheckpoint ?? 0,
      ...(last ? { lastCheckpointAt: last.createdAt } : {}),
      ...(input.risk ? { risk: input.risk } : {}),
      ...(input.label ? { label: input.label } : {}),
    });
    if (!decision.checkpoint) {
      this.options.logger?.debug('checkpoint skipped', {
        runId: input.run.id,
        trigger: input.trigger,
        reason: decision.reason,
      });
      return undefined;
    }
    return this.create(input);
  }

  /** Unconditional checkpoint, used by `kazi-agent checkpoint` and pre-pause saves. */
  async create(input: CreateCheckpointInput): Promise<Checkpoint> {
    const last = await this.store.latest(input.run.id);
    const sequence = (last?.sequence ?? 0) + 1;
    const createdAt = this.now();
    const contextSnapshot = buildContextSnapshot({
      objective: input.run.goal,
      state: input.state,
      ...(input.verification ? { verification: input.verification } : {}),
    });
    const state = serializeState({
      run: input.run,
      state: input.state,
      committedActions: input.committedActions ?? [],
    });

    const environmentSnapshot = await this.captureEnvironment(input);
    const checkpoint: Checkpoint = {
      id: newCheckpointId(createdAt),
      runId: input.run.id,
      sequence,
      state: input.pendingAction ? { ...state, pendingAction: input.pendingAction } : state,
      contextSnapshot,
      ...(environmentSnapshot ? { environmentSnapshot } : {}),
      stateVersion: state.stateVersion,
      ...(input.label ? { label: input.label } : {}),
      createdAt,
    };

    await this.store.save(checkpoint);
    await this.options.onCreated?.(checkpoint);
    await this.prune(input.run.id);
    return checkpoint;
  }

  async latest(runId: string): Promise<Checkpoint | undefined> {
    return this.store.latest(runId);
  }

  async list(runId: string): Promise<Checkpoint[]> {
    const checkpoints = await this.store.list(runId);
    return [...checkpoints].sort((left, right) => left.sequence - right.sequence);
  }

  async get(checkpointId: string): Promise<Checkpoint> {
    const checkpoint = await this.store.get(checkpointId);
    if (!checkpoint) throw new NotFoundError('checkpoint', checkpointId);
    return checkpoint;
  }

  async refs(runId: string): Promise<CheckpointRef[]> {
    return (await this.list(runId)).map(toCheckpointRef);
  }

  /**
   * Restore a checkpoint. The state is returned so the caller can rebuild the
   * run row, and the environment snapshot is restored in place when a restorer
   * is configured.
   */
  async restore(checkpointId: string): Promise<RestoreResult> {
    const checkpoint = await this.get(checkpointId);
    let environmentRestored = false;
    if (checkpoint.environmentSnapshot && this.options.restoreEnvironment) {
      await this.options.restoreEnvironment(checkpoint.environmentSnapshot);
      environmentRestored = true;
    }
    return { checkpoint, state: checkpoint.state, environmentRestored };
  }

  /**
   * Build the input for a brand new run that continues from a checkpoint. The
   * original run is never mutated: forking always creates a separate run.
   */
  async fork(checkpointId: string, options: ForkOptions = {}): Promise<ForkPlan> {
    const checkpoint = await this.get(checkpointId);
    const state = checkpoint.state;
    const organizationId = options.organizationId ?? state.organizationId;
    const projectId = options.projectId ?? state.projectId;
    if (!organizationId || !projectId) {
      throw new ValidationError(
        'Forking requires the organization and project: the checkpoint does not carry them',
        { checkpointId },
      );
    }
    const input: AgentRunInput = {
      goal: options.goal ?? state.goal,
      agentId: state.config.agentId,
      organizationId,
      projectId,
      config: state.config,
      limits: state.config.limits,
      permissions: state.config.permissions,
      parentRunId: state.runId,
      metadata: {
        ...(options.metadata ?? {}),
        forkedFrom: { runId: state.runId, checkpointId: checkpoint.id, sequence: checkpoint.sequence },
      },
      ...(options.labels ? { labels: options.labels } : {}),
    };
    return { checkpoint, input };
  }

  /** Drop checkpoints beyond the retention policy. Labelled ones are protected. */
  async prune(runId: string): Promise<{ removed: string[]; retained: number }> {
    const all = await this.list(runId);
    if (all.length <= this.policy.retain) return { removed: [], retained: all.length };

    const newestFirst = [...all].reverse();
    const keep = new Set<string>();
    for (const checkpoint of newestFirst) {
      if (keep.size >= this.policy.retain) break;
      keep.add(checkpoint.id);
    }
    if (this.policy.retainLabelled) {
      // Labelled checkpoints get their own budget: they mark named milestones
      // (a release, a snapshot a human asked for) and outlive the rolling window.
      let protectedCount = 0;
      for (const checkpoint of newestFirst) {
        if (protectedCount >= this.policy.retain) break;
        if (!checkpoint.label || keep.has(checkpoint.id)) continue;
        keep.add(checkpoint.id);
        protectedCount += 1;
      }
    }

    const removed: string[] = [];
    for (const checkpoint of all) {
      if (keep.has(checkpoint.id)) continue;
      await this.store.delete(checkpoint.id);
      removed.push(checkpoint.id);
    }
    return { removed, retained: keep.size };
  }

  private async captureEnvironment(input: CreateCheckpointInput): Promise<EnvironmentSnapshot | undefined> {
    if (input.skipEnvironmentSnapshot || !this.policy.workspaceSnapshots || !this.options.captureEnvironment) {
      return undefined;
    }
    try {
      return await this.options.captureEnvironment({ run: input.run, state: input.state });
    } catch (error) {
      // Losing an environment snapshot must never cost us the state checkpoint:
      // the run can still resume from durable state, just with a cold workspace.
      this.options.logger?.warn('environment snapshot failed; checkpointing state only', {
        runId: input.run.id,
        error: (error as Error).message,
      });
      return undefined;
    }
  }
}
