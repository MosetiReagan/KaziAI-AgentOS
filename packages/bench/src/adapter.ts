import type { AgentRunResult } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import {
  DEFAULT_SCORE_CONFIG,
  MetricsCollector,
  buildTrajectory,
  enrichRunResult,
  type EvaluatedRunResult,
  type MetricsCollectorStore,
  type ScoreConfig,
} from '@kazi-ai/agentos-evaluation';
import { BENCH_EXPORT_VERSION, type BenchDatasetSummary, type BenchRunExport, type ExpectationResult } from './types.js';

export type BenchAdapterStore = MetricsCollectorStore &
  Parameters<typeof buildTrajectory>[0] &
  Pick<AgentOSStore, 'artifacts'>;

export interface BenchAdapterOptions {
  store: BenchAdapterStore;
  /** Optional scoring configuration; Bench reports whatever the run was scored with. */
  scoreConfig?: ScoreConfig;
  now?: () => number;
}

/**
 * The official KaziAI Bench adapter: turns AgentOS runs into exports Bench can
 * evaluate. Everything it reports is read back from durable records, so an
 * export can be produced by a different process than the one that ran the agent.
 */
export class BenchAdapter {
  private readonly store: BenchAdapterOptions['store'];
  private readonly scoreConfig: ScoreConfig;
  private readonly now: () => number;
  private readonly metrics: MetricsCollector;

  constructor(options: BenchAdapterOptions) {
    this.store = options.store;
    this.scoreConfig = options.scoreConfig ?? DEFAULT_SCORE_CONFIG;
    this.now = options.now ?? (() => Date.now());
    this.metrics = new MetricsCollector(options.store);
  }

  async evaluate(runId: string): Promise<EvaluatedRunResult> {
    const result = await this.resultOf(runId);
    const metrics = await this.metrics.collect(runId);
    return enrichRunResult(result, metrics, this.scoreConfig);
  }

  /**
   * Export one run. `result` may be supplied by the caller (e.g. the runtime's
   * own `result()`), otherwise it is assembled from the store.
   */
  async exportRun(
    runId: string,
    options: { caseId?: string; result?: AgentRunResult; expectations?: ExpectationResult[] } = {},
  ): Promise<BenchRunExport> {
    const evaluated = options.result
      ? enrichRunResult(options.result, await this.metrics.collect(runId), this.scoreConfig)
      : await this.evaluate(runId);
    const trajectory = await buildTrajectory(this.store, runId, { metrics: evaluated.metrics });
    const expectations = options.expectations ?? [];
    const expectationsPassed = expectations.every((expectation) => expectation.passed);

    return {
      version: BENCH_EXPORT_VERSION,
      caseId: options.caseId ?? runId,
      runId,
      agentId: trajectory.agentId,
      goal: trajectory.goal,
      status: trajectory.status,
      success: evaluated.result.success,
      caseSuccess: evaluated.result.success && expectationsPassed,
      expectations,
      result: evaluated.result,
      metrics: evaluated.metrics,
      score: evaluated.score,
      trajectory,
      exportedAt: this.now(),
    };
  }

  async exportRuns(runIds: string[], options: { caseIdForRun?: (runId: string) => string } = {}): Promise<BenchRunExport[]> {
    const exports: BenchRunExport[] = [];
    for (const runId of runIds) {
      const caseId = options.caseIdForRun?.(runId);
      exports.push(await this.exportRun(runId, caseId === undefined ? {} : { caseId }));
    }
    return exports;
  }

  /** Newline-delimited JSON: the interchange format Bench ingests. */
  toJsonl(exports: BenchRunExport[]): string {
    return `${exports.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  }

  static parseJsonl(text: string): BenchRunExport[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed = JSON.parse(line) as BenchRunExport;
        if (parsed.version !== BENCH_EXPORT_VERSION) {
          throw new Error(`Unsupported Bench export version ${String(parsed.version)}; expected ${String(BENCH_EXPORT_VERSION)}`);
        }
        return parsed;
      });
  }

  summarize(exports: BenchRunExport[]): BenchDatasetSummary {
    const runs = exports.length;
    const passed = exports.filter((entry) => entry.caseSuccess).length;
    const sum = (pick: (entry: BenchRunExport) => number): number => exports.reduce((total, entry) => total + pick(entry), 0);
    const verified = exports.filter((entry) => entry.trajectory.verifications.length > 0);
    return {
      cases: new Set(exports.map((entry) => entry.caseId)).size,
      runs,
      passed,
      failed: runs - passed,
      passRate: runs === 0 ? 0 : passed / runs,
      totalCostUsd: sum((entry) => entry.metrics.costUsd),
      totalTokens: sum((entry) => entry.metrics.tokenUsage.totalTokens),
      totalToolCalls: sum((entry) => entry.metrics.toolCalls),
      totalRecoveries: sum((entry) => entry.metrics.recoveryCount),
      averageDurationMs: runs === 0 ? 0 : sum((entry) => entry.metrics.durationMs) / runs,
      averageSteps: runs === 0 ? 0 : sum((entry) => entry.metrics.steps) / runs,
      verificationsRun: verified.length,
      verificationsPassed: verified.filter((entry) => entry.trajectory.verifications.every((verification) => verification.passed)).length,
    };
  }

  private async resultOf(runId: string): Promise<AgentRunResult> {
    const run = await this.store.runs.get(runId);
    if (!run) throw new Error(`Cannot export run ${runId}: it does not exist`);
    const [decisions, artifacts, checkpoints, events] = await Promise.all([
      this.store.policyDecisions.list(runId),
      this.store.artifacts.list(runId),
      this.store.checkpoints.list(runId),
      this.store.events.list(runId),
    ]);
    const verification = [...checkpoints].reverse().find((checkpoint) => checkpoint.contextSnapshot.verification)?.contextSnapshot.verification;
    const fromEvents = lastVerification(events);
    return {
      runId: run.id,
      status: run.status,
      success: run.status === 'COMPLETED',
      durationMs: Math.max(0, (run.finishedAt ?? run.updatedAt) - (run.startedAt ?? run.createdAt)),
      steps: run.usage.steps,
      toolCalls: run.usage.toolCalls,
      tokenUsage: run.usage.tokens,
      costUsd: run.usage.costUsd,
      recoveryCount: run.usage.recoveryCount,
      policyViolations: decisions.filter((decision) => decision.outcome === 'DENY').length,
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.id,
        runId: artifact.runId,
        name: artifact.name,
        sha256: artifact.sha256,
        size: artifact.size,
        mimeType: artifact.mimeType,
        createdAt: artifact.createdAt,
        path: artifact.path,
      })),
      traceId: run.traceId,
      ...(verification ? { verification } : fromEvents === undefined ? {} : { verification: fromEvents }),
    };
  }
}

function lastVerification(
  events: Array<{ type: string; data: Record<string, unknown> }>,
): { passed: boolean; summary: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'verification.completed') continue;
    return {
      passed: event.data['passed'] === true,
      summary: typeof event.data['summary'] === 'string' ? event.data['summary'] : '',
    };
  }
  return undefined;
}
