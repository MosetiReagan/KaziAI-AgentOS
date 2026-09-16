import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  RunStateMachine,
  allowedTargets,
  canTransition,
  isTerminalState,
  nextStateFor,
  transition,
  transitionTo,
} from '../src/index.js';

describe('run state machine', () => {
  it('follows the documented happy path', () => {
    const machine = new RunStateMachine();
    expect(machine.state).toBe('CREATED');
    machine.apply('queue');
    machine.apply('initialize');
    machine.apply('plan');
    machine.apply('act');
    machine.apply('observe');
    machine.apply('verify');
    machine.apply('complete');
    expect(machine.state).toBe('COMPLETED');
    expect(machine.terminal).toBe(true);
    expect(machine.stateVersion).toBe(7);
  });

  it('supports the recovery loop EXECUTING -> RECOVERING -> EXECUTING', () => {
    const machine = new RunStateMachine('EXECUTING');
    machine.apply('recover');
    expect(machine.state).toBe('RECOVERING');
    machine.apply('act');
    expect(machine.state).toBe('EXECUTING');
  });

  it('rejects illegal transitions instead of silently ignoring them', () => {
    const machine = new RunStateMachine('CREATED');
    expect(() => machine.apply('complete')).toThrow(InvalidTransitionError);
    expect(machine.state).toBe('CREATED');
    expect(machine.stateVersion).toBe(0);
  });

  it('refuses to leave a terminal state', () => {
    const machine = new RunStateMachine('COMPLETED');
    expect(() => machine.apply('act')).toThrow(InvalidTransitionError);
  });

  it('allows retry only from FAILED and TIMED_OUT', () => {
    expect(nextStateFor('FAILED', 'retry')).toBe('QUEUED');
    expect(nextStateFor('TIMED_OUT', 'retry')).toBe('QUEUED');
    expect(nextStateFor('COMPLETED', 'retry')).toBeUndefined();
    expect(nextStateFor('CANCELLED', 'retry')).toBeUndefined();
  });

  it('does not allow PAUSED to terminate without explicit cancel', () => {
    expect(canTransition('PAUSED', 'FAILED')).toBe(true);
    expect(canTransition('PAUSED', 'COMPLETED')).toBe(false);
    expect(nextStateFor('PAUSED', 'resume')).toBe('QUEUED');
  });

  it('re-queues a resumed run so a stateless worker can pick it up', () => {
    const machine = new RunStateMachine('PAUSED');
    machine.apply('resume');
    expect(machine.state).toBe('QUEUED');
    // A resumed run continues rather than re-initializing its workspace.
    machine.apply('act');
    expect(machine.state).toBe('EXECUTING');
  });

  it('resumes a waiting run straight back into execution', () => {
    const machine = new RunStateMachine('WAITING');
    machine.apply('resume');
    expect(machine.state).toBe('EXECUTING');
  });

  it('guards against stale writers through optimistic version checks', () => {
    const machine = new RunStateMachine('EXECUTING', 5);
    expect(machine.applyIfVersion(4, 'observe')).toBeUndefined();
    const record = machine.applyIfVersion(5, 'observe');
    expect(record?.to).toBe('OBSERVING');
    expect(machine.stateVersion).toBe(6);
  });

  it('records an ordered history of transitions', () => {
    const machine = new RunStateMachine();
    machine.apply('queue', { now: 1 });
    machine.apply('initialize', { now: 2 });
    expect(machine.transitions.map((item) => [item.from, item.to])).toEqual([
      ['CREATED', 'QUEUED'],
      ['QUEUED', 'INITIALIZING'],
    ]);
  });

  it('exposes the reachable target set for every state', () => {
    for (const state of ['CREATED', 'QUEUED', 'EXECUTING', 'WAITING'] as const) {
      expect(allowedTargets(state).length).toBeGreaterThan(0);
    }
    expect(allowedTargets('COMPLETED')).toHaveLength(0);
  });

  it('creates transition records through the pure helpers', () => {
    const record = transition('PLANNING', 'act', { reason: 'plan ready', now: 42 });
    expect(record).toMatchObject({ from: 'PLANNING', to: 'EXECUTING', reason: 'plan ready', at: 42 });
    expect(() => transition('COMPLETED', 'act')).toThrow(InvalidTransitionError);
    expect(transitionTo('WAITING', 'EXECUTING', 'resume').to).toBe('EXECUTING');
  });

  it('treats all four end states as terminal', () => {
    expect(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].every((state) => isTerminalState(state as never))).toBe(true);
    expect(isTerminalState('WAITING')).toBe(false);
  });
});
