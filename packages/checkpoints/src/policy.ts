import type { RiskLevel } from '@kazi-ai/agentos-core';

/** Every point at which the runtime may decide to checkpoint a run (spec §30). */
export type CheckpointTrigger =
  | 'manual'
  | 'run_created'
  | 'after_plan'
  | 'after_tool_call'
  | 'state_change'
  | 'before_risky_action'
  | 'before_recovery'
  | 'before_pause'
  | 'periodic';

export interface CheckpointPolicy {
  afterPlan: boolean;
  afterToolCall: boolean;
  afterStateChange: boolean;
  beforeRiskyAction: boolean;
  beforeRecovery: boolean;
  beforePause: boolean;
  /** Wall-clock interval for periodic checkpoints; 0 or undefined disables it. */
  intervalMs?: number;
  /** Checkpoint every N steps even if nothing else triggers one. */
  everyNSteps?: number;
  /** Risk levels that count as "risky" for `beforeRiskyAction`. */
  riskyRiskLevels: RiskLevel[];
  /** Maximum checkpoints retained per run. */
  retain: number;
  /** Retained checkpoints are never pruned, however old they are. */
  retainLabelled: boolean;
  /** Whether environment snapshots are captured alongside state. */
  workspaceSnapshots: boolean;
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = {
  afterPlan: true,
  afterToolCall: true,
  afterStateChange: false,
  beforeRiskyAction: true,
  beforeRecovery: true,
  beforePause: true,
  intervalMs: 60_000,
  everyNSteps: 10,
  riskyRiskLevels: ['HIGH', 'CRITICAL'],
  retain: 50,
  retainLabelled: true,
  workspaceSnapshots: true,
};

export interface CheckpointDecisionContext {
  trigger: CheckpointTrigger;
  now: number;
  /** Timestamp of the most recent checkpoint for this run, if any. */
  lastCheckpointAt?: number;
  /** Steps executed since the most recent checkpoint. */
  stepsSinceCheckpoint: number;
  risk?: RiskLevel;
  label?: string;
}

export interface CheckpointDecision {
  checkpoint: boolean;
  reason: string;
}

/**
 * Decide whether a trigger should produce a checkpoint. Kept pure so the
 * scheduling policy can be unit tested and tuned without touching the runtime.
 */
export function shouldCheckpoint(
  policy: CheckpointPolicy,
  context: CheckpointDecisionContext,
): CheckpointDecision {
  switch (context.trigger) {
    case 'manual':
      return { checkpoint: true, reason: 'explicitly requested' };
    case 'run_created':
      return { checkpoint: true, reason: 'run created' };
    case 'after_plan':
      return policy.afterPlan
        ? { checkpoint: true, reason: 'plan created' }
        : { checkpoint: false, reason: 'after-plan checkpoints disabled' };
    case 'after_tool_call':
      return policy.afterToolCall
        ? { checkpoint: true, reason: 'tool call completed' }
        : { checkpoint: false, reason: 'after-tool checkpoints disabled' };
    case 'state_change':
      return policy.afterStateChange
        ? { checkpoint: true, reason: 'important state change' }
        : { checkpoint: false, reason: 'state-change checkpoints disabled' };
    case 'before_risky_action': {
      if (!policy.beforeRiskyAction) return { checkpoint: false, reason: 'pre-risk checkpoints disabled' };
      if (context.label !== undefined) return { checkpoint: true, reason: 'labelled action' };
      if (context.risk === undefined) return { checkpoint: false, reason: 'action risk unknown' };
      return policy.riskyRiskLevels.includes(context.risk)
        ? { checkpoint: true, reason: `action risk is ${context.risk}` }
        : { checkpoint: false, reason: `action risk ${context.risk} is below the risky threshold` };
    }
    case 'before_recovery':
      return policy.beforeRecovery
        ? { checkpoint: true, reason: 'recovery is about to run' }
        : { checkpoint: false, reason: 'pre-recovery checkpoints disabled' };
    case 'before_pause':
      return policy.beforePause
        ? { checkpoint: true, reason: 'run is pausing' }
        : { checkpoint: false, reason: 'pre-pause checkpoints disabled' };
    case 'periodic': {
      if (policy.intervalMs !== undefined && policy.intervalMs > 0 && context.lastCheckpointAt !== undefined) {
        if (context.now - context.lastCheckpointAt >= policy.intervalMs) {
          return { checkpoint: true, reason: `checkpoint interval of ${policy.intervalMs}ms elapsed` };
        }
      }
      if (policy.everyNSteps !== undefined && policy.everyNSteps > 0 && context.stepsSinceCheckpoint >= policy.everyNSteps) {
        return { checkpoint: true, reason: `${context.stepsSinceCheckpoint} steps since the last checkpoint` };
      }
      return { checkpoint: false, reason: 'periodic checkpoint not due' };
    }
    default: {
      const exhaustive: never = context.trigger;
      return { checkpoint: false, reason: `unknown trigger ${String(exhaustive)}` };
    }
  }
}
