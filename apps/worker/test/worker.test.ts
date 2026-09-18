import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { AgentWorker } from '../src/worker.js';
import { StoreRunQueue, claimOf } from '../src/queue.js';
import { bullMqJobId, bullMqJobOptions } from '../src/bullmq.js';

let os: AgentOS | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (os) await os.close().catch(() => undefined);
  os = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const TURNS: FakeTurn[] = [
  { text: JSON.stringify({ objective: 'Write result.txt', steps: [{ description: 'write it' }] }) },
  {
    text: 'writing',
    toolCalls: [{ name: 'filesystem.write', arguments: { path: 'result.txt', content: 'hi' } }],
  },
  { text: 'done' },
];

async function build(
  turns: FakeTurn[] = TURNS,
  options: { extraTools?: Parameters<typeof createAgentOS>[0]['tools']; withModel?: boolean } = {},
): Promise<AgentOS> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-worker-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    providers:
      options.withModel === false
        ? []
        : [new FakeModelProvider({ turns, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
    ...(options.extraTools ? { tools: options.extraTools } : {}),
  });
  return os;
}

/** Declare (and register) the agent a test is about to run. */
async function developerAgent(agentos: AgentOS, tools: string[] = ['filesystem']) {
  return agentos.agent({
    id: 'developer',
    model: { provider: 'fake', model: 'fake-1' },
    tools,
    // These tests run commands as host processes. Saying so explicitly is the
    // same statement a production agent definition has to make (spec §15).
    permissions: {
      filesystem: { read: true, write: true, delete: true },
      terminal: { execute: true, allowUnisolated: true },
      network: { enabled: false },
    },
  });
}

describe('durable run queue', () => {
  it('claims a queued run exactly once', async () => {
    const agentos = await build();
    const run = await (
      await developerAgent(agentos)
    ).createRun({ goal: 'queued work' });

    const first = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a' });
    const second = new StoreRunQueue({ store: agentos.store, workerId: 'worker-b' });

    const claimed = await first.claim();
    expect(claimed?.runId).toBe(run.id);
    expect(claimed?.action).toBe('start');
    expect(claimed?.attempt).toBe(1);

    // The second worker must not be able to take the same run.
    expect(await second.claim()).toBeUndefined();

    // The claim is durable on the run itself.
    const stored = await agentos.store.runs.get(run.id);
    expect(claimOf(stored!)).toMatchObject({ workerId: 'worker-a', attempt: 1 });
  });

  it('resumes a run a dead worker left mid-execution instead of starting it over', async () => {
    const agentos = await build();
    const run = await (await developerAgent(agentos)).createRun({ goal: 'interrupted' });

    // Exactly the state a SIGKILL leaves behind: the run was executing when
    // its worker vanished (spec §114).
    await agentos.store.runs.update({ ...run, status: 'EXECUTING' }, run.stateVersion);

    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-b' });
    const claimed = await queue.claim();
    expect(claimed?.runId).toBe(run.id);
    // `start` would reject a run in an in-flight state; the queue has to ask
    // the runtime to resume so the committed state is reloaded.
    expect(claimed?.action).toBe('resume');
  });

  it('hands an abandoned claim back after a worker disappears', async () => {
    const agentos = await build();
    await (await developerAgent(agentos)).createRun({ goal: 'abandoned' });

    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a', now: () => 1_000 });
    await queue.claim();

    // A survivor sweeps after the stale window.
    const survivor = new StoreRunQueue({ store: agentos.store, workerId: 'worker-b', now: () => 500_000 });
    const released = await survivor.reclaimStale({ olderThanMs: 10_000 });
    expect(released).toHaveLength(1);

    const claimed = await survivor.claim();
    expect(claimed?.runId).toBe(released[0]);
    expect(claimed?.attempt).toBe(2);
  });

  it('reports its depth and can be released', async () => {
    const agentos = await build();
    const agent = await developerAgent(agentos);
    await agent.createRun({ goal: 'one' });
    await agent.createRun({ goal: 'two' });

    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a' });
    expect(await queue.depth()).toBe(2);
    const claimed = await queue.claim();
    await queue.release(claimed!);
    expect(claimOf((await agentos.store.runs.get(claimed!.runId))!)).toMatchObject({ workerId: 'queue' });
    expect(await queue.claim()).toBeDefined();
  });
});

describe('AgentWorker', () => {
  it('claims queued runs and executes them to completion', async () => {
    const agentos = await build();
    await (await developerAgent(agentos)).createRun({ goal: 'execute me' });
    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a' });
    const worker = new AgentWorker({ os: agentos, queue, logger: new NullLogger(), pollIntervalMs: 5 });

    expect(await worker.tick()).toBe(1);
    await worker.drain();

    const run = (await agentos.store.runs.list({})).items[0];
    expect(run?.status).toBe('COMPLETED');
    expect(worker.statsSnapshot()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    // Nothing left to do.
    expect(await worker.tick()).toBe(0);
  });

  it('runs queued work in the background once started', async () => {
    const agentos = await build();
    await (await developerAgent(agentos)).createRun({ goal: 'background' });
    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a' });
    const worker = new AgentWorker({ os: agentos, queue, logger: new NullLogger(), pollIntervalMs: 2 });
    worker.start();
    try {
      await waitFor(async () => (await agentos.store.runs.list({})).items[0]?.status === 'COMPLETED');
      expect(worker.statsSnapshot().completed).toBe(1);
    } finally {
      await worker.stop({ timeoutMs: 1_000 });
    }
    expect(worker.isRunning).toBe(false);
  });

  it('checkpoints and pauses an active run on shutdown', async () => {
    const agentos = await build([
      { text: JSON.stringify({ objective: 'wait', steps: [{ description: 'wait' }] }) },
      // A real command that is still running when the worker is asked to stop.
      { text: 'waiting', toolCalls: [{ name: 'terminal.exec', arguments: { command: 'sleep', args: ['5'] } }] },
      { text: 'done' },
    ]);
    await (await developerAgent(agentos, ['terminal'])).createRun({ goal: 'long running' });
    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a' });
    const worker = new AgentWorker({ os: agentos, queue, logger: new NullLogger(), pollIntervalMs: 2 });
    worker.start();
    await waitFor(async () => (await agentos.store.runs.list({})).items[0]?.status === 'EXECUTING');

    // A short grace period forces the runtime to bring the run to a safe stop:
    // it checkpoints and pauses rather than being abandoned mid-command.
    await worker.stop({ timeoutMs: 50 });

    const run = (await agentos.store.runs.list({})).items[0];
    expect(run?.status).toBe('PAUSED');
    const checkpoints = await agentos.store.checkpoints.list(run!.id);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(worker.statsSnapshot().running).toBe(false);
  }, 30_000);

  it('records a worker failure when execution cannot start at all', async () => {
    const agentos = await build();
    await (await developerAgent(agentos)).createRun({ goal: 'cannot start' });
    const queue = new StoreRunQueue({ store: agentos.store, workerId: 'worker-a' });
    const worker = new AgentWorker({ os: agentos, queue, logger: new NullLogger() });

    // Infrastructure failing is the worker's problem, not the agent's: the
    // runtime never gets far enough to classify it.
    const runtimeStart = agentos.runtime.start.bind(agentos.runtime);
    agentos.runtime.start = async () => {
      throw new Error('store temporarily unavailable');
    };

    expect(await worker.tick()).toBe(1);
    await worker.drain();

    const run = (await agentos.store.runs.list({})).items[0];
    const failures = await agentos.store.failures.list(run!.id);
    expect(failures[0]?.code).toBe('worker.execution_failed');
    expect(failures[0]?.category).toBe('infrastructure');
    expect(worker.statsSnapshot().failed).toBe(1);
    // The run goes back on the queue for another attempt instead of being lost.
    expect(claimOf(run!)?.workerId).toBe('queue');

    agentos.runtime.start = runtimeStart;
  });

  it('survives a store outage while it is recording a failure', async () => {
    const agentos = await build();
    const run = await (await developerAgent(agentos)).createRun({ goal: 'unlucky' });

    // The store rejects even the failure record, which is the worst case: the
    // worker cannot persist why the run failed.
    const brokenStore = {
      ...agentos.store,
      failures: {
        save: async () => {
          throw new Error('store unavailable');
        },
        list: agentos.store.failures.list,
      },
    } as typeof agentos.store;
    const brokenOs = {
      ...agentos,
      store: brokenStore,
      runtime: {
        ...agentos.runtime,
        start: async () => {
          throw new Error('store unavailable');
        },
      },
    } as unknown as AgentOS;

    const worker = new AgentWorker({
      os: brokenOs,
      queue: new StoreRunQueue({ store: brokenStore, workerId: 'w-outage' }),
      concurrency: 1,
      pollIntervalMs: 10,
    });
    const item = await worker.queue.claim();
    expect(item).toBeDefined();

    // A rejected promise here would be an unhandled rejection and take the
    // whole worker down, along with every other run it was executing.
    await expect(worker.executeItem(item!)).resolves.toBeUndefined();
    expect(worker.statsSnapshot().failed).toBe(1);

    // The run goes back on the queue so a healthy worker can pick it up.
    const queued = await brokenStore.runs.get(run.id);
    expect(claimOf(queued!)?.workerId).toBe('queue');
  });
});

describe('BullMQ adapter', () => {
  it('derives an idempotent job id from the run and action', () => {
    const context = { runId: 'run_1', organizationId: 'org', projectId: 'prj', action: 'start' as const };
    expect(bullMqJobId(context)).toBe('run_1:start');
    // The same request produces the same job, so Redis deduplicates it.
    expect(bullMqJobId(context)).toBe(bullMqJobId({ ...context }));
    expect(bullMqJobOptions(context)).toMatchObject({
      jobId: 'run_1:start',
      attempts: 3,
      backoff: { type: 'exponential' },
    });
    expect(bullMqJobId({ ...context, action: 'retry' })).toBe('run_1:retry');
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached in time');
}
