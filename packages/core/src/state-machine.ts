import { InvalidTransitionError, ValidationError } from './errors.js';

export const RUN_STATES = [
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
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_STATES: readonly RunState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

export const STATE_TRIGGERS = [
  'queue',
  'initialize',
  'plan',
  'act',
  'observe',
  'verify',
  'recover',
  'await_approval',
  'pause',
  'resume',
  'complete',
  'fail',
  'cancel',
  'timeout',
  'retry',
] as const;

export type StateTrigger = (typeof STATE_TRIGGERS)[number];

type TransitionTable = { readonly [S in RunState]: readonly RunState[] };

  /**
   * The single source of truth for legal run-state movement. Anything not listed
 * here is rejected; the runtime never mutates state directly.
 */
const TRANSITIONS: TransitionTable = {
  CREATED: ['QUEUED', 'INITIALIZING', 'CANCELLED', 'FAILED'],
  QUEUED: ['INITIALIZING', 'EXECUTING', 'PLANNING', 'PAUSED', 'CANCELLED', 'FAILED', 'TIMED_OUT'],
  INITIALIZING: ['PLANNING', 'EXECUTING', 'WAITING', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  PLANNING: ['EXECUTING', 'OBSERVING', 'WAITING', 'RECOVERING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  EXECUTING: [
    'OBSERVING',
    'PLANNING',
    'VERIFYING',
    'RECOVERING',
    'WAITING',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
  ],
  OBSERVING: ['EXECUTING', 'PLANNING', 'VERIFYING', 'RECOVERING', 'WAITING', 'PAUSED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'COMPLETED'],
  VERIFYING: ['EXECUTING', 'PLANNING', 'RECOVERING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  RECOVERING: ['EXECUTING', 'PLANNING', 'WAITING', 'PAUSED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  WAITING: ['EXECUTING', 'PLANNING', 'RECOVERING', 'PAUSED', 'FAILED', 'CANCELLED', 'TIMED_OUT'],
  PAUSED: ['QUEUED', 'CANCELLED', 'FAILED', 'TIMED_OUT'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELLED: [],
  TIMED_OUT: ['QUEUED'],
};

/**
 * Which trigger may be used to reach a target state from a given source.
 * Some states are reachable through several triggers (e.g. EXECUTING after a
 * plan, after an observation, or after recovery).
 */
const TRIGGER_TARGETS: Record<StateTrigger, readonly RunState[]> = {
  queue: ['QUEUED'],
  initialize: ['INITIALIZING'],
  plan: ['PLANNING'],
  act: ['EXECUTING'],
  observe: ['OBSERVING'],
  verify: ['VERIFYING'],
  recover: ['RECOVERING'],
  await_approval: ['WAITING'],
  pause: ['PAUSED'],
  resume: ['EXECUTING', 'PLANNING', 'QUEUED'],
  complete: ['COMPLETED'],
  fail: ['FAILED'],
  cancel: ['CANCELLED'],
  timeout: ['TIMED_OUT'],
  retry: ['QUEUED'],
};

export function isRunState(value: string): value is RunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalState(state: RunState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isActiveState(state: RunState): boolean {
  return !isTerminalState(state) && state !== 'PAUSED';
}

export function allowedTargets(from: RunState): readonly RunState[] {
  return TRANSITIONS[from];
}

export function allowedTriggers(from: RunState): readonly StateTrigger[] {
  const targets = TRANSITIONS[from];
  return STATE_TRIGGERS.filter((trigger) =>
    TRIGGER_TARGETS[trigger].some((target) => targets.includes(target)),
  );
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStateFor(from: RunState, trigger: StateTrigger): RunState | undefined {
  const targets = TRANSITIONS[from];
  return TRIGGER_TARGETS[trigger].find((target) => targets.includes(target));
}

export interface TransitionRecord {
  from: RunState;
  to: RunState;
  trigger: StateTrigger;
  at: number;
  reason?: string;
}

export interface TransitionOptions {
  reason?: string;
  now?: number;
}

/**
 * Validate and apply a transition. Throws instead of silently accepting an
 * illegal move so corrupted state can never be persisted.
 */
export function transition(
  from: RunState,
  trigger: StateTrigger,
  options: TransitionOptions = {},
): TransitionRecord {
  const to = nextStateFor(from, trigger);
  if (!to) {
    const attempted = TRIGGER_TARGETS[trigger].join('|');
    throw new InvalidTransitionError(from, attempted, trigger);
  }
  return { from, to, trigger, at: options.now ?? Date.now(), ...(options.reason ? { reason: options.reason } : {}) };
}

export function transitionTo(
  from: RunState,
  to: RunState,
  trigger: StateTrigger,
  options: TransitionOptions = {},
): TransitionRecord {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to, trigger);
  if (!TRIGGER_TARGETS[trigger].includes(to)) throw new InvalidTransitionError(from, to, trigger);
  return { from, to, trigger, at: options.now ?? Date.now(), ...(options.reason ? { reason: options.reason } : {}) };
}

export function assertRunState(value: string): RunState {
  if (!isRunState(value)) throw new ValidationError(`Unknown run state: ${value}`);
  return value;
}

/** State machine that carries a version so stale workers cannot overwrite state. */
export class RunStateMachine {
  private currentState: RunState;
  private version: number;
  private readonly history: TransitionRecord[];

  constructor(state: RunState = 'CREATED', version = 0, history: TransitionRecord[] = []) {
    this.currentState = state;
    this.version = version;
    this.history = [...history];
  }

  get state(): RunState {
    return this.currentState;
  }

  get stateVersion(): number {
    return this.version;
  }

  get transitions(): readonly TransitionRecord[] {
    return this.history;
  }

  get terminal(): boolean {
    return isTerminalState(this.currentState);
  }

  canApply(trigger: StateTrigger): boolean {
    return nextStateFor(this.currentState, trigger) !== undefined;
  }

  apply(trigger: StateTrigger, options: TransitionOptions = {}): TransitionRecord {
    if (this.terminal) {
      throw new InvalidTransitionError(this.currentState, trigger, trigger);
    }
    const record = transition(this.currentState, trigger, options);
    this.currentState = record.to;
    this.version += 1;
    this.history.push(record);
    return record;
  }

  /**
   * Apply a transition only when the caller's expected version matches.
   * Returns undefined when the state moved underneath the caller.
   */
  applyIfVersion(expectedVersion: number, trigger: StateTrigger, options: TransitionOptions = {}): TransitionRecord | undefined {
    if (expectedVersion !== this.version) return undefined;
    return this.apply(trigger, options);
  }

  snapshot(): { state: RunState; version: number; history: TransitionRecord[] } {
    return { state: this.currentState, version: this.version, history: [...this.history] };
  }
}
