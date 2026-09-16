import { afterEach, describe, expect, it } from 'vitest';
import {
  MetricsCollector,
  enrichRunResult,
  experimentToJson,
  parseExperiment,
  runExperiment,
  type EvaluatedRunResult,
  type ExperimentDefinition,
  type ExperimentExecutor,
} from '../src/index.js';
import { createHarness, type Harness } from '../../runtime/test/harness.js';

describe('research mode experiments', () => {
  it('validates the experiment definition', () => {
    expect(() => parseExperiment({ name: 'x' })).toThrow();
    const parsed = parseExperiment({
      name: 'memory-on-vs-off',
      goal: 'Fix the failing tests',
      agentId: 'developer',
      variants: [{ name: 'with-memory', variables: { memory: true } }],
    });
    expect(parsed.repetitions).toBe(1);
    expect(parsed.variants).toHaveLength(1);
  });

  it('runs each variant the configured number of times and compares the measurements', async () => {
    const harnesses: Harness[] = [];
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.cleanup();
    });

    // A fresh harness per run: each one has its own scripted provider, so
    // repetitions really repeat the same agent behaviour.
    const factories: Record<string, () => Promise<Harness>> = {
      control: async () => {
        const harness = await createHarness({
          turns: [
            { text: 'writing', costUsd: 0.01, toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
            { text: 'done', costUsd: 0.01 },
          ],
          limits: { maxSteps: 10 },
        });
        harnesses.push(harness);
        return harness;
      },
      treatment: async () => {
        const harness = await createHarness({
          turns: [
            { text: 'writing a', costUsd: 0.01, toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
            { text: 'writing b', costUsd: 0.01, toolCalls: [{ name: 'filesystem.write', arguments: { path: 'b.txt', content: 'b' } }] },
            { text: 'done', costUsd: 0.01 },
          ],
          limits: { maxSteps: 10 },
        });
        harnesses.push(harness);
        return harness;
      },
    };

    const executor: ExperimentExecutor = {
      async run({ variant, repetition }): Promise<EvaluatedRunResult> {
        const factory = factories[variant];
        if (!factory) throw new Error(`no harness for variant ${variant}`);
        const harness = await factory();
        const run = await harness.runtime.createRun(harness.runInput({ goal: `Write files (run ${repetition})` }));
        await harness.runtime.start(run.id);
        const result = await harness.runtime.result(run.id);
        const metrics = await new MetricsCollector(harness.store).collect(run.id);
        return enrichRunResult(result, metrics);
      },
    };

    const experiment: ExperimentDefinition = {
      name: 'one-write-vs-two-writes',
      goal: 'Write files',
      agentId: 'test-agent',
      repetitions: 2,
      variants: [
        { name: 'control', variables: { writes: 1 } },
        { name: 'treatment', variables: { writes: 2 } },
      ],
    };

    const report = await runExperiment({ experiment, executor });

    expect(report.name).toBe('one-write-vs-two-writes');
    expect(report.runs).toHaveLength(4);
    expect(report.variants.map((variant) => variant.variant)).toEqual(['control', 'treatment']);
    expect(report.variants[0]?.runs).toBe(2);
    expect(report.variants[0]?.successRate).toBe(1);
    expect(report.variants[0]?.aggregate.totalToolCalls).toBe(2);
    expect(report.variants[1]?.aggregate.totalToolCalls).toBe(4);
    expect(report.comparisons).toHaveLength(1);
    expect(report.comparisons[0]?.baseline).toBe('control');
    // The treatment did more work, and the report says so from measurements.
    expect(report.comparisons[0]?.stepsDelta).toBeGreaterThan(0);
    // Cost is real accounting, not an estimate: two turns more work costs more.
    expect(report.variants[0]?.averageCostUsd).toBeCloseTo(0.02);
    expect(report.comparisons[0]?.costDeltaUsd).toBeCloseTo(0.01);

    const json = experimentToJson(report);
    expect((json['variants'] as unknown[]).length).toBe(2);
    expect((json['comparisons'] as Array<{ stepsDelta: number }>)[0]?.stepsDelta).toBeGreaterThan(0);
  });
});
