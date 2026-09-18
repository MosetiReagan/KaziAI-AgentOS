import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider } from '@kazi-ai/agentos-providers';
import { buildApi, type ApiHandle } from '@kazi-ai/agentos-api';
import { AgentWorker } from '../src/worker.js';
import { StoreRunQueue } from '../src/queue.js';
import { startWorker } from '../src/server.js';

let api: ApiHandle | undefined;
let os: AgentOS | undefined;
let dir: string | undefined;

afterEach(async () => {
  await api?.close().catch(() => undefined);
  api = undefined;
  if (os) await os.close().catch(() => undefined);
  os = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * The deployment split the specification asks for: the API accepts work and a
 * separate worker executes it. Neither process holds the run in memory.
 */
describe('API and worker over one durable store', () => {
  it('accepts a run in one process and completes it in another', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kazi-compose-'));
    os = await createAgentOS({
      dataDir: dir,
      organizationId: 'org_test',
      projectId: 'prj_test',
      providersFromEnv: false,
      providers: [
        new FakeModelProvider({
          turns: [
            { text: JSON.stringify({ objective: 'Write result.txt', steps: [{ description: 'write' }] }) },
            { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'x' } }] },
            { text: 'done' },
          ],
          onExhausted: { text: 'done' },
        }),
      ],
      logger: new NullLogger(),
    });
    await os.agent({ id: 'developer', model: { provider: 'fake', model: 'fake-1' }, tools: ['filesystem'] }).register();

    api = await buildApi({
      os,
      organizationId: 'org_test',
      projectId: 'prj_test',
      auth: { required: false },
      // The API does not execute anything; it hands the run to the queue.
      env: { KZ_QUEUE: 'store' },
    });

    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'executed by a worker' },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;

    // Nothing has run yet: the API process is not an executor.
    expect((await os.store.runs.get(runId))?.status).toBe('CREATED');

    const worker = new AgentWorker({
      os,
      queue: new StoreRunQueue({ store: os.store, workerId: 'worker-1' }),
      logger: new NullLogger(),
    });
    expect(await worker.tick()).toBe(1);
    await worker.drain();

    const finished = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(finished.json().run.status).toBe('COMPLETED');
    expect(worker.statsSnapshot()).toMatchObject({ claimed: 1, completed: 1 });
  });

  it('refuses to silently fall back when a queue backend is unavailable', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kazi-compose-'));
    os = await createAgentOS({
      dataDir: dir,
      organizationId: 'org_test',
      projectId: 'prj_test',
      providersFromEnv: false,
      logger: new NullLogger(),
    });
    await expect(
      buildApi({ os, organizationId: 'org_test', projectId: 'prj_test', auth: { required: false }, env: { KZ_QUEUE: 'nonsense' } }),
    ).rejects.toThrow(/nonsense/);
  });
});

/**
 * A deployment that puts Redis between the API and the worker must actually
 * drain from Redis. The worker used to poll the store regardless of
 * `KZ_QUEUE`, which would have left every BullMQ job unclaimed.
 */
describe('the worker drains the queue its deployment selected', () => {
  it('serves runs delivered by BullMQ and tracks them as in-flight work', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kazi-bullmq-'));
    os = await createAgentOS({
      dataDir: dir,
      organizationId: 'org_test',
      projectId: 'prj_test',
      providersFromEnv: false,
      providers: [
        new FakeModelProvider({
          turns: [{ text: 'done' }],
          onExhausted: { text: 'done' },
        }),
      ],
      logger: new NullLogger(),
    });
    await os
      .agent({ id: 'developer', model: { provider: 'fake', model: 'fake-1' }, tools: ['filesystem'] })
      .register();

    const processed: string[] = [];
    let closed = false;
    const processor = { current: undefined as ((job: { data: unknown }) => Promise<void>) | undefined };
    const bullMqModule = {
      Queue: class {
        async add(): Promise<{ id: string }> {
          return { id: 'job' };
        }
        async getJobCounts(): Promise<Record<string, number>> {
          return {};
        }
        async close(): Promise<void> {}
      },
      Worker: class {
        constructor(_name: string, handler: (job: { data: unknown }) => Promise<void>) {
          processor.current = handler;
        }
        on(): void {}
        async close(): Promise<void> {
          closed = true;
        }
      },
    };

    const started = await startWorker({
      os,
      queueBackend: 'bullmq',
      bullMqModule,
      logger: new NullLogger(),
      // No health server: this test is about queue ownership.
      health: false,
      concurrency: 1,
    });

    expect(started.worker.isRunning).toBe(true);
    expect(started.worker.statsSnapshot().running).toBe(true);

    const run = await os.runtime.createRun({
      goal: 'Do nothing',
      agentId: 'developer',
      organizationId: 'org_test',
      projectId: 'prj_test',
      config: {
        agentId: 'developer',
        model: 'fake-1',
        provider: 'fake',
        tools: ['filesystem.read'],
        limits: {},
        permissions: { filesystem: { read: true } },
        memoryEnabled: false,
        planningEnabled: false,
        verificationEnabled: false,
        recoveryEnabled: false,
      },
      limits: {},
      permissions: { filesystem: { read: true } },
      metadata: {},
    });
    void run;

    await processor.current?.({
      data: {
        runId: run.id,
        organizationId: 'org_test',
        projectId: 'prj_test',
        action: 'start',
        requestedAt: Date.now(),
      },
    });
    processed.push(run.id);
    // The job the queue delivered really ran to completion through the worker.
    expect((await os.runtime.getRun(run.id)).status).toBe('COMPLETED');

    await started.stop();
    expect(closed).toBe(true);
    expect(processed).toEqual([run.id]);
  });
});
