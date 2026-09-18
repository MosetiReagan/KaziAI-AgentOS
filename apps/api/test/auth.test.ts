import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { buildApi, type ApiHandle } from '../src/app.js';
import { InProcessDispatcher } from '../src/dispatcher.js';
import { mintApiKey } from '../src/auth.js';

let handle: ApiHandle | undefined;
let os: AgentOS | undefined;
let dir: string | undefined;

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  handle = undefined;
  if (os) await os.close().catch(() => undefined);
  os = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const TURNS: FakeTurn[] = [
  {
    text: JSON.stringify({
      objective: 'finish',
      steps: [{ description: 'nothing left to do' }],
    }),
  },
  { text: 'done' },
];

async function setup(): Promise<{ api: ApiHandle; bootstrapKey: string; dispatcher: InProcessDispatcher }> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-auth-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns: TURNS, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
  });
  await os.agent({ id: 'developer', model: { provider: 'fake', model: 'fake-1' } }).register();
  const dispatcher = new InProcessDispatcher(os.runtime, new NullLogger());
  handle = await buildApi({
    os,
    organizationId: 'org_test',
    projectId: 'prj_test',
    dispatcher,
    auth: { required: true },
  });
  const bootstrapKey = handle.context.bootstrap?.key;
  if (!bootstrapKey) throw new Error('expected a bootstrap key');
  return { api: handle, bootstrapKey, dispatcher };
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe('API authentication', () => {
  it('refuses a request with no credentials', async () => {
    const { api } = await setup();
    const response = await api.app.inject({ method: 'GET', url: '/api/runs' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a malformed or unknown key without saying which', async () => {
    const { api } = await setup();
    for (const header of ['nonsense', 'kz_live_zzzzzz.deadbeef', 'Basic abc']) {
      const response = await api.app.inject({
        method: 'GET',
        url: '/api/runs',
        headers: { authorization: header },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('accepts the bootstrap admin key and reports who the caller is', async () => {
    const { api, bootstrapKey } = await setup();
    const whoami = await api.app.inject({
      method: 'GET',
      url: '/api/whoami',
      headers: bearer(bootstrapKey),
    });
    expect(whoami.statusCode).toBe(200);
    expect(whoami.json().principal).toMatchObject({
      kind: 'api-key',
      organizationId: 'org_test',
      role: 'admin',
    });
  });

  it('stores only a hash of a key, never the key itself', async () => {
    const { api, bootstrapKey } = await setup();
    const keys = await api.app.inject({ method: 'GET', url: '/api/keys', headers: bearer(bootstrapKey) });
    expect(keys.statusCode).toBe(200);
    const serialized = JSON.stringify(keys.json());
    expect(serialized).not.toContain(bootstrapKey.split('.')[1] as string);
    expect(serialized).not.toContain('"hash"');

    const stored = await api.context.store.identity.apiKeys.list('org_test');
    expect(stored[0]?.hash).toHaveLength(64);
    expect(stored[0]?.hash).not.toBe(bootstrapKey);
  });

  it('enforces the role of a key', async () => {
    const { api, bootstrapKey } = await setup();
    const viewer = await api.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: bearer(bootstrapKey),
      payload: { name: 'read-only', role: 'viewer' },
    });
    expect(viewer.statusCode).toBe(201);
    const viewerKey = viewer.json().key as string;

    // A viewer can read...
    expect((await api.app.inject({ method: 'GET', url: '/api/runs', headers: bearer(viewerKey) })).statusCode).toBe(200);
    // ...but cannot create work, and cannot manage keys.
    const create = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: bearer(viewerKey),
      payload: { agentId: 'developer', goal: 'nope' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('FORBIDDEN');
    expect(create.json().error.detail.required).toBe('developer');

    const keys = await api.app.inject({ method: 'GET', url: '/api/keys', headers: bearer(viewerKey) });
    expect(keys.statusCode).toBe(403);
  });

  it('lets a developer run an agent but not approve a risky action', async () => {
    const { api, bootstrapKey, dispatcher } = await setup();
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: bearer(bootstrapKey),
      payload: { name: 'dev', role: 'developer' },
    });
    const developerKey = created.json().key as string;

    const run = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: bearer(developerKey),
      payload: { agentId: 'developer', goal: 'authenticated run' },
    });
    expect(run.statusCode).toBe(201);
    await dispatcher.drain();
    expect(run.json().run.status).not.toBe('FAILED');

    const approve = await api.app.inject({
      method: 'POST',
      url: '/api/approvals/apr_whatever/approve',
      headers: bearer(developerKey),
      payload: {},
    });
    // The role gate answers before the (missing) approval is looked up.
    expect(approve.statusCode).toBe(403);
  });

  it('rejects a revoked or expired key', async () => {
    const { api, bootstrapKey } = await setup();
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: bearer(bootstrapKey),
      payload: { name: 'short-lived', role: 'developer' },
    });
    const keyId = created.json().apiKey.id as string;
    const key = created.json().key as string;
    expect((await api.app.inject({ method: 'GET', url: '/api/runs', headers: bearer(key) })).statusCode).toBe(200);

    const revoked = await api.app.inject({
      method: 'DELETE',
      url: `/api/keys/${keyId}`,
      headers: bearer(bootstrapKey),
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await api.app.inject({ method: 'GET', url: '/api/runs', headers: bearer(key) });
    expect(afterRevoke.statusCode).toBe(401);

    // An expired key is equally useless.
    const expired = await api.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: bearer(bootstrapKey),
      payload: { name: 'expired', role: 'developer', expiresAt: Date.now() - 1_000 },
    });
    const expiredKey = expired.json().key as string;
    expect((await api.app.inject({ method: 'GET', url: '/api/runs', headers: bearer(expiredKey) })).statusCode).toBe(401);
  });

  it('never lets one tenant see or start another tenant\'s work', async () => {
    const { api, bootstrapKey } = await setup();
    // A second organization with its own key, written straight to the store the
    // way an operator provisioned out of band would.
    const other = mintApiKey();
    await api.context.store.identity.organizations.save({
      id: 'org_other',
      name: 'other',
      slug: 'other',
      createdAt: Date.now(),
    });
    await api.context.store.identity.projects.save({
      id: 'prj_other',
      organizationId: 'org_other',
      name: 'other',
      slug: 'other',
      createdAt: Date.now(),
    });
    await api.context.store.identity.apiKeys.save({
      id: 'key_other',
      organizationId: 'org_other',
      projectId: 'prj_other',
      name: 'other-admin',
      hash: other.hash,
      prefix: other.prefix,
      role: 'admin',
      createdAt: Date.now(),
    });

    const mine = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: bearer(bootstrapKey),
      payload: { agentId: 'developer', goal: 'mine' },
    });
    const runId = mine.json().run.id as string;

    // Reading it is a 404, not a 403: existence is not disclosed.
    const read = await api.app.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: bearer(other.plaintext) });
    expect(read.statusCode).toBe(404);

    // And the other tenant's run list is empty.
    const list = await api.app.inject({ method: 'GET', url: '/api/runs', headers: bearer(other.plaintext) });
    expect(list.json().total).toBe(0);

    // Naming another organization explicitly is refused outright.
    const crossTenant = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: bearer(other.plaintext),
      payload: { agentId: 'developer', goal: 'steal', organizationId: 'org_test' },
    });
    expect(crossTenant.statusCode).toBe(403);
  });

  it('scopes a project-scoped key to its own project', async () => {
    const { api, bootstrapKey } = await setup();
    const created = await api.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: bearer(bootstrapKey),
      payload: { name: 'project key', role: 'developer', projectId: 'prj_test' },
    });
    const key = created.json().key as string;
    const otherProject = await api.app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: bearer(key),
      payload: { agentId: 'developer', goal: 'elsewhere', projectId: 'prj_somewhere_else' },
    });
    expect(otherProject.statusCode).toBe(403);
  });
});
