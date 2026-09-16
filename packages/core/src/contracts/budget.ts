import type { RunLimits, RunUsage } from './run.js';

export type BudgetDimension =
  | 'steps'
  | 'toolCalls'
  | 'tokens'
  | 'costUsd'
  | 'durationMs'
  | 'networkRequests'
  | 'storageBytes'
  | 'recoveryAttempts';

export interface BudgetStatus {
  dimension: BudgetDimension;
  limit: number | undefined;
  used: number;
  remaining: number | undefined;
  /** Fraction of the budget consumed, 0..1. */
  ratio: number;
  exceeded: boolean;
  warning: boolean;
}

export interface BudgetReport {
  runId: string;
  statuses: BudgetStatus[];
  exceeded: BudgetStatus[];
  warnings: BudgetStatus[];
}

export interface BudgetManager {
  check(runId: string, usage: RunUsage, limits: RunLimits, elapsedMs: number): BudgetReport;
  /** Throws BudgetExceededError when a hard limit is reached. */
  enforce(report: BudgetReport): void;
}

