import { BudgetExceededError } from './errors.js';
import type { BudgetDimension, BudgetManager, BudgetReport, BudgetStatus } from './contracts/budget.js';
import type { RunLimits, RunUsage } from './contracts/run.js';

const WARNING_RATIO = 0.8;

interface DimensionSpec {
  dimension: BudgetDimension;
  limitOf(limits: RunLimits): number | undefined;
  usedOf(usage: RunUsage, elapsedMs: number): number;
}

const SPECS: DimensionSpec[] = [
  { dimension: 'steps', limitOf: (l) => l.maxSteps, usedOf: (u) => u.steps },
  { dimension: 'toolCalls', limitOf: (l) => l.maxToolCalls, usedOf: (u) => u.toolCalls },
  { dimension: 'tokens', limitOf: (l) => l.maxTokens, usedOf: (u) => u.tokens.totalTokens },
  { dimension: 'costUsd', limitOf: (l) => l.maxCostUsd, usedOf: (u) => u.costUsd },
  {
    dimension: 'durationMs',
    limitOf: (l) => (l.maxDurationSeconds === undefined ? undefined : l.maxDurationSeconds * 1000),
    usedOf: (_u, elapsedMs) => elapsedMs,
  },
  { dimension: 'networkRequests', limitOf: (l) => l.maxNetworkRequests, usedOf: (u) => u.networkRequests },
  { dimension: 'storageBytes', limitOf: (l) => l.maxStorageBytes, usedOf: (u) => u.storageBytes },
  { dimension: 'recoveryAttempts', limitOf: (l) => l.maxRecoveryAttempts, usedOf: (u) => u.recoveryCount },
];

/**
 * Enforces limits independently of the model. A limit of 0 means "not allowed",
 * an undefined limit means "unbounded".
 */
export class DefaultBudgetManager implements BudgetManager {
  constructor(private readonly warningRatio = WARNING_RATIO) {}

  check(runId: string, usage: RunUsage, limits: RunLimits, elapsedMs: number): BudgetReport {
    const statuses: BudgetStatus[] = SPECS.map((spec) => {
      const limit = spec.limitOf(limits);
      const used = spec.usedOf(usage, elapsedMs);
      if (limit === undefined) {
        return { dimension: spec.dimension, limit: undefined, used, remaining: undefined, ratio: 0, exceeded: false, warning: false };
      }
      const ratio = limit <= 0 ? (used > 0 ? 1 : 0) : used / limit;
      // A zero limit means "no allowance", not "failed before starting": a run
      // configured with `maxRecoveryAttempts: 0` may execute, it just may not
      // recover.
      const exceeded = limit <= 0 ? used > 0 : used >= limit;
      return {
        dimension: spec.dimension,
        limit,
        used,
        remaining: Math.max(0, limit - used),
        ratio,
        exceeded,
        warning: ratio >= this.warningRatio && used < limit,
      };
    });
    return {
      runId,
      statuses,
      exceeded: statuses.filter((status) => status.exceeded),
      warnings: statuses.filter((status) => status.warning),
    };
  }

  enforce(report: BudgetReport): void {
    const breach = report.exceeded[0];
    if (!breach) return;
    throw new BudgetExceededError(breach.dimension, breach.limit ?? 0, breach.used);
  }

  /** Pre-flight check: refuse to start work that would immediately exceed a limit. */
  canAfford(report: BudgetReport, dimension: BudgetDimension, amount: number): boolean {
    const status = report.statuses.find((item) => item.dimension === dimension);
    if (!status || status.limit === undefined) return true;
    return status.used + amount <= status.limit;
  }
}

