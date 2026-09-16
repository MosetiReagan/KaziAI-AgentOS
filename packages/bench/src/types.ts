import { z } from 'zod';
import type { AgentRunResult, JsonValue } from '@kazi-ai/agentos-core';
import type { ReliabilityReport, RunMetrics, RunTrajectory } from '@kazi-ai/agentos-evaluation';

/** Schema version of the export format. Bench rejects versions it cannot read. */
export const BENCH_EXPORT_VERSION = 1;

export const benchCaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    goal: z.string().min(1),
    agentId: z.string().min(1),
    tags: z.array(z.string()).default([]),
    /** Tool ids the case expects the agent to have, for launchers that build the run config. */
    tools: z.array(z.string()).default([]),
    limits: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
    permissions: z.record(z.string(), z.unknown()).default({}),
    /** Files placed in the run workspace before the agent starts. */
    setup: z
      .object({ files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]) })
      .default({ files: [] }),
    /** How the case decides whether the agent really solved the task. */
    expectations: z
      .object({
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              exists: z.boolean().optional(),
              contains: z.string().optional(),
              absent: z.boolean().optional(),
            }),
          )
          .default([]),
        /** `required` fails the case when no verification passed. */
        verification: z.enum(['required', 'optional', 'forbidden']).default('optional'),
      })
      .default({ files: [], verification: 'optional' }),
  })
  .strict();

export type BenchCaseInput = z.input<typeof benchCaseSchema>;
export type BenchCase = z.output<typeof benchCaseSchema>;

export function parseBenchCase(input: unknown): BenchCase {
  return benchCaseSchema.parse(input);
}

export interface ExpectationResult {
  name: string;
  passed: boolean;
  detail: string;
}

/**
 * One measured agent run, in the shape KaziAI Bench consumes: the run result,
 * the full trajectory, the metrics and how the case's expectations were graded.
 */
export interface BenchRunExport {
  version: number;
  caseId: string;
  runId: string;
  agentId: string;
  goal: string;
  status: string;
  success: boolean;
  /** True only when the run succeeded *and* every expectation passed. */
  caseSuccess: boolean;
  expectations: ExpectationResult[];
  result: AgentRunResult;
  metrics: RunMetrics;
  score: ReliabilityReport;
  trajectory: RunTrajectory;
  exportedAt: number;
  labels?: Record<string, string>;
  metadata?: JsonValue;
}

export interface BenchDatasetSummary {
  cases: number;
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  totalCostUsd: number;
  totalTokens: number;
  totalToolCalls: number;
  totalRecoveries: number;
  averageDurationMs: number;
  averageSteps: number;
  verificationsRun: number;
  verificationsPassed: number;
}
