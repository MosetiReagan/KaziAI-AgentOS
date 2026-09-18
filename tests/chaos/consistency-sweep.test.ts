import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@kazi-ai/agentos';
import { createStore } from '@kazi-ai/agentos-persistence';
import { createAgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NullLogger, type RunLimits } from '@kazi-ai/agentos-core';
import { Chaos, consistencyReport, type ChaosFaultKind } from '../helpers/chaos.js';

/**
 * Spec §88: inject failures *randomly* and measure whether the runtime stays
 * consistent. Every seed drives one real run - real store, real runtime, real
 * policy engine, deterministic provider - through an unpredictable mix of
 * broken tools, broken providers and a broken store, then checks the invariants
 * that must hold no matter which faults fired.
 *
 * The sweep is seeded, so a violation is reproducible from the failure output.
 */

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const FAULT_KINDS: ChaosFaultKind[] = [
  'tool_timeout',
  'tool_error',
  'network_error',
  'invalid_tool_output',
  'provider_timeout',
  'provider_error',
  'invalid_provider_output',
  'store_failure',
];

const noteTool = defineTool({
  id: 'chaos.note',
  description: 'Record a note in the run workspace',
  input: z.object({ text: z.string() }),
  idempotency: 'idempotent',
  risk: 'LOW',
  async execute(input: { text: string }) {
    return { noted: input.text };
  },
});

const LIMITS: RunLimits = {
  maxSteps: 8,
  maxToolCalls: 12,
  maxRecoveryAttempts: 2,
  maxDurationSeconds: 60,
};

function scriptFor(): FakeTurn[] {
  return [
    { text: 'noting one', toolCalls: [{ name: 'chaos.note', arguments: { text: 'one' } }] },
    { text: 'noting two', toolCalls: [{ name: 'chaos.note', arguments: { text: 'two' } }] },
    { text: 'noting three', toolCalls: [{ name: 'chaos.note', arguments: { text: 'three' } }] },
    { text: 'noting four', toolCalls: [{ name: 'chaos.note', arguments: { text: 'four' } }] },
    { text: 'noting five', toolCalls: [{ name: 'chaos.note', arguments: { text: 'five' } }] },
    { text: 'nothing left to do' },
  ];
}

async function runSeed(seed: number) {
  const dir = mkdtempSync(join(tmpdir(), `kazi-sweep-${seed}-`));
  const store = await createStore({ driver: 'memory', dataDir: join(dir, 'store') });
  // Every fault is available, but only some of them fire at each opportunity:
  // `rate` is what makes the mix random rather than a scripted sequence.
  const chaos = new Chaos({
    seed,
    rate: 0.35,
    faults: [
      ...FAULT_KINDS.filter((kind) => kind !== 'store_failure').map((kind) => ({ kind })),
      // A store outage is aimed at the surfaces a *running* run writes, so the
      // run exists and the sweep can judge what the outage did to it.
      { kind: 'store_failure' as const, surface: 'checkpoints' as const, method: 'create' },
      { kind: 'store_failure' as const, surface: 'invocations' as const, method: 'save' },
    ],
  });

  const os = await createAgentOS({
    store: chaos.store(store),
    organizationId: 'org_sweep',
    projectId: 'prj_sweep',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns: scriptFor(), onExhausted: { text: 'nothing left to do' } })],
    logger: new NullLogger(),
    tools: [chaos.tool(noteTool)],
    permissions: {},
    defaultLimits: LIMITS,
    environment: {
      kind: 'local',
      workspaceRoot: join(dir, 'workspaces'),
      snapshotStoreRoot: join(dir, 'snapshots'),
    },
  });

  const agent = os.agent({
    id: 'sweep-agent',
    model: { provider: 'fake', model: 'fake-1' },
    tools: ['chaos.note'],
    planning: false,
    verification: false,
    permissions: {},
    limits: LIMITS,
  });

  try {
    const ran = await agent.run({ goal: 'take three notes' });
    const run = await os.runtime.getRun(ran.runId);
    const journal = await store.actions.list(ran.runId);
    const pending = await store.actions.pending(ran.runId);
    const report = consistencyReport({
      run,
      journal,
      pending,
      events: await store.events.list(ran.runId),
      limits: LIMITS,
    });

    // A second run on the same store proves the first one left no leaked
    // state behind: no stuck lock, no half-written record, no poisoned cache.
    const followUp = await agent.run({ goal: 'take three notes' });
    const followUpRun = await os.runtime.getRun(followUp.runId);
    const health = await store.healthCheck();
    return { report, run, ran, journal, followUpRun, health, chaos };
  } finally {
    await os.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

const injected: ChaosFaultKind[] = [];

describe('a randomly faulted run is still a consistent run', () => {
  it.each(SEEDS)('seed %i leaves a resting, self-consistent run', async (seed) => {
    const { report, run, ran, journal, followUpRun, health, chaos } = await runSeed(seed);
    injected.push(...chaos.fired.map((record) => record.kind));

    // Whatever happened, it stopped. A run that is still EXECUTING after
    // `agent.run()` returned is a run nobody is driving.
    expect(report.terminal || report.status === 'WAITING').toBe(true);

    // The journal and the trace are a record of what happened, not a rumour.
    expect(report.duplicateCommits).toEqual([]);
    expect(report.eventSequencesMonotonic).toBe(true);
    // The run was actually driven by the model, and every tool call it
    // attempted is in the journal *before* anything else could go wrong: the
    // intent record is what a crash needs to reason about (spec §33).
    expect(run.usage.modelCalls).toBeGreaterThan(0);
    if (run.usage.toolCalls > 0) expect(report.journalEntries).toBeGreaterThan(0);
    for (const entry of journal) {
      expect(entry.argumentsHash.length).toBeGreaterThan(0);
      expect(['executing', 'succeeded', 'failed', 'pending', 'denied']).toContain(entry.status);
    }
    // The runtime enforces its own limits regardless of which faults fired.
    expect(report.budgetRespected).toBe(true);
    expect(run.usage.steps).toBeLessThanOrEqual(LIMITS.maxSteps ?? 8);
    expect(run.usage.toolCalls).toBeLessThanOrEqual(LIMITS.maxToolCalls ?? 12);

    // A failure is never anonymous: the run carries a classified error.
    if (report.status === 'FAILED') expect(report.failureCoded).toBe(true);

    // An intent with no commit is the one thing the store can prevent. When the
    // store behaved, nothing may be left half-executed (spec §32, §33).
    const storeFault = chaos.firedOf('store_failure').length > 0;
    if (!storeFault && report.status !== 'WAITING') expect(report.pendingActions).toBe(0);

    if (ran.success) {
      expect(ran.steps).toBeLessThanOrEqual(LIMITS.maxSteps ?? 8);
      expect(run.status).toBe('COMPLETED');
    }

    // The store is still healthy and the next run still reaches a resting
    // state: a faulted run must not take the deployment down with it.
    expect(health.ok).toBe(true);
    expect(followUpRun.id).not.toBe(run.id);
    expect(['COMPLETED', 'FAILED', 'WAITING']).toContain(followUpRun.status);
  }, 120_000);

  it('actually injected faults across the sweep', () => {
    // A chaos suite that injects nothing proves nothing: this is the guard
    // against the injector quietly becoming a no-op.
    expect(new Set(injected).size).toBeGreaterThanOrEqual(4);
    expect(injected.length).toBeGreaterThanOrEqual(SEEDS.length);
  });
});
