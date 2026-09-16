import type { AgentRunResult } from '@kazi-ai/agentos-core';
import type { RunMetrics } from './metrics.js';
import { DEFAULT_SCORE_CONFIG, scoreRun, type ReliabilityReport, type ScoreConfig } from './scoring.js';

/**
 * The runtime already produces the standard `AgentRunResult` (spec §58) from
 * durable records. Evaluation adds the deeper instrumentation around it without
 * inventing a second result shape, so Bench and the dashboard read one contract.
 */
export interface EvaluatedRunResult {
  result: AgentRunResult;
  metrics: RunMetrics;
  score: ReliabilityReport;
}

export function enrichRunResult(
  result: AgentRunResult,
  metrics: RunMetrics,
  config: ScoreConfig = DEFAULT_SCORE_CONFIG,
): EvaluatedRunResult {
  return { result, metrics, score: scoreRun(metrics, config) };
}

/**
 * A run counts as a success only when it completed *and* verification, when one
 * ran, passed. Callers that need a stricter judgement (e.g. a task-level
 * evaluator) should apply it on top of this, never instead of it.
 */
export function verifiedSuccess(result: AgentRunResult): boolean {
  if (!result.success) return false;
  if (result.verification === undefined) return true;
  return result.verification.passed;
}
