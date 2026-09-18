import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { startWorkerChild } from '../helpers/worker-process.js';

const ORG = 'org_e2e';
const PRJ = 'prj_e2e';

let dataDir: string | undefined;
let os: AgentOS | undefined;

afterEach(async () => {
  await os?.close().catch(() => undefined);
  os = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function openAgentOS(dir: string, turns: FakeTurn[] = []): Promise<AgentOS> {
  return createAgentOS({
    dataDir: dir,
    organizationId: ORG,
    projectId: PRJ,
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
    environment: {
      kind: 'local',
      workspaceRoot: `${dir}/workspaces`,
      snapshotStoreRoot: `${dir}/snapshots`,
    },
  });
}

/**
 * The mandatory crash test (spec §114): a worker is killed outright partway
 * through a run, a *different* worker process picks the run up, and the run
 * finishes correctly with the state the first worker had already committed.
 */
describe('a worker dies mid-run and another one finishes the job', () => {
  it('resumes from the last checkpoint instead of restarting the work', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'kazi-crash-'));
    const turns: FakeTurn[] = [
      { text: 'writing one', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'one.txt', content: '1' } }] },
      { text: 'writing two', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'two.txt', content: '2' } }] },
      { text: 'writing three', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'three.txt', content: '3' } }] },
      // The kill happens while the model is 'thinking' about step four, which
      // is the cleanest moment to prove resumption: nothing is half-executed.
      {
        text: 'thinking about four',
        delayMs: 15_000,
        toolCalls: [{ name: 'filesystem.write', arguments: { path: 'four.txt', content: '4' } }],
      },
      { text: 'all four written' },
    ];

    // A separate process creates and registers the work; only the durable store
    // carries over to the worker.
    const creator = await openAgentOS(dataDir, turns);
    const agent = creator.agent({
      id: 'crash-agent',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['filesystem', 'terminal'],
      planning: false,
      verification: false,
      permissions: {
        filesystem: { read: true, write: true, delete: false },
        terminal: { execute: true, allowUnisolated: true },
      },
    });
    // Registered durably and left CREATED: the worker claims it from the store.
    const created = await agent.createRun({
      goal: 'Write four files, one step at a time.',
      limits: { maxSteps: 20 },
    });
    expect(created.status).toBe('CREATED');
    await creator.close();

    // ── first worker: killed while the run is in flight ──────────────────
    const first = startWorkerChild({ dataDir, runId: created.id, turns, workerId: 'first' });
    await first.waitFor((event) => event.event === 'ready');
    const inFlight = await first.waitFor(
      (event) => event.event === 'status' && (event.checkpoints ?? 0) >= 3,
    );
    expect(inFlight.steps).toBeGreaterThanOrEqual(3);
    expect(inFlight.status).toBe('EXECUTING');
    first.kill();
    await first.stopped;

    // ── what the crash left behind ───────────────────────────────────────
    os = await openAgentOS(dataDir);
    const crashed = await os.runtime.getRun(created.id);
    expect(crashed.status).not.toBe('COMPLETED');
    const checkpointsBefore = await os.store.checkpoints.list(created.id);
    expect(checkpointsBefore.length).toBeGreaterThanOrEqual(3);
    // The plan-less run has no RunStepRecord (there is no plan step to record),
    // so the checkpoints and the journal are the evidence of progress.
    const actionsBefore = await os.store.actions.list(created.id);
    expect(actionsBefore.some((action) => action.status === 'succeeded')).toBe(true);

    const workspaceDir = crashed.workspaceDir;
    expect(existsSync(join(workspaceDir, 'three.txt'))).toBe(true);
    await os.close();
    os = undefined;

    // ── second worker: a different process, same durable store ───────────
    const second = startWorkerChild({
      dataDir,
      runId: created.id,
      turns,
      // The first worker is gone, so its claim is stale almost immediately.
      staleClaimMs: 200,
      workerId: 'second',
    });
    await second.waitFor((event) => event.event === 'ready');
    const finished = await second.waitFor((event) => event.event === 'finished', 120_000);
    expect(finished.status).toBe('COMPLETED');
    await second.stopped;

    // ── the result is correct and continuous ─────────────────────────────
    os = await openAgentOS(dataDir);
    const done = await os.runtime.getRun(created.id);
    expect(done.status).toBe('COMPLETED');
    for (const file of ['one.txt', 'two.txt', 'three.txt', 'four.txt']) {
      expect(existsSync(join(workspaceDir, file)), file).toBe(true);
    }
    expect(readFileSync(join(workspaceDir, 'four.txt'), 'utf8')).toBe('4');

    // The checkpoints written before the crash are still there: the second
    // worker continued the run rather than starting a new one.
    const checkpointsAfter = await os.store.checkpoints.list(created.id);
    expect(checkpointsAfter.length).toBeGreaterThanOrEqual(checkpointsBefore.length);
    expect(checkpointsAfter.some((checkpoint) => checkpoint.sequence === 1)).toBe(true);

    const result = await os.runtime.result(created.id);
    expect(result.success).toBe(true);
    expect(result.runId).toBe(created.id);
  }, 180_000);
});
