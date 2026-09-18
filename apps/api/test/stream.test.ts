import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { InProcessDispatcher } from '../src/dispatcher.js';
import { startApi, type StartedApi } from '../src/server.js';

let api: StartedApi | undefined;
let os: AgentOS | undefined;
let dir: string | undefined;

afterEach(async () => {
  await api?.stop().catch(() => undefined);
  api = undefined;
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

async function setup(): Promise<{ baseUrl: string; runId: string; dispatcher: InProcessDispatcher }> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-sse-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns: TURNS, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
  });
  await os.agent({ id: 'developer', model: { provider: 'fake', model: 'fake-1' }, tools: ['filesystem'] }).register();
  const dispatcher = new InProcessDispatcher(os.runtime, new NullLogger());
  // A real socket: server-sent events are a transport concern.
  api = await startApi({
    os,
    organizationId: 'org_test',
    projectId: 'prj_test',
    dispatcher,
    auth: { required: false },
    host: '127.0.0.1',
    port: 0,
  });

  const created = await fetch(`${api.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'developer', goal: 'stream me' }),
  });
  expect(created.status).toBe(201);
  const runId = ((await created.json()) as { run: { id: string } }).run.id;
  await dispatcher.drain();
  return { baseUrl: api.url, runId, dispatcher };
}

describe('run event stream', () => {
  it('replays durable events and ends when the run does', async () => {
    const { baseUrl, runId } = await setup();
    const response = await fetch(`${baseUrl}/api/runs/${runId}/events/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('event: run.created');
    expect(body).toContain('event: tool.completed');
    expect(body).toContain('event: run.completed');
    expect(body.trimEnd().endsWith('stream.end') || body.includes('event: stream.end')).toBe(true);

    // Every frame carries an id so a reconnect can resume from it.
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids.length).toBeGreaterThan(3);
    expect([...ids].sort((left, right) => left - right)).toEqual(ids);
  });

  it('resumes after the last event a client saw', async () => {
    const { baseUrl, runId } = await setup();
    const first = await fetch(`${baseUrl}/api/runs/${runId}/events/stream?intervalMs=50`);
    const firstBody = await first.text();
    const ids = [...firstBody.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    const cutoff = ids[1] as number;

    const resumed = await fetch(`${baseUrl}/api/runs/${runId}/events/stream?intervalMs=50`, {
      headers: { 'last-event-id': String(cutoff) },
    });
    const resumedBody = await resumed.text();
    const resumedIds = [...resumedBody.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(resumedIds.length).toBeGreaterThan(0);
    expect(Math.min(...resumedIds)).toBeGreaterThan(cutoff);
  });

  it('404s a run in another organization before opening the stream', async () => {
    const { baseUrl } = await setup();
    const response = await fetch(`${baseUrl}/api/runs/run_nope/events/stream`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });
});
