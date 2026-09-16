import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResourceExhaustedError } from '@kazi-ai/agentos-core';
import { policyRule } from '@kazi-ai/agentos-policies';
import { DefaultPolicyEngine } from '@kazi-ai/agentos-policies';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('run control', () => {
  it('pauses a running agent, checkpoints it, and resumes it to completion', async () => {
    harness = await createHarness({
      turns: [
        { text: 'slow think', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }], delayMs: 80 },
        { text: 'second', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'b.txt', content: 'b' } }], delayMs: 40 },
        { text: 'finished' },
      ],
    });
    const run = await harness.runtime.createRun(harness.runInput());

    const running = harness.runtime.start(run.id);
    await sleep(20);
    await harness.runtime.pause(run.id);
    await running;

    const paused = await harness.runtime.getRun(run.id);
    expect(paused.status).toBe('PAUSED');
    // A pause is durable: there is a checkpoint an operator could inspect.
    const checkpoints = await harness.runtime.checkpoints.list(run.id);
    expect(checkpoints.length).toBeGreaterThan(0);

    await harness.runtime.resume(run.id);
    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    const dir = finished.workspaceDir;
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
  });

  it('cancels a run in flight and stops calling tools', async () => {
    harness = await createHarness({
      turns: [
        { text: 'starting', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] },
        { text: 'slow', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'never.txt', content: 'x' } }], delayMs: 5_000 },
      ],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    const running = harness.runtime.start(run.id);
    await sleep(60);
    await harness.runtime.cancel(run.id);
    await running;

    const cancelled = await harness.runtime.getRun(run.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(existsSync(join(cancelled.workspaceDir, 'never.txt'))).toBe(false);
    const events = await harness.store.events.list(run.id);
    expect(events.map((event) => event.type)).toContain('run.cancelled');
  });

  it('cancels a run that has not started yet', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }] });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.cancel(run.id);
    expect((await harness.runtime.getRun(run.id)).status).toBe('CANCELLED');
    await expect(harness.runtime.start(run.id)).resolves.toBeUndefined();
  });

  it('refuses to start a paused run so a worker cannot double-run it', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }] });
    const run = await harness.runtime.createRun(harness.runInput());

    // No worker is attached, so the operator pauses it through durable state.
    await harness.runtime.pause(run.id);
    expect((await harness.runtime.getRun(run.id)).status).toBe('PAUSED');
    await expect(harness.runtime.start(run.id)).rejects.toThrow(/paused/i);

    // Resuming picks the work back up.
    await harness.runtime.resume(run.id);
    expect((await harness.runtime.getRun(run.id)).status).toBe('COMPLETED');
  });
});

describe('budgets are enforced independently of the model', () => {
  it('stops a productive run at its step budget instead of running forever', async () => {
    // Each turn does different work, so nothing else would stop this run.
    const turns = Array.from({ length: 12 }, (_unused, index) => ({
      text: `writing file ${index}`,
      toolCalls: [{ name: 'filesystem.write', arguments: { path: `f${index}.txt`, content: String(index) } }],
    }));
    harness = await createHarness({ turns, limits: { maxSteps: 10 } });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error?.['code']).toBe('budget.exceeded');
    expect(finished.usage.steps).toBe(10);
    const events = await harness.store.events.list(run.id);
    expect(events.map((event) => event.type)).toContain('budget.exceeded');
    expect(events.map((event) => event.type)).toContain('budget.warning');
  });

  it('stops an agent that repeats an identical action without making progress', async () => {
    harness = await createHarness({
      turns: [{ text: 'again', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] }],
      onExhausted: 'repeat-last',
      limits: { maxSteps: 40 },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error?.['code']).toBe('run.no_progress');
    expect(finished.usage.modelCalls).toBeLessThan(6);
  });

  it('terminates on the cost budget using provider-reported cost', async () => {
    harness = await createHarness({
      turns: [
        { text: 'one', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }], costUsd: 0.04 },
        { text: 'two', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }], costUsd: 0.04 },
        { text: 'three', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }], costUsd: 0.04 },
      ],
      limits: { maxCostUsd: 0.05, maxSteps: 50 },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.usage.costUsd).toBeGreaterThanOrEqual(0.08);
    expect(finished.usage.modelCalls).toBeLessThanOrEqual(2);
  });

  it('times a run out on its duration budget', async () => {
    harness = await createHarness({
      turns: [{ text: 'slow', delayMs: 1_500, toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] }],
      limits: { maxDurationSeconds: 0.2, maxSteps: 50 },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('TIMED_OUT');
    const events = await harness.store.events.list(run.id);
    expect(events.map((event) => event.type)).toContain('run.timed_out');
  });

  it('refuses new work when backpressure limits are exhausted', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }], runtime: { backpressure: { maxConcurrentRuns: 1 } } });
    harness.runtime.backpressure.reserve();
    await expect(harness.runtime.createRun(harness.runInput())).rejects.toBeInstanceOf(ResourceExhaustedError);
    harness.runtime.backpressure.release();
    await expect(harness.runtime.createRun(harness.runInput())).resolves.toBeDefined();
  });
});

describe('policy and approval gates', () => {
  it('parks on an approval gate, then executes the approved action after resume', async () => {
    harness = await createHarness({
      turns: [
        { text: 'deleting', toolCalls: [{ name: 'filesystem.delete', arguments: { path: 'obsolete.txt' } }] },
        { text: 'deleting (resumed)', toolCalls: [{ name: 'filesystem.delete', arguments: { path: 'obsolete.txt' } }] },
        { text: 'The obsolete file is gone.' },
      ],
      permissions: { filesystem: { read: true, write: true, delete: true }, terminal: { execute: true }, network: { enabled: false } },
      tools: ['filesystem.read', 'filesystem.write', 'filesystem.list', 'filesystem.delete'],
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Remove obsolete.txt' }));
    writeFileSync(join(run.workspaceDir, 'obsolete.txt'), 'obsolete');
    await harness.runtime.start(run.id);

    const waiting = await harness.runtime.getRun(run.id);
    expect(waiting.status).toBe('WAITING');
    const pending = await harness.runtime.pendingApprovals('org_test');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolId).toBe('filesystem.delete');
    expect(pending[0]?.risk).toBe('HIGH');
    // Nothing ran while the run was waiting.
    expect(existsSync(join(waiting.workspaceDir, 'obsolete.txt'))).toBe(true);

    await harness.runtime.decideApproval({
      approvalId: pending[0]!.id,
      decision: 'approve',
      decidedBy: 'operator@kazi',
    });
    await harness.runtime.resume(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    expect(existsSync(join(finished.workspaceDir, 'obsolete.txt'))).toBe(false);
    // The decision is durable, not an in-memory flag.
    const approvals = await harness.store.approvals.list({ runId: run.id });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('granted');
    expect(approvals[0]?.decidedBy).toBe('operator@kazi');
    const audit = await harness.store.policyDecisions.list(run.id);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('does not execute a denied action', async () => {
    harness = await createHarness({
      turns: [
        { text: 'deleting', toolCalls: [{ name: 'filesystem.delete', arguments: { path: 'keep.txt' } }] },
        { text: 'I will leave it alone.' },
      ],
      permissions: { filesystem: { read: true, write: true, delete: true } },
      tools: ['filesystem.read', 'filesystem.delete'],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    writeFileSync(join(run.workspaceDir, 'keep.txt'), 'keep');
    await harness.runtime.start(run.id);
    const pending = await harness.runtime.pendingApprovals('org_test');
    await harness.runtime.decideApproval({ approvalId: pending[0]!.id, decision: 'deny', decidedBy: 'operator', reason: 'no' });
    await harness.runtime.resume(run.id);

    expect(existsSync(join(run.workspaceDir, 'keep.txt'))).toBe(true);
    const approvals = await harness.store.approvals.list({ runId: run.id });
    expect(approvals[0]?.status).toBe('denied');
    expect(approvals[0]?.decisionReason).toBe('no');
  });

  it('fails the run when the agent repeatedly attempts denied actions', async () => {
    harness = await createHarness({
      turns: [{ text: 'reading everything', toolCalls: [{ name: 'filesystem.read', arguments: { path: 'secret.txt' } }] }],
      onExhausted: 'repeat-last',
      permissions: { filesystem: { read: false } },
      tools: ['filesystem.read'],
      runtime: {
        policies: new DefaultPolicyEngine({
          rules: [
            policyRule({
              id: 'deny.reads',
              description: 'reads are denied in this environment',
              tools: ['filesystem.*'],
              outcome: 'DENY',
              reason: 'filesystem access is disabled',
            }),
          ],
        }),
      },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error?.['code']).toBe('policy.repeated_denials');
    const events = await harness.store.events.list(run.id);
    const denied = events.filter((event) => event.type === 'tool.denied');
    expect(denied.length).toBe(3);
  });
});
