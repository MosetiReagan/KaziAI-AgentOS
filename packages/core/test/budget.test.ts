import { describe, expect, it } from 'vitest';
import { BudgetExceededError, DefaultBudgetManager, emptyUsage, type RunLimits, type RunUsage } from '../src/index.js';

function usage(overrides: Partial<RunUsage> = {}): RunUsage {
  return { ...emptyUsage(), ...overrides };
}

describe('budget manager', () => {
  const manager = new DefaultBudgetManager();

  it('reports unbounded dimensions as unlimited', () => {
    const report = manager.check('run_1', usage({ steps: 3 }), {}, 0);
    const steps = report.statuses.find((item) => item.dimension === 'steps');
    expect(steps).toMatchObject({ limit: undefined, remaining: undefined, exceeded: false });
    expect(report.exceeded).toHaveLength(0);
  });

  it('flags a warning at 80% and exceeds at 100%', () => {
    const limits: RunLimits = { maxSteps: 10 };
    const warning = manager.check('run_1', usage({ steps: 8 }), limits, 0);
    expect(warning.warnings.map((item) => item.dimension)).toContain('steps');
    expect(warning.exceeded).toHaveLength(0);
    const exceeded = manager.check('run_1', usage({ steps: 10 }), limits, 0);
    expect(exceeded.exceeded.map((item) => item.dimension)).toContain('steps');
  });

  it('enforces a hard limit by throwing a classified error', () => {
    const report = manager.check('run_1', usage({ costUsd: 6 }), { maxCostUsd: 5 }, 0);
    expect(() => manager.enforce(report)).toThrow(BudgetExceededError);
    try {
      manager.enforce(report);
    } catch (error) {
      expect((error as BudgetExceededError).details).toMatchObject({ dimension: 'costUsd', limit: 5, actual: 6 });
    }
  });

  it('treats a maxDurationSeconds limit as wall-clock milliseconds', () => {
    const report = manager.check('run_1', usage(), { maxDurationSeconds: 60 }, 61_000);
    expect(report.exceeded[0]?.dimension).toBe('durationMs');
  });

  it('does not fail a run before it uses a zero limit', () => {
    const report = manager.check('run_1', usage(), { maxRecoveryAttempts: 0, maxCostUsd: 0 }, 0);
    expect(report.exceeded).toHaveLength(0);
    const used = manager.check('run_1', usage({ recoveryCount: 1 }), { maxRecoveryAttempts: 0 }, 0);
    expect(used.exceeded[0]?.dimension).toBe('recoveryAttempts');
  });

  it('treats a zero limit as "not permitted"', () => {
    const report = manager.check('run_1', usage({ networkRequests: 1 }), { maxNetworkRequests: 0 }, 0);
    expect(report.exceeded[0]?.dimension).toBe('networkRequests');
  });
});

