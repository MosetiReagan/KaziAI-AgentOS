import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../../runtime/test/harness.js';
import { MetricsCollector, aggregateMetrics, classifyOutcome } from '../src/index.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('run metrics from durable records', () => {
  it('measures a completed run without trusting the agent', async () => {
    harness = await createHarness({
      turns: [
        { text: 'listing', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] },
        { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
        { text: 'finished' },
      ],
      limits: { maxSteps: 10 },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Write a.txt' }));
    await harness.runtime.start(run.id);

    const metrics = await new MetricsCollector(harness.store).collect(run.id);
    expect(metrics.status).toBe('COMPLETED');
    expect(metrics.outcome).toBe('succeeded');
    expect(metrics.taskSuccess).toBe(true);
    expect(metrics.toolCalls).toBe(2);
    expect(metrics.failedToolCalls).toBe(0);
    expect(metrics.steps).toBeGreaterThanOrEqual(3);
    expect(metrics.modelCalls).toBeGreaterThanOrEqual(3);
    expect(metrics.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(metrics.tokenUsage.inputTokens).toBe(metrics.usage.tokens.inputTokens);
    expect(metrics.costUsd).toBeGreaterThanOrEqual(0);
    expect(metrics.checkpointCount).toBeGreaterThan(0);
    expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.startedAt).toBeDefined();
    expect(metrics.finishedAt).toBeDefined();
  });

  it('counts failures, recoveries and approvals as they happen', async () => {
    harness = await createHarness({
      turns: [
        { text: 'deleting', toolCalls: [{ name: 'filesystem.delete', arguments: { path: 'gone.txt' } }] },
        { text: 'deleting (resumed)', toolCalls: [{ name: 'filesystem.delete', arguments: { path: 'gone.txt' } }] },
        { text: 'done' },
      ],
      tools: ['filesystem.read', 'filesystem.write', 'filesystem.list', 'filesystem.delete'],
      permissions: { filesystem: { read: true, write: true, delete: true } },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Delete gone.txt' }));
    await harness.runtime.start(run.id);

    const pending = await harness.runtime.pendingApprovals('org_test');
    const beforeApproval = await new MetricsCollector(harness.store).collect(run.id);
    expect(beforeApproval.awaitingApprovalCalls).toBe(1);
    expect(beforeApproval.humanApprovals).toBe(0);
    expect(beforeApproval.interruptions).toBeGreaterThan(0);

    await harness.runtime.decideApproval({ approvalId: pending[0]!.id, decision: 'approve', decidedBy: 'operator' });
    await harness.runtime.resume(run.id);

    const after = await new MetricsCollector(harness.store).collect(run.id);
    expect(after.humanApprovals).toBe(1);
    expect(after.approvalsDenied).toBe(0);
    expect(after.toolCalls).toBeGreaterThanOrEqual(1);
  });

  it('reports policy violations from the audit trail', async () => {
    harness = await createHarness({
      turns: [{ text: 'reading', toolCalls: [{ name: 'filesystem.read', arguments: { path: 'secret.txt' } }] }],
      onExhausted: 'repeat-last',
      tools: ['filesystem.read'],
      permissions: { filesystem: { read: false } },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const metrics = await new MetricsCollector(harness.store).collect(run.id);
    expect(metrics.status).toBe('FAILED');
    expect(metrics.outcome).toBe('failed');
    expect(metrics.taskSuccess).toBe(false);
    // The denial came from the permission set rather than a policy rule, and is
    // reported as such instead of being silently folded into policy violations.
    expect(metrics.permissionDenials).toBeGreaterThan(0);
    expect(metrics.policyViolations).toBe(0);
  });

  it('refuses to invent metrics for a run that does not exist', async () => {
    harness = await createHarness();
    await expect(new MetricsCollector(harness.store).collect('run_missing')).rejects.toThrow(/does not exist/);
    const empty = await new MetricsCollector(harness.store, { onMissingRun: 'empty' }).collect('run_missing');
    expect(empty.toolCalls).toBe(0);
    expect(empty.outcome).toBe('incomplete');
  });
});

describe('aggregate metrics', () => {
  it('summarises a set of runs', () => {
    const base = {
      runId: 'run',
      organizationId: 'org',
      projectId: 'prj',
      agentId: 'agent',
      status: 'COMPLETED',
      outcome: 'succeeded' as const,
      taskSuccess: true,
      durationMs: 100,
      steps: 4,
      modelCalls: 3,
      toolCalls: 2,
      failedToolCalls: 0,
      deniedToolCalls: 0,
      awaitingApprovalCalls: 0,
      replayedToolCalls: 0,
      recoveryCount: 0,
      recoverySuccesses: 0,
      recoveryFailureCount: 0,
      policyViolations: 0,
      permissionDenials: 0,
      humanApprovals: 0,
      approvalsDenied: 0,
      checkpointCount: 1,
      failureCount: 0,
      terminalFailureCount: 0,
      interruptions: 0,
      tokenUsage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0, totalTokens: 15 },
      costUsd: 0.01,
      modelTransitions: 0,
      usage: {
        steps: 4,
        toolCalls: 2,
        tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        costUsd: 0.01,
        networkRequests: 0,
        storageBytes: 0,
        durationMs: 100,
        recoveryCount: 0,
        checkpointCount: 1,
        modelCalls: 3,
      },
    };
    const aggregate = aggregateMetrics([
      { ...base, runId: 'a' },
      { ...base, runId: 'b', outcome: 'failed', taskSuccess: false, durationMs: 200, steps: 6, costUsd: 0.03 },
    ]);
    expect(aggregate.runs).toBe(2);
    expect(aggregate.succeeded).toBe(1);
    expect(aggregate.failed).toBe(1);
    expect(aggregate.successRate).toBe(0.5);
    expect(aggregate.totalSteps).toBe(10);
    expect(aggregate.averageDurationMs).toBe(150);
    expect(aggregate.totalCostUsd).toBeCloseTo(0.04);
  });

  it('classifies terminal states', () => {
    expect(classifyOutcome('COMPLETED')).toBe('succeeded');
    expect(classifyOutcome('FAILED')).toBe('failed');
    expect(classifyOutcome('CANCELLED')).toBe('cancelled');
    expect(classifyOutcome('TIMED_OUT')).toBe('timed_out');
    expect(classifyOutcome('PAUSED')).toBe('incomplete');
  });
});
