import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createStore, type AgentOSStore } from '@kazi-ai/agentos-persistence';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { StoreRunQueue } from '@kazi-ai/agentos-worker';
import { Chaos, consistencyReport } from '../helpers/chaos.js';

/**
 * Spec §88: a database that stops answering must not corrupt a run or strand
 * it. The runtime cannot make durable progress while the store is down, so the
 * contract is narrower and more important: stop cleanly, keep the journal
 * consistent, and let a healthy worker resume the run afterwards.
 */

const WRITE_THEN_FINISH: FakeTurn[] = [
  { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
  { text: 'finished' },
];

let os: AgentOS | undefined;
let store: AgentOSStore | undefined;
let dir: string | undefined;

afterEach(async () => {
  await os?.close().catch(() => undefined);
  os = undefined;
  await store?.close().catch(() => undefined);
  store = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function build(chaos: Chaos): Promise<{ os: AgentOS; agent: ReturnType<AgentOS['agent']> }> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-chaos-store-'));
  store = await createStore({ driver: 'memory', dataDir: join(dir, 'store') });
  os = await createAgentOS({
    store: chaos.store(store),
    organizationId: 'org_chaos',
    projectId: 'prj_chaos',
    providersFromEnv: false,
    providers: [
      new FakeModelProvider({
        turns: JSON.parse(JSON.stringify(WRITE_THEN_FINISH)) as FakeTurn[],
        onExhausted: { text: 'done' },
      }),
    ],
    logger: new NullLogger(),
    environment: {
      kind: 'local',
      workspaceRoot: join(dir, 'workspaces'),
      snapshotStoreRoot: join(dir, 'snapshots'),
    },
  });
  const agent = os.agent({
    id: 'chaos-agent',
    model: { provider: 'fake', model: 'fake-1' },
    tools: ['filesystem'],
    planning: false,
    verification: false,
    permissions: { filesystem: { read: true, write: true, delete: false } },
  });
  return { os, agent };
}

describe('the durable store goes away mid-run', () => {
  it('stops the run without corrupting its journal, and a later worker finishes it', async () => {
    const chaos = new Chaos({ seed: 41, faults: [{ kind: 'store_failure', surface: 'states', times: 1, skip: 1 }] });
    const { os: runtimeOs, agent } = await build(chaos);

    const run = await agent.createRun({ goal: 'write a file' });
    // The run cannot even reach its first state write, so starting it fails.
    await expect(runtimeOs.runtime.start(run.id)).rejects.toThrow(/injected storage outage/);
    expect(chaos.firedOf('store_failure')).toHaveLength(1);

    // Whatever was persisted is still readable and internally consistent.
    const journal = await store!.actions.list(run.id);
    const events = await store!.events.list(run.id);
    const stuck = await store!.runs.get(run.id);
    const report = consistencyReport({ run: stuck!, journal, pending: await store!.actions.pending(run.id), events });
    expect(report.duplicateCommits).toEqual([]);
    expect(report.eventSequencesMonotonic).toBe(true);
    expect(report.terminal).toBe(false);

    // The run is not stranded: the durable queue still considers it claimable
    // and asks for a resume rather than a restart (spec §31, §114).
    const queue = new StoreRunQueue({ store: store!, workerId: 'recovery-worker' });
    const claimable = await queue.claim();
    expect(claimable).toBeDefined();
    expect(claimable?.action).toBe('resume');
  });

  it('resumes the run once the store answers again', async () => {
    const chaos = new Chaos({ seed: 42, faults: [{ kind: 'store_failure', surface: 'states', times: 1, skip: 1 }] });
    const { os: runtimeOs, agent } = await build(chaos);

    const run = await agent.createRun({ goal: 'write a file' });
    await expect(runtimeOs.runtime.start(run.id)).rejects.toThrow(/injected storage outage/);

    // The fault is spent, so this is an ordinary worker resuming the run.
    await runtimeOs.runtime.resume(run.id);

    const finished = await runtimeOs.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');

    const result = await runtimeOs.runtime.result(run.id);
    expect(result.success).toBe(true);
    expect(result.steps).toBeGreaterThan(0);

    const report = consistencyReport({
      run: finished,
      journal: await store!.actions.list(run.id),
      pending: await store!.actions.pending(run.id),
      events: await store!.events.list(run.id),
    });
    expect(report.duplicateCommits).toEqual([]);
    expect(report.pendingActions).toBe(0);
    expect(report.eventSequencesMonotonic).toBe(true);
  });

  it('never loses the record of an action because the invocation log failed', async () => {
    const chaos = new Chaos({ seed: 43, faults: [{ kind: 'store_failure', surface: 'invocations', times: 1 }] });
    const { os: runtimeOs, agent } = await build(chaos);

    const run = await agent.createRun({ goal: 'write a file' });
    await runtimeOs.runtime.start(run.id);

    const finished = await runtimeOs.runtime.getRun(run.id);
    const journal = await store!.actions.list(run.id);
    // The write is committed in the journal even though the invocation log
    // rejected: the journal is the source of truth (spec §33).
    expect(journal.some((entry) => entry.status === 'succeeded')).toBe(true);
    expect(['COMPLETED', 'FAILED']).toContain(finished.status);
    if (finished.status === 'FAILED') {
      expect(finished.error).toBeDefined();
    }
  });
});
