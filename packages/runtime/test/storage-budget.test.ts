import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('storage budget (spec §25)', () => {
  it('charges the run for the bytes a tool really wrote', async () => {
    harness = await createHarness({
      turns: [
        {
          toolCalls: [
            { name: 'filesystem.write', arguments: { path: 'a.txt', content: 'x'.repeat(50) } },
          ],
        },
        { text: 'Done.' },
      ],
      limits: { maxSteps: 8, maxStorageBytes: 10_000 },
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Write a file' }));
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.usage.storageBytes).toBe(50);
    expect(readFileSync(join(finished.workspaceDir, 'a.txt'), 'utf8').length).toBe(50);
  });

  it('terminates the run when a write pushes it past the byte quota', async () => {
    harness = await createHarness({
      turns: [
        {
          toolCalls: [
            {
              name: 'filesystem.write',
              arguments: { path: 'big.bin', content: 'x'.repeat(4_096) },
            },
          ],
        },
        { text: 'Done.' },
      ],
      limits: { maxSteps: 8, maxStorageBytes: 1_000 },
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Write too much' }));
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.usage.storageBytes).toBe(4_096);

    const failures = await harness.store.failures.list(run.id);
    const breach = failures.find((failure) => failure.code === 'budget.exceeded');
    expect(breach).toBeDefined();
    expect(breach?.message).toContain('storageBytes');
    expect(breach?.category).toBe('budget');

    // The breach is journalled as a real event, not swallowed (spec §104).
    const events = await harness.store.events.list(run.id);
    expect(events.some((event) => event.type === 'budget.exceeded')).toBe(true);
  });

  it('credits freed bytes so shrinking a file restores headroom', async () => {
    harness = await createHarness({
      turns: [
        {
          toolCalls: [
            { name: 'filesystem.write', arguments: { path: 'a.txt', content: 'y'.repeat(900) } },
          ],
        },
        {
          toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'small' } }],
        },
        { text: 'Done.' },
      ],
      limits: { maxSteps: 8, maxStorageBytes: 1_000 },
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Shrink the file' }));
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.usage.storageBytes).toBe(5);
  });
});
