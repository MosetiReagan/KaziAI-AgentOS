import { afterEach, describe, expect, it } from 'vitest';
import { buildTrajectory, MetricsCollector, enrichRunResult, scoreRun, DEFAULT_SCORE_CONFIG } from '../src/index.js';
import { createHarness, type Harness } from '../../runtime/test/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('evaluation trajectory', () => {
  it('describes what happened, in order, from durable records', async () => {
    harness = await createHarness({
      turns: [
        { text: 'listing', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] },
        { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'notes.md', content: 'hi' } }] },
        { text: 'all done' },
      ],
      limits: { maxSteps: 10 },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Write notes.md' }));
    await harness.runtime.start(run.id);

    const result = await harness.runtime.result(run.id);
    const metrics = await new MetricsCollector(harness.store).collect(run.id);
    const trajectory = await buildTrajectory(harness.store, run.id, { metrics, success: result.success });

    expect(trajectory.runId).toBe(run.id);
    expect(trajectory.traceId).toBe(run.traceId);
    expect(trajectory.goal).toBe('Write notes.md');
    expect(trajectory.success).toBe(true);
    expect(trajectory.steps.map((step) => step.index)).toEqual(
      [...trajectory.steps.map((step) => step.index)].sort((left, right) => left - right),
    );
    const kinds = new Set(trajectory.steps.map((step) => step.kind));
    expect(kinds.has('tool')).toBe(true);
    expect(kinds.has('checkpoint')).toBe(true);
    expect(trajectory.toolCalls.map((call) => call.toolId)).toEqual(['filesystem.list', 'filesystem.write']);
    expect(trajectory.toolCalls.every((call) => call.status === 'succeeded')).toBe(true);
    expect(trajectory.toolCalls.every((call) => call.attempts === 1)).toBe(true);
    // No hidden chain-of-thought: only recorded actions and results.
    expect(JSON.stringify(trajectory)).not.toContain('chain_of_thought');
    expect(trajectory.metrics?.toolCalls).toBe(2);
  });

  it('records failures and checkpoints for a run that recovered', async () => {
    harness = await createHarness({
      turns: [
        { text: 'reading a missing file', toolCalls: [{ name: 'filesystem.read', arguments: { path: 'missing.txt' } }] },
        { text: 'creating it first', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'missing.txt', content: 'now it exists' } }] },
        { text: 'done' },
      ],
      limits: { maxSteps: 10 },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Create missing.txt' }));
    await harness.runtime.start(run.id);

    const metrics = await new MetricsCollector(harness.store).collect(run.id);
    const trajectory = await buildTrajectory(harness.store, run.id, { metrics });
    expect(metrics.failureCount).toBeGreaterThan(0);
    expect(trajectory.failures.length).toBeGreaterThan(0);
    expect(trajectory.failures[0]?.code).toBeTruthy();
    expect(trajectory.checkpoints.length).toBeGreaterThan(0);
    expect(trajectory.checkpoints[0]?.sequence).toBeGreaterThan(0);
  });

  it('refuses to build a trajectory for an unknown run', async () => {
    harness = await createHarness();
    await expect(buildTrajectory(harness.store, 'run_missing')).rejects.toThrow(/does not exist/);
  });
});

describe('reliability scoring', () => {
  it('reports every component with its inputs and keeps the aggregate optional', async () => {
    harness = await createHarness({
      turns: [{ text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] }, { text: 'done' }],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const metrics = await new MetricsCollector(harness.store).collect(run.id);

    const report = scoreRun(metrics);
    expect(report.components.map((component) => component.name)).toEqual(['reliability', 'efficiency', 'safety', 'recovery']);
    expect(report.components[0]?.value).toBe(1);
    expect(report.components[0]?.inputs['taskSuccess']).toBe(1);
    expect(report.components[2]?.value).toBe(1);
    expect(report.components[3]?.explanation).toContain('No recovery was needed');
    expect(report.aggregate).toBeGreaterThan(0);
    expect(report.config).toEqual(DEFAULT_SCORE_CONFIG);

    // Scoring is configuration: a zero-weight set has no aggregate at all.
    const weightedAway = scoreRun(metrics, {
      ...DEFAULT_SCORE_CONFIG,
      reliability: { weight: 0, target: 1 },
      efficiency: { weight: 0, target: 1 },
      safety: { weight: 0, target: 1 },
      recovery: { weight: 0, target: 1 },
    });
    expect(weightedAway.aggregate).toBeUndefined();
    expect(weightedAway.components).toHaveLength(4);
  });

  it('enriches the runtime result without replacing it', async () => {
    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const result = await harness.runtime.result(run.id);
    const metrics = await new MetricsCollector(harness.store).collect(run.id);
    const evaluated = enrichRunResult(result, metrics);
    expect(evaluated.result).toBe(result);
    expect(evaluated.metrics.toolCalls).toBe(0);
    expect(evaluated.score.components).toHaveLength(4);
  });
});
