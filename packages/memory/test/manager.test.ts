import { describe, expect, it } from 'vitest';
import { MemoryManager, organizationScope, projectScope, runScope, scopeChain } from '../src/index.js';
import { EmbeddedMemoryStore } from '@kazi-ai/agentos-persistence';

function manager(options: { enabled?: boolean; ttlMs?: number; now?: () => number } = {}) {
  const store = new EmbeddedMemoryStore(options.now ? { now: options.now } : {});
  return {
    store,
    memory: new MemoryManager({
      store,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
      ...(options.ttlMs === undefined ? {} : { defaultTtlMs: options.ttlMs }),
      ...(options.now ? { now: options.now } : {}),
    }),
  };
}

describe('memory manager', () => {
  it('writes and recalls entries within scope', async () => {
    const { memory } = manager();
    const scope = projectScope('org_1', 'prj_1');
    const entry = await memory.remember({
      type: 'semantic',
      scope,
      content: 'the auth middleware validates bearer tokens',
      source: 'run_1',
      importance: 0.9,
    });
    expect(entry?.id).toMatch(/^mem_/);
    const results = await memory.recall({ scope, text: 'auth middleware' });
    expect(results).toHaveLength(1);
  });

  it('does not write when memory is disabled', async () => {
    const { memory } = manager({ enabled: false });
    const entry = await memory.remember({
      type: 'episodic',
      scope: runScope('org_1', 'prj_1', 'run_1'),
      content: 'something',
      source: 'run_1',
    });
    expect(entry).toBeUndefined();
    expect(memory.enabled).toBe(false);
  });

  it('deduplicates identical entries in the same scope', async () => {
    const { memory } = manager();
    const scope = projectScope('org_1', 'prj_1');
    const input = { type: 'semantic' as const, scope, content: 'same fact', source: 'run_1' };
    await memory.remember(input);
    await memory.remember(input);
    expect(await memory.recall({ scope })).toHaveLength(1);
  });

  it('drops expired entries during prune', async () => {
    let now = 1_000;
    const { memory } = manager({ now: () => now });
    const scope = runScope('org_1', 'prj_1', 'run_1');
    await memory.remember({ type: 'working', scope, content: 'temporary', source: 'run_1', ttlMs: 50 });
    expect(await memory.recall({ scope })).toHaveLength(1);
    now = 2_000;
    expect(await memory.pruneExpired()).toBe(1);
    expect(await memory.recall({ scope })).toHaveLength(0);
  });

  it('truncates oversized entries instead of storing unbounded content', async () => {
    const store = new EmbeddedMemoryStore();
    const memory = new MemoryManager({ store, maxEntryBytes: 64 });
    const entry = await memory.remember({
      type: 'semantic',
      scope: organizationScope('org_1'),
      content: 'x'.repeat(500),
      source: 'run_1',
    });
    expect(entry?.content.length).toBeLessThan(120);
    expect(entry?.content).toContain('[truncated]');
  });

  it('searches narrower scopes first and never crosses tenants', async () => {
    const { memory } = manager();
    await memory.remember({ type: 'semantic', scope: organizationScope('org_1'), content: 'org wide fact', source: 'seed' });
    await memory.remember({ type: 'semantic', scope: projectScope('org_1', 'prj_1'), content: 'project fact', source: 'seed' });
    await memory.remember({ type: 'semantic', scope: organizationScope('org_2'), content: 'other tenant fact', source: 'seed' });

    const results = await memory.recallScoped({ scope: runScope('org_1', 'prj_1', 'run_1'), limit: 10 });
    const contents = results.map((entry) => entry.content);
    expect(contents).toContain('project fact');
    expect(contents).toContain('org wide fact');
    expect(contents).not.toContain('other tenant fact');
  });

  it('builds a scope chain from narrow to broad', () => {
    const chain = scopeChain({ organizationId: 'org_1', projectId: 'prj_1', runId: 'run_1', agentId: 'agt_1' });
    expect(chain).toHaveLength(3);
    expect(chain[0]).toMatchObject({ runId: 'run_1' });
    expect(chain[chain.length - 1]).toEqual({ organizationId: 'org_1' });
  });
});
