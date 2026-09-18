import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
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

/** A run that writes a file and finishes; enough to exercise the whole loop. */
const TURNS: FakeTurn[] = [
  { text: JSON.stringify({ objective: 'Write result.txt', steps: [{ description: 'write it' }] }) },
  {
    text: 'writing',
    toolCalls: [{ name: 'filesystem.write', arguments: { path: 'result.txt', content: 'hi' } }],
  },
  { text: 'done' },
];

async function setup(options: { registerAgent?: boolean; agentFile?: boolean } = {}): Promise<{
  api: ApiHandle;
  dispatcher: InProcessDispatcher;
  organizationId: string;
  projectId: string;
}> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-api-'));
  const agentDirs: string[] = [];
  if (options.agentFile) {
    const agentsDir = join(dir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'developer.yaml'),
      [
        'id: developer',
        'version: 1.0.0',
        'model:',
        '  provider: fake',
        '  model: fake-1',
        'system_prompt: You are a developer.',
        'tools:',
        '  - filesystem',
        'limits:',
        '  max_steps: 10',
      ].join('\n'),
      'utf8',
    );
    agentDirs.push(agentsDir);
  }

  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    // Once the scripted turns run out the model still produces a valid plan,
    // so a second run in the same test behaves like the first.
    providers: [
      new FakeModelProvider({
        turns: TURNS,
        onExhausted: { text: JSON.stringify({ objective: 'finish', steps: [{ description: 'nothing left to do' }] }) },
      }),
    ],
    logger: new NullLogger(),
  });
  if (options.registerAgent) {
    await os
      .agent({ id: 'developer', model: { provider: 'fake', model: 'fake-1' }, tools: ['filesystem'] })
      .register();
  }
  const dispatcher = new InProcessDispatcher(os.runtime, new NullLogger());
  handle = await buildApi({
    os,
    agentDirs,
    organizationId: 'org_test',
    projectId: 'prj_test',
    dispatcher,
  });
  return { api: handle, dispatcher, organizationId: 'org_test', projectId: 'prj_test' };
}

describe('AgentOS HTTP API', () => {
  it('reports liveness and readiness without exposing internals', async () => {
    const { api } = await setup();
    const health = await api.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'kazi-agentos-api' });

    const ready = await api.app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.store.ok).toBe(true);
  });

  it('creates a run, executes it, and serves its trace, events and result', async () => {
    const { api, dispatcher } = await setup({ registerAgent: true });

    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'Write result.txt' },
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    expect(runId).toMatch(/^run_/);

    await dispatcher.drain();

    const run = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(run.statusCode).toBe(200);
    expect(run.json().run.status).toBe('COMPLETED');

    const result = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}/result` });
    expect(result.json().result).toMatchObject({ success: true, toolCalls: 1 });

    const trace = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}/trace` });
    expect(trace.json().trace.nodes.length).toBeGreaterThan(0);

    const events = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}/events` });
    const types = (events.json().items as Array<{ type: string }>).map((event) => event.type);
    expect(types).toContain('run.created');
    expect(types).toContain('tool.completed');
    expect(types).toContain('run.completed');

    const steps = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}/steps` });
    expect(steps.json().items.length).toBeGreaterThan(0);

    const journal = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}/journal` });
    expect(journal.json().items.length).toBeGreaterThan(0);
  });

  it('lists runs with pagination and filters', async () => {
    const { api, dispatcher } = await setup({ registerAgent: true });
    for (const goal of ['first', 'second']) {
      await api.app.inject({ method: 'POST', url: '/api/runs', payload: { agentId: 'developer', goal } });
    }
    await dispatcher.drain();

    const all = await api.app.inject({ method: 'GET', url: '/api/runs' });
    expect(all.json().total).toBe(2);
    expect(all.json().items).toHaveLength(2);

    const done = await api.app.inject({ method: 'GET', url: '/api/runs?status=COMPLETED&limit=1' });
    expect(done.json().total).toBe(2);
    expect(done.json().items).toHaveLength(1);
    expect(done.json().limit).toBe(1);

    const missing = await api.app.inject({ method: 'GET', url: '/api/runs?status=NOPE' });
    expect(missing.json().total).toBe(0);
  });

  it('creates a run without starting it when asked', async () => {
    const { api } = await setup({ registerAgent: true });
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'later', start: false },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().run.status).toBe('CREATED');
    const runId = created.json().run.id as string;

    const started = await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/start` });
    expect(started.statusCode).toBe(200);
  });

  it('rejects a malformed body and names the offending field', async () => {
    const { api } = await setup({ registerAgent: true });
    const response = await api.app.inject({ method: 'POST', url: '/api/runs', payload: { goal: '' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_REQUEST');
    expect(JSON.stringify(response.json().error.detail)).toContain('agentId');
  });

  it('404s an unknown agent, an unknown run and an unknown route', async () => {
    const { api } = await setup({ registerAgent: true });
    const agent = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'nobody', goal: 'x' },
    });
    expect(agent.statusCode).toBe(404);

    const run = await api.app.inject({ method: 'GET', url: '/api/runs/run_missing' });
    expect(run.statusCode).toBe(404);
    expect(run.json().error.code).toBe('NOT_FOUND');

    const route = await api.app.inject({ method: 'GET', url: '/nope' });
    expect(route.statusCode).toBe(404);
    expect(route.json().error.code).toBe('NOT_FOUND');
  });

  it('discovers agents from definition files', async () => {
    const { api } = await setup({ agentFile: true });
    const agents = await api.app.inject({ method: 'GET', url: '/api/agents' });
    expect(agents.statusCode).toBe(200);
    const items = agents.json().items as Array<{ id: string; source: string; tools: string[] }>;
    expect(items.map((item) => item.id)).toContain('developer');
    expect(items.find((item) => item.id === 'developer')?.source).toBe('file');

    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'from a file' },
    });
    expect(created.statusCode).toBe(201);
  });

  it('serves the tools, providers, policies and info catalog', async () => {
    const { api } = await setup({ registerAgent: true });
    const tools = await api.app.inject({ method: 'GET', url: '/api/tools' });
    const ids = (tools.json().items as Array<{ id: string }>).map((tool) => tool.id);
    expect(ids).toContain('filesystem.write');
    expect(ids).toContain('terminal.exec');

    const providers = await api.app.inject({ method: 'GET', url: '/api/providers' });
    expect(providers.json().items.map((item: { id: string }) => item.id)).toContain('fake');

    const policies = await api.app.inject({ method: 'GET', url: '/api/policies' });
    const ruleIds = (policies.json().items as Array<{ id: string }>).map((rule) => rule.id);
    expect(ruleIds).toContain('require-approval.git.push');
    expect(policies.json().riskRules.length).toBeGreaterThan(0);

    const info = await api.app.inject({ method: 'GET', url: '/api/info' });
    expect(info.json().info.driver).toBeTruthy();
  });

  it('refuses lifecycle commands a finished run cannot accept', async () => {
    const { api, dispatcher } = await setup({ registerAgent: true });
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'paused one', start: false },
    });
    const runId = created.json().run.id as string;

    await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/start` });
    await dispatcher.drain();

    const resumed = await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/resume` });
    // A finished run has nothing to resume, and the API says so instead of
    // accepting work it will never execute.
    expect(resumed.statusCode).toBe(409);
    expect(resumed.json().error.code).toBe('CONFLICT');

    const started = await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/start` });
    expect(started.statusCode).toBe(409);

    const retried = await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/retry` });
    expect(retried.statusCode).toBe(409);
  });

  it('cancels a run that has not started', async () => {
    const { api } = await setup({ registerAgent: true });
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'to cancel', start: false },
    });
    const runId = created.json().run.id as string;

    const cancelled = await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('CANCELLED');

    const again = await api.app.inject({ method: 'POST', url: `/api/runs/${runId}/start` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
  });

  it('checkpoints a run on demand and forks it', async () => {
    const { api, dispatcher } = await setup({ registerAgent: true });
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'checkpoint me' },
    });
    const runId = created.json().run.id as string;
    await dispatcher.drain();

    const checkpoint = await api.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/checkpoint`,
    });
    expect(checkpoint.statusCode).toBe(201);
    expect(checkpoint.json().checkpoint.id).toMatch(/^cp_/);

    const list = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}/checkpoints` });
    expect(list.json().items.length).toBeGreaterThan(0);

    const forked = await api.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/fork`,
      payload: { goal: 'a different approach' },
    });
    expect(forked.statusCode).toBe(201);
    expect(forked.json().run.parentRunId).toBe(runId);
    expect(forked.json().run.status).toBe('CREATED');
  });

  it('replays a finished run from its journal', async () => {
    const { api, dispatcher } = await setup({ registerAgent: true });
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'replay me' },
    });
    const runId = created.json().run.id as string;
    await dispatcher.drain();

    const replay = await api.app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/replay`,
      payload: { mode: 'trace' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().report.runId).toBe(runId);
  });
});
