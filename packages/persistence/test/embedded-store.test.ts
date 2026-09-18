import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyUsage,
  newCheckpointId,
  newRunId,
  type AgentRun,
  type AgentEvent,
} from '@kazi-ai/agentos-core';
import { EmbeddedStore } from '../src/embedded/embedded-store.js';
import { createEvent } from '@kazi-ai/agentos-core';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kazi-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const now = Date.now();
  return {
    id: newRunId(now),
    goal: 'Fix the failing tests',
    agentId: 'developer',
    organizationId: 'org_1',
    projectId: 'prj_1',
    status: 'CREATED',
    stateVersion: 0,
    createdAt: now,
    updatedAt: now,
    config: {
      agentId: 'developer',
      model: 'test-model',
      provider: 'fake',
      tools: ['filesystem.read'],
      limits: {},
      permissions: {},
      memoryEnabled: true,
      planningEnabled: true,
      verificationEnabled: true,
      recoveryEnabled: true,
    },
    limits: {},
    usage: emptyUsage(),
    rootRunId: 'root',
    traceId: 'trc_1',
    workspaceDir: '/tmp/ws',
    ...overrides,
  };
}

describe('embedded store', () => {
  it('rejects stale run writes using optimistic concurrency', async () => {
    const store = new EmbeddedStore();
    await store.init();
    const run = makeRun();
    await store.runs.create(run);
    const updated = { ...run, stateVersion: 1, status: 'QUEUED' as const };
    await store.runs.update(updated, 0);
    await expect(store.runs.update({ ...updated, stateVersion: 2 }, 0)).rejects.toMatchObject({
      code: 'concurrency.conflict',
    });
  });

  it('refuses duplicate run creation', async () => {
    const store = new EmbeddedStore();
    await store.init();
    const run = makeRun();
    await store.runs.create(run);
    await expect(store.runs.create(run)).rejects.toThrow();
  });

  it('allocates monotonically increasing event sequences per run', async () => {
    const store = new EmbeddedStore();
    await store.init();
    const run = makeRun();
    await store.runs.create(run);
    const first = await store.events.nextSequence(run.id);
    await store.events.append(event(run.id, first, 'run.created'));
    const second = await store.events.nextSequence(run.id);
    expect(second).toBe(first + 1);
    await expect(store.events.append(event(run.id, first, 'run.queued'))).rejects.toMatchObject({
      code: 'concurrency.conflict',
    });
  });

  it('survives a process restart when backed by a directory', async () => {
    const dir = tempDir();
    const first = new EmbeddedStore({ dir });
    await first.init();
    const run = makeRun();
    await first.runs.create(run);
    await first.events.append(event(run.id, 1, 'run.created'));
    await first.actions.recordIntent({
      id: 'act_1',
      runId: run.id,
      actionId: 'act_1',
      idempotencyKey: 'idem_1',
      toolId: 'filesystem.read',
      idempotency: 'idempotent',
      argumentsHash: 'hash',
      arguments: { path: 'a.ts' },
      status: 'pending',
      attempt: 1,
      startedAt: Date.now(),
    });
    await first.close();

    const second = new EmbeddedStore({ dir });
    await second.init();
    expect((await second.runs.get(run.id))?.goal).toBe(run.goal);
    expect(await second.events.list(run.id)).toHaveLength(1);
    const pending = await second.actions.pending(run.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.idempotencyKey).toBe('idem_1');
    // Sequence allocation continues rather than restarting at 1.
    expect(await second.events.nextSequence(run.id)).toBe(2);
  });

  it('marks a journal entry committed and stops reporting it as pending', async () => {
    const store = new EmbeddedStore();
    await store.init();
    await store.actions.recordIntent({
      id: 'act_1',
      runId: 'run_1',
      actionId: 'act_1',
      idempotencyKey: 'idem_1',
      toolId: 'terminal.exec',
      idempotency: 'non-idempotent',
      argumentsHash: 'h',
      status: 'pending',
      attempt: 1,
      startedAt: 1,
    });
    await store.actions.recordCommit({
      runId: 'run_1',
      idempotencyKey: 'idem_1',
      status: 'succeeded',
      result: { ok: true },
      finishedAt: 2,
    });
    expect(await store.actions.pending('run_1')).toHaveLength(0);
    expect((await store.actions.lastCommitted('run_1'))?.status).toBe('succeeded');
    expect((await store.actions.findByKey('run_1', 'idem_1'))?.result).toEqual({ ok: true });
  });

  it('stores checkpoints and returns the latest', async () => {
    const store = new EmbeddedStore();
    await store.init();
    const runId = 'run_1';
    for (const sequence of [1, 2, 3]) {
      await store.checkpoints.save({
        id: newCheckpointId(),
        runId,
        sequence,
        stateVersion: sequence,
        state: {
          runId,
          status: 'EXECUTING',
          stateVersion: sequence,
          goal: 'g',
          config: makeRun().config,
          usage: emptyUsage(),
          observations: [],
          context: {},
          committedActions: [],
        },
        contextSnapshot: {
          objective: 'g',
          completedSteps: [],
          pendingSteps: [],
          observations: [],
          memoryRefs: [],
        },
        createdAt: Date.now(),
      });
    }
    const latest = await store.checkpoints.latest(runId);
    expect(latest?.sequence).toBe(3);
    expect(await store.checkpoints.list(runId)).toHaveLength(3);
  });

  it('filters runs by tenant and status', async () => {
    const store = new EmbeddedStore();
    await store.init();
    await store.runs.create(makeRun({ organizationId: 'org_1', status: 'EXECUTING' }));
    await store.runs.create(makeRun({ organizationId: 'org_2', status: 'QUEUED' }));
    const orgOne = await store.runs.list({ organizationId: 'org_1' });
    expect(orgOne.total).toBe(1);
    const queued = await store.runs.list({ status: ['QUEUED'] });
    expect(queued.items[0]?.organizationId).toBe('org_2');
    expect(await store.runs.countActive('org_1')).toBe(1);
  });

  it('scopes memory search to the requesting tenant', async () => {
    const store = new EmbeddedStore();
    await store.init();
    await store.memory.write({
      id: 'mem_1',
      type: 'semantic',
      scope: { organizationId: 'org_1', projectId: 'prj_1' },
      content: 'the auth middleware validates bearer tokens',
      importance: 0.9,
      confidence: 0.9,
      source: 'run',
      trust: 'untrusted-tool',
      createdAt: Date.now(),
    });
    await store.memory.write({
      id: 'mem_2',
      type: 'semantic',
      scope: { organizationId: 'org_2', projectId: 'prj_2' },
      content: 'the auth middleware validates bearer tokens',
      importance: 0.9,
      confidence: 0.9,
      source: 'run',
      trust: 'untrusted-tool',
      createdAt: Date.now(),
    });
    const results = await store.memory.search({
      scope: { organizationId: 'org_1' },
      text: 'auth middleware',
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe('mem_1');
  });
});

describe('EmbeddedStore read/write isolation', () => {
  it('never hands out a live reference to a stored run', async () => {
    const store = new EmbeddedStore({ dir: tempDir() });
    const run = makeRun();
    await store.runs.create(run);

    // Callers mutate the objects they loaded (a run session bumps the state
    // version); that must not change what the store believes it holds.
    const loaded = await store.runs.get(run.id);
    expect(loaded).toBeDefined();
    loaded!.status = 'PAUSED';
    loaded!.stateVersion = 99;

    const reloaded = await store.runs.get(run.id);
    expect(reloaded?.status).toBe(run.status);
    expect(reloaded?.stateVersion).toBe(run.stateVersion);

    // ...and an optimistic-concurrency write still sees the stored version.
    await expect(store.runs.update({ ...run, status: 'QUEUED' }, run.stateVersion)).resolves.toBeDefined();
  });

  it('does not alias the record passed to update', async () => {
    const store = new EmbeddedStore({ dir: tempDir() });
    const run = makeRun();
    await store.runs.create(run);

    const version = run.stateVersion;
    await store.runs.update(run, version);
    run.stateVersion = version + 1;
    run.status = 'FAILED';
    const stored = await store.runs.get(run.id);
    expect(stored?.stateVersion).toBe(version);
    expect(stored?.status).toBe('CREATED');
  });
});


describe('identity store', () => {
  it('persists tenants, projects, users and API keys across a restart', async () => {
    const dir = tempDir();
    const store = new EmbeddedStore({ dir });

    await store.identity.organizations.save({
      id: 'org_1',
      name: 'Acme',
      slug: 'acme',
      createdAt: Date.now(),
    });
    await store.identity.projects.save({
      id: 'prj_1',
      organizationId: 'org_1',
      name: 'Default',
      slug: 'default',
      createdAt: Date.now(),
    });
    await store.identity.users.save({
      id: 'usr_1',
      organizationId: 'org_1',
      email: 'Operator@Acme.test',
      role: 'operator',
      createdAt: Date.now(),
    });
    await store.identity.apiKeys.save({
      id: 'key_1',
      organizationId: 'org_1',
      name: 'ci',
      hash: 'hash',
      prefix: 'kz_live_abc',
      role: 'developer',
      createdAt: Date.now(),
    });

    // A second store over the same directory is what a restarted process sees.
    const reopened = new EmbeddedStore({ dir });
    expect((await reopened.identity.organizations.getBySlug('acme'))?.id).toBe('org_1');
    expect((await reopened.identity.projects.getBySlug('org_1', 'default'))?.id).toBe('prj_1');
    // Emails are matched case-insensitively: operators do not type carefully.
    expect((await reopened.identity.users.getByEmail('org_1', 'operator@acme.test'))?.id).toBe('usr_1');
    expect((await reopened.identity.apiKeys.getByPrefix('kz_live_abc'))?.id).toBe('key_1');
    // Another tenant's key is not visible through this tenant's listing.
    expect(await reopened.identity.apiKeys.list('org_other')).toHaveLength(0);
  });
});

describe('agent definitions', () => {
  it('keeps one immutable row per version and resolves the latest', async () => {
    const dir = tempDir();
    const store = new EmbeddedStore({ dir });
    await store.init();
    const base = {
      id: 'developer',
      organizationId: 'org_1',
      projectId: 'prj_1',
      name: 'developer',
      source: '{}',
    };
    await store.agentDefinitions.save({ ...base, version: '1.0.0', definition: {}, hash: 'a', createdAt: 1 });
    await store.agentDefinitions.save({ ...base, version: '2.0.0', definition: {}, hash: 'b', createdAt: 2 });

    // The natural key is (organization, agent, version).
    expect((await store.agentDefinitions.get('org_1', 'developer', '1.0.0'))?.hash).toBe('a');
    expect((await store.agentDefinitions.get('org_1', 'developer'))?.version).toBe('2.0.0');
    // Listing collapses versions to the newest one per agent.
    const listed = await store.agentDefinitions.list('org_1', 'prj_1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.version).toBe('2.0.0');
    // Nothing leaks across tenants.
    expect(await store.agentDefinitions.get('org_other', 'developer')).toBeUndefined();

    const reopened = new EmbeddedStore({ dir });
    await reopened.init();
    expect((await reopened.agentDefinitions.get('org_1', 'developer', '1.0.0'))?.hash).toBe('a');
  });
});

describe('webhook subscriptions', () => {
  it('persists subscriptions per tenant and records deliveries', async () => {
    const dir = tempDir();
    const store = new EmbeddedStore({ dir });
    await store.init();
    await store.webhooks.save({
      id: 'wh_1',
      organizationId: 'org_1',
      projectId: 'prj_1',
      url: 'https://hooks.example.test/kazi',
      events: ['run.completed'],
      secret: 'shh',
      active: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await store.webhooks.save({
      id: 'wh_2',
      organizationId: 'org_other',
      projectId: 'prj_other',
      url: 'https://hooks.example.test/other',
      events: [],
      secret: 'other',
      active: false,
      createdAt: 2,
      updatedAt: 2,
    });
    await store.webhooks.recordDelivery({
      id: 'whd_1',
      subscriptionId: 'wh_1',
      organizationId: 'org_1',
      eventId: 'evt_1',
      eventType: 'run.completed',
      runId: 'run_1',
      url: 'https://hooks.example.test/kazi',
      status: 'delivered',
      attempts: 1,
      responseStatus: 200,
      at: 5,
      durationMs: 12,
    });

    // A subscription is never visible outside its tenant.
    expect(await store.webhooks.list({ organizationId: 'org_1' })).toHaveLength(1);
    expect(await store.webhooks.list({ organizationId: 'org_1', active: true })).toHaveLength(1);
    expect(await store.webhooks.list({ organizationId: 'org_other', active: true })).toHaveLength(0);
    expect((await store.webhooks.listDeliveries('wh_1'))[0]?.responseStatus).toBe(200);

    // A restarted process sees the same subscriptions.
    const reopened = new EmbeddedStore({ dir });
    await reopened.init();
    expect((await reopened.webhooks.get('wh_1'))?.url).toBe('https://hooks.example.test/kazi');
    await reopened.webhooks.remove('wh_1');
    expect(await reopened.webhooks.get('wh_1')).toBeUndefined();
  });
});

function event(runId: string, sequence: number, type: AgentEvent['type']): AgentEvent {
  return createEvent({ type, runId, organizationId: 'org_1', projectId: 'prj_1', sequence });
}

