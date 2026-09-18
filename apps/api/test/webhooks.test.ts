import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { buildApi, type ApiHandle } from '../src/app.js';
import { InProcessDispatcher } from '../src/dispatcher.js';

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let handle: ApiHandle | undefined;
let os: AgentOS | undefined;
let dir: string | undefined;
let receiver: Server | undefined;

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  handle = undefined;
  if (os) await os.close().catch(() => undefined);
  os = undefined;
  if (receiver) {
    await new Promise<void>((resolve) => receiver?.close(() => resolve()));
    receiver = undefined;
  }
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

/** A receiver that answers with the given status and records what it saw. */
async function startReceiver(
  status = 200,
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      received.push({ headers: request.headers, body });
      response.writeHead(status);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => receiver?.listen(0, '127.0.0.1', () => resolve()));
  const address = receiver.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/hook`, received };
}

async function setup(): Promise<{ api: ApiHandle; dispatcher: InProcessDispatcher; dataDir: string }> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-hooks-'));
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
  handle = await buildApi({
    os,
    organizationId: 'org_test',
    projectId: 'prj_test',
    dispatcher,
    auth: { required: false },
    webhooks: { backoffMs: 5, maxAttempts: 3, timeoutMs: 500 },
  });
  return { api: handle, dispatcher, dataDir: dir };
}

describe('webhook delivery', () => {
  it('signs a delivery so the receiver can verify it came from AgentOS', async () => {
    const { api, dispatcher } = await setup();
    const endpoint = await startReceiver();
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: endpoint.url, events: ['run.completed'] },
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().secret as string;

    const run = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'notify me' },
    });
    await dispatcher.drain();
    await api.context.webhooks?.drain();

    const runId = run.json().run.id as string;
    const delivery = endpoint.received.find((item) => item.headers['x-kazi-event'] === 'run.completed');
    expect(delivery, JSON.stringify(endpoint.received.map((r) => r.headers['x-kazi-event']))).toBeDefined();

    const timestamp = delivery?.headers['x-kazi-timestamp'] as string;
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${delivery?.body}`)
      .digest('hex');
    expect(delivery?.headers['x-kazi-signature']).toBe(`sha256=${expected}`);
    expect(delivery?.headers['x-kazi-run-id']).toBe(runId);

    const event = JSON.parse(delivery?.body as string) as { type: string; runId: string };
    expect(event).toMatchObject({ type: 'run.completed', runId });

    // The delivery log is queryable, and it does not leak the secret.
    const deliveries = await api.app.inject({ method: 'GET', url: `/api/webhooks/${created.json().subscription.id}/deliveries` });
    expect(deliveries.json().items).toHaveLength(1);
    expect(deliveries.json().items[0]).toMatchObject({ status: 'delivered', responseStatus: 200 });
    expect(JSON.stringify(deliveries.json())).not.toContain(secret);
  });

  it('delivers only the event types a subscription asked for', async () => {
    const { api, dispatcher } = await setup();
    const endpoint = await startReceiver();
    await api.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: endpoint.url, events: ['run.failed'] },
    });

    await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'only failures please' },
    });
    await dispatcher.drain();
    await api.context.webhooks?.drain();

    expect(endpoint.received).toHaveLength(0);
  });

  it('retries a failing endpoint and records the failure', async () => {
    const { api, dispatcher } = await setup();
    const endpoint = await startReceiver(503);
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: endpoint.url, events: ['run.completed'] },
    });

    await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'will fail to deliver' },
    });
    await dispatcher.drain();
    await api.context.webhooks?.drain();

    expect(endpoint.received).toHaveLength(3);
    const deliveries = await api.app.inject({
      method: 'GET',
      url: `/api/webhooks/${created.json().subscription.id}/deliveries`,
    });
    expect(deliveries.json().items[0]).toMatchObject({
      status: 'failed',
      attempts: 3,
      responseStatus: 503,
    });
  });

  it('sends a test ping on demand', async () => {
    const { api } = await setup();
    const endpoint = await startReceiver();
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: endpoint.url, events: ['run.completed'] },
    });

    const test = await api.app.inject({
      method: 'POST',
      url: `/api/webhooks/${created.json().subscription.id}/test`,
    });
    expect(test.statusCode).toBe(200);
    expect(test.json().outcome.delivered).toBe(true);
    expect(endpoint.received[0]?.headers['x-kazi-event']).toBe('webhook.test');
  });

  it('never delivers one tenant\'s events to another tenant', async () => {
    const { api, dispatcher } = await setup();
    const endpoint = await startReceiver();
    await api.context.store.webhooks.save({
      id: 'wh_other',
      organizationId: 'org_other',
      projectId: 'prj_other',
      url: endpoint.url,
      events: [],
      secret: 'other-secret-other-secret',
      active: true,
      createdAt: 1,
      updatedAt: 1,
    });

    await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { agentId: 'developer', goal: 'private' },
    });
    await dispatcher.drain();
    await api.context.webhooks?.drain();

    expect(endpoint.received).toHaveLength(0);
    const subscriptions = await api.app.inject({ method: 'GET', url: '/api/webhooks' });
    expect(subscriptions.json().items).toHaveLength(0);
  });

  it('rejects an unknown event type and requires admin to manage subscriptions', async () => {
    const { api } = await setup();
    const endpoint = await startReceiver();
    const unknown = await api.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      payload: { url: endpoint.url, events: ['run.exploded'] },
    });
    expect(unknown.statusCode).toBe(404);

    // With authentication on, only an admin may manage subscriptions.
    const { api: secured, dispatcher } = await setupSecured();
    void dispatcher;
    const created = await secured.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: { authorization: `Bearer ${secured.context.bootstrap?.key as string}` },
      payload: { name: 'dev', role: 'developer' },
    });
    const developerKey = created.json().key as string;
    const denied = await secured.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { authorization: `Bearer ${developerKey}` },
      payload: { url: endpoint.url },
    });
    expect(denied.statusCode).toBe(403);
  });
});

async function setupSecured(): Promise<{ api: ApiHandle; dispatcher: InProcessDispatcher }> {
  await handle?.close().catch(() => undefined);
  if (os) await os.close().catch(() => undefined);
  dir = mkdtempSync(join(tmpdir(), 'kazi-hooks-sec-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns: TURNS, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
  });
  const dispatcher = new InProcessDispatcher(os.runtime, new NullLogger());
  handle = await buildApi({
    os,
    organizationId: 'org_test',
    projectId: 'prj_test',
    dispatcher,
    auth: { required: true },
    webhooks: { enabled: false },
  });
  return { api: handle, dispatcher };
}
