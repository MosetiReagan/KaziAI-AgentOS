import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { buildApi, type ApiHandle } from '../src/app.js';
import { InProcessDispatcher } from '../src/dispatcher.js';

let handle: ApiHandle | undefined;
let os: AgentOS | undefined;
let dir: string | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (os) await os.close().catch(() => undefined);
  os = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function setup(): Promise<ApiHandle> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-memory-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_mem',
    projectId: 'prj_mem',
    providersFromEnv: false,
    logger: new NullLogger(),
  });
  const dispatcher = new InProcessDispatcher(os.runtime, new NullLogger());
  handle = await buildApi({
    os,
    organizationId: 'org_mem',
    projectId: 'prj_mem',
    dispatcher,
    auth: { required: false },
  });
  return handle;
}

async function seed(store: AgentOS['store']): Promise<void> {
  const base = { type: 'semantic' as const, source: 'agent', importance: 0.8, confidence: 1 };
  await store.memory.write({
    id: 'mem_1',
    ...base,
    content: 'The repository uses pnpm workspaces',
    scope: { organizationId: 'org_mem', projectId: 'prj_mem', agentId: 'developer' },
    tags: ['repo', 'build'],
    createdAt: Date.now(),
  });
  await store.memory.write({
    id: 'mem_2',
    type: 'episodic',
    content: 'Run run_1 failed because the database was unreachable',
    scope: { organizationId: 'org_mem', projectId: 'prj_mem', runId: 'run_1' },
    source: 'runtime',
    importance: 0.4,
    confidence: 0.6,
    createdAt: Date.now(),
    expiresAt: Date.now() - 1_000,
  });
  await store.memory.write({
    id: 'mem_other_tenant',
    ...base,
    content: 'Another tenant secret',
    scope: { organizationId: 'org_other', projectId: 'prj_other' },
    createdAt: Date.now(),
  });
}

describe('memory API', () => {
  it('searches a tenant memory and reports a summary of what it returned', async () => {
    const api = await setup();
    await seed(api.context.os.store);

    const response = await api.app.inject({ method: 'GET', url: '/api/memory' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { id: string }[];
      scope: { organizationId: string };
      total: number;
      hasMore: boolean;
      summary: { byType: Record<string, number>; expired: number; averageImportance: number };
    };
    expect(body.scope.organizationId).toBe('org_mem');
    // The expired entry is withheld unless it is asked for.
    expect(body.items.map((item) => item.id).sort()).toEqual(['mem_1']);
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.summary.byType).toEqual({ semantic: 1 });
    expect(body.summary.expired).toBe(0);
    expect(body.summary.averageImportance).toBeCloseTo(0.8, 3);
  });

  it('never returns another tenant memory', async () => {
    const api = await setup();
    await seed(api.context.os.store);

    const search = await api.app.inject({ method: 'GET', url: '/api/memory' });
    expect(JSON.stringify(search.json())).not.toContain('Another tenant secret');

    const stolen = await api.app.inject({ method: 'DELETE', url: '/api/memory/mem_other_tenant' });
    expect(stolen.statusCode).toBe(404);
    expect(await api.context.os.store.memory.get('mem_other_tenant')).toBeDefined();
  });

  it('filters by run, type, tag, text and importance, and pages with limit', async () => {
    const api = await setup();
    await seed(api.context.os.store);

    const byRun = await api.app.inject({
      method: 'GET',
      url: '/api/memory?runId=run_1&includeExpired=true',
    });
    expect((byRun.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      'mem_2',
    ]);

    const byType = await api.app.inject({ method: 'GET', url: '/api/memory?type=semantic' });
    expect((byType.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      'mem_1',
    ]);

    const byTag = await api.app.inject({ method: 'GET', url: '/api/memory?tags=repo,build' });
    expect((byTag.json() as { items: { id: string }[] }).items).toHaveLength(1);

    const byText = await api.app.inject({ method: 'GET', url: '/api/memory?text=workspaces' });
    expect((byText.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      'mem_1',
    ]);

    const important = await api.app.inject({ method: 'GET', url: '/api/memory?minImportance=0.5' });
    expect((important.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      'mem_1',
    ]);

    const first = await api.app.inject({
      method: 'GET',
      url: '/api/memory?includeExpired=true&limit=1',
    });
    const paged = first.json() as { items: unknown[]; hasMore: boolean; total: number };
    expect(paged.items).toHaveLength(1);
    expect(paged.hasMore).toBe(true);
    expect(paged.total).toBe(1);
  });

  it('hides expired entries unless they are asked for', async () => {
    const api = await setup();
    await seed(api.context.os.store);

    const fresh = await api.app.inject({ method: 'GET', url: '/api/memory' });
    expect((fresh.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
      'mem_1',
    ]);

    const all = await api.app.inject({ method: 'GET', url: '/api/memory?includeExpired=true' });
    expect((all.json() as { items: { id: string }[] }).items).toHaveLength(2);
  });

  it('rejects a malformed query instead of guessing', async () => {
    const api = await setup();
    const response = await api.app.inject({ method: 'GET', url: '/api/memory?type=imaginary' });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
  });

  it('forgets one entry and prunes expired ones', async () => {
    const api = await setup();
    await seed(api.context.os.store);

    const deleted = await api.app.inject({ method: 'DELETE', url: '/api/memory/mem_1' });
    expect(deleted.statusCode).toBe(200);
    expect(await api.context.os.store.memory.get('mem_1')).toBeUndefined();

    const prune = await api.app.inject({ method: 'POST', url: '/api/memory/prune' });
    expect(prune.statusCode).toBe(200);
    expect((prune.json() as { removed: number }).removed).toBe(1);

    const missing = await api.app.inject({ method: 'DELETE', url: '/api/memory/mem_1' });
    expect(missing.statusCode).toBe(404);
  });
});
