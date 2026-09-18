import type { AgentRun, RunLimits } from '../api/types.js';
import { formatCost, formatDuration, formatTokens } from './format.js';

export interface BudgetLine {
  key: keyof RunLimits;
  label: string;
  used: number;
  limit?: number;
  /** 0 when a limit exists and nothing was used; undefined when unlimited. */
  ratio?: number;
  display: string;
  remaining: string;
  tone: 'neutral' | 'warn' | 'danger';
}

const WARN_RATIO = 0.75;

function toneFor(ratio: number | undefined): BudgetLine['tone'] {
  if (ratio === undefined) return 'neutral';
  if (ratio >= 1) return 'danger';
  if (ratio >= WARN_RATIO) return 'warn';
  return 'neutral';
}

/**
 * Budgets are enforced by the runtime, not by the dashboard; this only makes
 * the remaining allowance legible while a run is still going (spec §25, §53).
 */
export function budgetLines(run: Pick<AgentRun, 'limits' | 'usage'>): BudgetLine[] {
  const { limits, usage } = run;
  const ratio = (used: number, limit: number | undefined): number | undefined =>
    limit === undefined || limit <= 0 ? undefined : used / limit;

  const lines: BudgetLine[] = [
    {
      key: 'maxSteps',
      label: 'Steps',
      used: usage.steps,
      ...(limits.maxSteps === undefined ? {} : { limit: limits.maxSteps }),
      ratio: ratio(usage.steps, limits.maxSteps),
      display: `${usage.steps}${limits.maxSteps === undefined ? '' : ` / ${limits.maxSteps}`}`,
      remaining:
        limits.maxSteps === undefined
          ? 'unlimited'
          : `${Math.max(0, limits.maxSteps - usage.steps)} left`,
      tone: toneFor(ratio(usage.steps, limits.maxSteps)),
    },
    {
      key: 'maxToolCalls',
      label: 'Tool calls',
      used: usage.toolCalls,
      ...(limits.maxToolCalls === undefined ? {} : { limit: limits.maxToolCalls }),
      ratio: ratio(usage.toolCalls, limits.maxToolCalls),
      display: `${usage.toolCalls}${limits.maxToolCalls === undefined ? '' : ` / ${limits.maxToolCalls}`}`,
      remaining:
        limits.maxToolCalls === undefined
          ? 'unlimited'
          : `${Math.max(0, limits.maxToolCalls - usage.toolCalls)} left`,
      tone: toneFor(ratio(usage.toolCalls, limits.maxToolCalls)),
    },
    {
      key: 'maxTokens',
      label: 'Tokens',
      used: usage.tokens.totalTokens,
      ...(limits.maxTokens === undefined ? {} : { limit: limits.maxTokens }),
      ratio: ratio(usage.tokens.totalTokens, limits.maxTokens),
      display: `${formatTokens(usage.tokens.totalTokens)}${limits.maxTokens === undefined ? '' : ` / ${formatTokens(limits.maxTokens)}`}`,
      remaining:
        limits.maxTokens === undefined
          ? 'unlimited'
          : `${formatTokens(Math.max(0, limits.maxTokens - usage.tokens.totalTokens))} left`,
      tone: toneFor(ratio(usage.tokens.totalTokens, limits.maxTokens)),
    },
    {
      key: 'maxCostUsd',
      label: 'Cost',
      used: usage.costUsd,
      ...(limits.maxCostUsd === undefined ? {} : { limit: limits.maxCostUsd }),
      ratio: ratio(usage.costUsd, limits.maxCostUsd),
      display: `${formatCost(usage.costUsd)}${limits.maxCostUsd === undefined ? '' : ` / ${formatCost(limits.maxCostUsd)}`}`,
      remaining:
        limits.maxCostUsd === undefined
          ? 'unlimited'
          : `${formatCost(Math.max(0, limits.maxCostUsd - usage.costUsd))} left`,
      tone: toneFor(ratio(usage.costUsd, limits.maxCostUsd)),
    },
    {
      key: 'maxDurationSeconds',
      label: 'Duration',
      used: usage.durationMs,
      ...(limits.maxDurationSeconds === undefined ? {} : { limit: limits.maxDurationSeconds }),
      ratio: ratio(usage.durationMs / 1_000, limits.maxDurationSeconds),
      display: `${formatDuration(usage.durationMs)}${
        limits.maxDurationSeconds === undefined ? '' : ` / ${formatDuration(limits.maxDurationSeconds * 1_000)}`
      }`,
      remaining:
        limits.maxDurationSeconds === undefined
          ? 'unlimited'
          : `${formatDuration(Math.max(0, limits.maxDurationSeconds * 1_000 - usage.durationMs))} left`,
      tone: toneFor(ratio(usage.durationMs / 1_000, limits.maxDurationSeconds)),
    },
  ];
  return lines;
}
