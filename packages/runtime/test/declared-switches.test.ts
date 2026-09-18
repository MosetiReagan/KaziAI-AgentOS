import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/**
 * `recovery.enabled: false` and `verification.enabled: false` are snapshotted
 * onto the run configuration. Before this they were recorded and then ignored,
 * so an agent that explicitly asked for no recovery still had its run re-planned
 * behind the operator's back (spec §6, §35).
 */
describe('the switches an agent declared', () => {
  it('does not recover when the run says recovery is off', async () => {
    harness = await createHarness({
      turns: [
        { toolCalls: [{ name: 'filesystem.read', arguments: { path: 'missing.txt' } }] },
        { text: 'I could not read the file.' },
      ],
      limits: { maxSteps: 6 },
      runtime: {
        // A run with recovery off still executes; it just reports the failure.
      },
    });

    const run = await harness.runtime.createRun(
      harness.runInput({
        goal: 'Read a file that does not exist',
        config: { ...harness.defaultConfig(), recoveryEnabled: false },
      }),
    );
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.usage.recoveryCount).toBe(0);
    const events = await harness.store.events.list(run.id);
    expect(events.some((event) => event.type === 'recovery.started')).toBe(false);
  });

  it('still recovers when the run says recovery is on', async () => {
    harness = await createHarness({
      turns: [
        { toolCalls: [{ name: 'filesystem.read', arguments: { path: 'missing.txt' } }] },
        { text: 'I could not read the file.' },
      ],
      limits: { maxSteps: 6 },
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Read a missing file' }));
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.usage.recoveryCount).toBeGreaterThan(0);
    const events = await harness.store.events.list(run.id);
    expect(events.some((event) => event.type === 'recovery.started')).toBe(true);
  });

  it('skips the verification phase when the run says verification is off', async () => {
    let verifierCalls = 0;
    harness = await createHarness({
      turns: [{ text: 'Nothing to verify.' }],
      limits: { maxSteps: 4 },
      runtime: {
        verifier: {
          id: 'test-verifier',
          async verify() {
            verifierCalls += 1;
            return { passed: true, summary: 'checked', at: Date.now(), checks: [] };
          },
        },
      },
    });

    const run = await harness.runtime.createRun(
      harness.runInput({
        goal: 'Do nothing at all',
        config: { ...harness.defaultConfig(), verificationEnabled: false },
      }),
    );
    await harness.runtime.start(run.id);

    expect(verifierCalls).toBe(0);
    const events = await harness.store.events.list(run.id);
    expect(events.some((event) => event.type === 'verification.started')).toBe(false);
  });

  it('runs the verifier when the run says verification is on', async () => {
    let verifierCalls = 0;
    harness = await createHarness({
      turns: [{ text: 'Nothing to verify.' }],
      limits: { maxSteps: 4 },
      runtime: {
        verifier: {
          id: 'test-verifier',
          async verify() {
            verifierCalls += 1;
            return { passed: true, summary: 'checked', at: Date.now(), checks: [] };
          },
        },
      },
    });

    const run = await harness.runtime.createRun(
      harness.runInput({
        goal: 'Do nothing at all',
        config: { ...harness.defaultConfig(), verificationEnabled: true },
      }),
    );
    await harness.runtime.start(run.id);

    expect(verifierCalls).toBe(1);
  });
});
