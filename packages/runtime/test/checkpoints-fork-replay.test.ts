import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';
import { waitFor } from './helpers.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

const THREE_STEPS = [
  { text: 'step one', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'one.txt', content: '1' } }] },
  { text: 'step two', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'two.txt', content: '2' } }] },
  { text: 'all done' },
];

describe('checkpoints', () => {
  it('captures state, plan, context and environment, and can restore them', async () => {
    harness = await createHarness({ turns: THREE_STEPS });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const checkpoints = await harness.runtime.checkpoints.list(run.id);
    expect(checkpoints.length).toBeGreaterThan(0);
    const latest = await harness.runtime.checkpoints.latest(run.id);
    expect(latest?.runId).toBe(run.id);
    expect(latest?.state.status).toBeDefined();
    expect(latest?.contextSnapshot.objective).toBe(run.goal);
    expect(latest?.environmentSnapshot).toBeDefined();
    expect(latest?.sequence).toBeGreaterThan(0);

    // A manual checkpoint is a first-class operator action.
    const manual = await harness.runtime.checkpoint(run.id);
    expect(manual.sequence).toBeGreaterThan(latest!.sequence);
  });

  it('restores durable run state from a checkpoint instead of the live process', async () => {
    harness = await createHarness({
      turns: [
        { text: 'first', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'one.txt', content: '1' } }], delayMs: 50 },
        { text: 'second', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }], delayMs: 50 },
        { text: 'done' },
      ],
      limits: { maxSteps: 20 },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    const running = harness.runtime.start(run.id);
    await waitFor(() => existsSync(join(run.workspaceDir, 'one.txt')));
    await harness.runtime.pause(run.id);
    await running;
    expect((await harness.runtime.getRun(run.id)).status).toBe('PAUSED');

    const checkpoints = await harness.runtime.checkpoints.list(run.id);
    const target = checkpoints[0]!;
    await harness.runtime.restore(run.id, target.id);

    const restored = await harness.runtime.getRun(run.id);
    expect(restored.status).toBe('QUEUED');
    const state = await harness.runtime.getState(run.id);
    // The restored state is the checkpoint's, not whatever the run ended with.
    expect(state.observations.length).toBe(target.state.observations.length);
    expect(state.stateVersion).toBe(target.state.stateVersion);

    // A restored run can be picked up again.
    await harness.runtime.cancel(run.id);
    expect((await harness.runtime.getRun(run.id)).status).toBe('CANCELLED');
  });

  it('refuses to restore a checkpoint that belongs to another run', async () => {
    harness = await createHarness({ turns: THREE_STEPS });
    const first = await harness.runtime.createRun(harness.runInput({ agentId: 'a' }));
    await harness.runtime.start(first.id);
    const other = await harness.runtime.createRun(harness.runInput({ agentId: 'b' }));
    const checkpoints = await harness.runtime.checkpoints.list(first.id);
    await expect(harness.runtime.restore(other.id, checkpoints[0]!.id)).rejects.toThrow(/belongs to run/);
  });
});

describe('forking', () => {
  it('forks a run from a checkpoint without mutating the original', async () => {
    harness = await createHarness({
      turns: [...THREE_STEPS, { text: 'fork: continue', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'fork.txt', content: 'f' } }] }, { text: 'fork done' }],
    });
    const original = await harness.runtime.createRun(harness.runInput({ goal: 'Original objective' }));
    await harness.runtime.start(original.id);
    const checkpoints = await harness.runtime.checkpoints.list(original.id);
    const checkpoint = checkpoints[0]!;

    const fork = await harness.runtime.fork(original.id, {
      checkpointId: checkpoint.id,
      goal: 'Forked objective',
      labels: { experiment: 'no-memory' },
    });
    expect(fork.id).not.toBe(original.id);
    expect(fork.parentRunId).toBe(original.id);
    expect(fork.rootRunId).toBe(original.rootRunId);
    expect(fork.goal).toBe('Forked objective');
    expect(fork.labels?.['experiment']).toBe('no-memory');
    // The fork gets its own workspace, seeded from the checkpoint snapshot.
    expect(fork.workspaceDir).not.toBe(original.workspaceDir);
    expect(existsSync(join(fork.workspaceDir, 'one.txt'))).toBe(true);

    await harness.runtime.start(fork.id);
    expect((await harness.runtime.getRun(fork.id)).status).toBe('COMPLETED');
    expect((await harness.runtime.getRun(original.id)).status).toBe('COMPLETED');
    // The original's own workspace was never touched by the fork.
    expect(existsSync(join(original.workspaceDir, 'fork.txt'))).toBe(false);
    expect(readFileSync(join(original.workspaceDir, 'one.txt'), 'utf8')).toBe('1');

    const children = await harness.runtime.listRuns({ parentRunId: original.id });
    expect(children.map((child) => child.id)).toEqual([fork.id]);
  });
});

describe('replay', () => {
  it('reports what happened without pretending the model is deterministic', async () => {
    harness = await createHarness({ turns: THREE_STEPS });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const report = await harness.runtime.replay(run.id, { mode: 'trace' });
    expect(report.runId).toBe(run.id);
    expect(report.mode).toBe('trace');
    expect(report.summary['toolCalls']).toBe(2);
    // Trace replay reconstructs history; it never claims the model is repeatable.
    expect(report.deterministic).toBe(false);
    expect(String(report.summary['note'])).toMatch(/does not re-run the model/i);
  });

  it('re-executes only read-only tools in simulate mode', async () => {
    harness = await createHarness({ turns: THREE_STEPS });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const before = readFileSync(join(run.workspaceDir, 'one.txt'), 'utf8');

    const report = await harness.runtime.replay(run.id, { mode: 'simulate' });
    expect(report.mode).toBe('simulate');
    // Writes were not repeated; the workspace is untouched.
    expect(readFileSync(join(run.workspaceDir, 'one.txt'), 'utf8')).toBe(before);
    expect(report.actions.every((action) => action.status === 'skipped')).toBe(true);
    expect(report.skipped).toBe(2);
    expect(String(report.summary['note'])).toMatch(/read-only/i);
  });

  it('re-runs recorded tools in deterministic mode and reports real drift', async () => {
    harness = await createHarness({
      turns: [
        { text: 'write then read', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'note.txt', content: 'hello' } }] },
        { text: 'read it back', toolCalls: [{ name: 'filesystem.read', arguments: { path: 'note.txt' } }] },
        { text: 'done' },
      ],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const report = await harness.runtime.replay(run.id, { mode: 'deterministic' });
    expect(report.mode).toBe('deterministic');
    expect(report.actions.map((action) => action.toolId)).toEqual(['filesystem.write', 'filesystem.read']);

    const read = report.actions.find((action) => action.toolId === 'filesystem.read');
    expect(read?.status).toBe('matched');
    // The write is now a no-op (the file already exists), which the replay
    // reports as drift rather than pretending the run is reproducible.
    const write = report.actions.find((action) => action.toolId === 'filesystem.write');
    expect(write?.status).toBe('diverged');
    expect(write?.note).toMatch(/differs/);
  });

  it('replays the recorded action sequence deterministically in deterministic mode', async () => {
    harness = await createHarness({ turns: THREE_STEPS });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const first = await harness.runtime.replay(run.id, { mode: 'deterministic' });
    const second = await harness.runtime.replay(run.id, { mode: 'deterministic' });
    expect(first.actions.map((action) => action.toolId)).toEqual(second.actions.map((action) => action.toolId));
    expect(first.actions.map((action) => action.actionId)).toEqual(second.actions.map((action) => action.actionId));
    expect(first.matched).toBe(second.matched);
  });
});
