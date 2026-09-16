import { z } from 'zod';
import type { JsonObject, JsonValue } from '@kazi-ai/agentos-core';
import { aggregateMetrics, type AggregateMetrics, type RunMetrics } from './metrics.js';
import type { EvaluatedRunResult } from './result.js';

export const experimentSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** The task every variant runs, so results stay comparable. */
    goal: z.string().min(1),
    agentId: z.string().min(1),
    /** What each variant changes about the runtime/agent configuration. */
    variants: z
      .array(
        z
          .object({
            name: z.string().min(1),
            variables: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
          })
          .strict(),
      )
      .min(1),
    /** Repetitions per variant: a single run is an anecdote, not a result. */
    repetitions: z.number().int().positive().default(1),
  })
  .strict();

export type ExperimentDefinition = z.input<typeof experimentSchema>;
export type ParsedExperiment = z.output<typeof experimentSchema>;

export function parseExperiment(input: unknown): ParsedExperiment {
  return experimentSchema.parse(input);
}

/** What the caller must be able to do for an experiment to run. */
export interface ExperimentExecutor {
  /** Runs one variant and returns the measured result of that run. */
  run(input: {
    goal: string;
    agentId: string;
    variables: Record<string, JsonValue>;
    variant: string;
    repetition: number;
  }): Promise<EvaluatedRunResult>;
}

export interface VariantRun {
  variant: string;
  repetition: number;
  evaluated: EvaluatedRunResult;
}

export interface VariantReport {
  variant: string;
  variables: Record<string, JsonValue>;
  runs: number;
  aggregate: AggregateMetrics;
  successRate: number;
  averageCostUsd: number;
  averageSteps: number;
  averageDurationMs: number;
  recoveryCount: number;
  policyViolations: number;
  averageReliabilityScore: number;
}

export interface ExperimentReport {
  name: string;
  goal: string;
  agentId: string;
  repetitions: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  variants: VariantReport[];
  /** Per-variant deltas against the first variant, which acts as the baseline. */
  comparisons: Array<{
    variant: string;
    baseline: string;
    successRateDelta: number;
    costDeltaUsd: number;
    stepsDelta: number;
    durationDeltaMs: number;
    recoveryDelta: number;
    reliabilityScoreDelta: number;
  }>;
  runs: VariantRun[];
}

/**
 * Runs the same task under several configurations and reports the differences.
 * This is the research mode from spec §91–92: nothing is inferred from a single
 * run, and every number is measured from the durable records of the runs.
 */
export async function runExperiment(options: {
  experiment: ExperimentDefinition;
  executor: ExperimentExecutor;
  now?: () => number;
}): Promise<ExperimentReport> {
  const experiment = parseExperiment(options.experiment);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const runs: VariantRun[] = [];

  for (const variant of experiment.variants) {
    for (let repetition = 0; repetition < experiment.repetitions; repetition += 1) {
      const evaluated = await options.executor.run({
        goal: experiment.goal,
        agentId: experiment.agentId,
        variables: variant.variables as Record<string, JsonValue>,
        variant: variant.name,
        repetition,
      });
      runs.push({ variant: variant.name, repetition, evaluated });
    }
  }

  const finishedAt = now();
  const variants = experiment.variants.map((variant) => {
    const variantRuns = runs.filter((run) => run.variant === variant.name);
    const metrics = variantRuns.map((run) => run.evaluated.metrics);
    const aggregate = aggregateMetrics(metrics);
    const scores = variantRuns.map((run) => run.evaluated.score.aggregate ?? 0);
    return {
      variant: variant.name,
      variables: variant.variables as Record<string, JsonValue>,
      runs: variantRuns.length,
      aggregate,
      successRate: aggregate.successRate,
      averageCostUsd: aggregate.averageCostUsd,
      averageSteps: aggregate.averageSteps,
      averageDurationMs: aggregate.averageDurationMs,
      recoveryCount: aggregate.totalRecoveries,
      policyViolations: aggregate.totalPolicyViolations,
      averageReliabilityScore: scores.length === 0 ? 0 : scores.reduce((total, value) => total + value, 0) / scores.length,
    };
  });

  const baseline = variants[0];
  return {
    name: experiment.name,
    goal: experiment.goal,
    agentId: experiment.agentId,
    repetitions: experiment.repetitions,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    variants,
    comparisons:
      baseline === undefined
        ? []
        : variants.slice(1).map((variant) => ({
            variant: variant.variant,
            baseline: baseline.variant,
            successRateDelta: variant.successRate - baseline.successRate,
            costDeltaUsd: variant.averageCostUsd - baseline.averageCostUsd,
            stepsDelta: variant.averageSteps - baseline.averageSteps,
            durationDeltaMs: variant.averageDurationMs - baseline.averageDurationMs,
            recoveryDelta: variant.recoveryCount - baseline.recoveryCount,
            reliabilityScoreDelta: variant.averageReliabilityScore - baseline.averageReliabilityScore,
          })),
    runs,
  };
}

/** Machine-readable export for KaziAI Bench and research notebooks. */
export function experimentToJson(report: ExperimentReport): JsonObject {
  return JSON.parse(JSON.stringify(report)) as JsonObject;
}

export function compareMetrics(left: RunMetrics, right: RunMetrics): JsonObject {
  return {
    runId: { left: left.runId, right: right.runId },
    steps: { left: left.steps, right: right.steps, delta: right.steps - left.steps },
    toolCalls: { left: left.toolCalls, right: right.toolCalls, delta: right.toolCalls - left.toolCalls },
    costUsd: { left: left.costUsd, right: right.costUsd, delta: right.costUsd - left.costUsd },
    durationMs: { left: left.durationMs, right: right.durationMs, delta: right.durationMs - left.durationMs },
    recoveryCount: { left: left.recoveryCount, right: right.recoveryCount, delta: right.recoveryCount - left.recoveryCount },
    success: { left: left.taskSuccess, right: right.taskSuccess },
  };
}
