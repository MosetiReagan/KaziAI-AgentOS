import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { buildApi, type ApiHandle } from '../src/app.js';
import { DOCUMENTED_ROUTES } from '../src/openapi.js';

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

async function setup(): Promise<ApiHandle> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-openapi-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    logger: new NullLogger(),
  });
  handle = await buildApi({ os, organizationId: 'org_test', projectId: 'prj_test', auth: { required: false } });
  return handle;
}

describe('OpenAPI document', () => {
  it('documents every route the app serves, and no route it does not', async () => {
    const api = await setup();
    // Fastify names a parameter `:id`, OpenAPI names it `{id}`.
    const served = [...api.context.routes]
      .map((route) => route.replace(/:(\w+)/g, '{$1}'))
      .sort();
    const documented = DOCUMENTED_ROUTES.map((route) => `${route.method} ${route.path}`).sort();
    expect(documented).toEqual(served);
  });

  it('describes the run lifecycle with real schemas', async () => {
    const api = await setup();
    const response = await api.app.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json();

    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('KaziAI AgentOS API');
    expect(document.components.securitySchemes.apiKey.scheme).toBe('bearer');

    const create = document.paths['/api/runs'].post;
    expect(create['x-kazi-minimum-role']).toBe('developer');
    const body = create.requestBody.content['application/json'].schema;
    expect(body.type).toBe('object');
    expect(body.required).toEqual(expect.arrayContaining(['agentId', 'goal']));
    expect(Object.keys(body.properties)).toContain('limits');
    expect(document.components.schemas.RunLimits.properties.maxSteps.type).toBe('integer');

    expect(document.paths['/api/runs/{id}/events/stream'].get.summary).toContain('server-sent events');
    expect(document.paths['/api/approvals/{id}/approve'].post['x-kazi-minimum-role']).toBe('operator');
    expect(document.paths['/api/keys'].get['x-kazi-minimum-role']).toBe('admin');
  });

  it('serves a human-readable index', async () => {
    const api = await setup();
    const response = await api.app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('KaziAI AgentOS API');
    expect(response.body).toContain('/api/runs');
  });
});
