import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayApp, startGateway, upstreamsFromEnv } from '../src/index.js';
import type { GatewayHandle, GatewayUpstream } from '../src/index.js';

interface Upstream {
  url: string;
  port: number;
  requests: { method: string; url: string; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

const running: { close(): Promise<void> }[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function listen(server: Server): Promise<Upstream> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const upstream: Upstream = {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return upstream;
}

async function startUpstream(
  handler: (request: IncomingMessage, response: import('node:http').ServerResponse) => void,
): Promise<Upstream> {
  const upstream = await listen(createServer(handler));
  running.push(upstream);
  return upstream;
}

async function gateway(options: {
  upstreams: GatewayUpstream[];
  fallback?: GatewayUpstream;
  maxInFlight?: number;
  corsOrigin?: string;
}): Promise<GatewayHandle> {
  const handle = await startGateway({ ...options, host: '127.0.0.1', port: 0 });
  running.push({ close: () => handle.stop() });
  return handle;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Send headers fetch refuses to send, so hop-by-hop handling is actually tested. */
function rawRequest(url: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe('gateway routing', () => {
  it('serves the API on /api and the dashboard on every other path', async () => {
    const api = await startUpstream((request, response) => {
      api.requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ from: 'api', url: request.url }));
    });
    const dashboard = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>dashboard</html>');
    });

    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: '/ready' }],
      fallback: { name: 'dashboard', url: dashboard.url, prefixes: ['/'], readyPath: '/' },
    });

    const apiResponse = await fetch(`${edge.url}/api/runs?limit=2`);
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toEqual({ from: 'api', url: '/api/runs?limit=2' });
    expect(apiResponse.headers.get('x-kazi-upstream')).toBe('api');

    const page = await fetch(`${edge.url}/runs/run_1`);
    expect(await page.text()).toBe('<html>dashboard</html>');
    expect(page.headers.get('x-kazi-upstream')).toBe('dashboard');
  });

  it('prefers the longest matching prefix', async () => {
    const api = await startUpstream((_request, response) => {
      response.end('api');
    });
    const special = await startUpstream((_request, response) => {
      response.end('special');
    });
    const edge = await gateway({
      upstreams: [
        { name: 'api', url: api.url, prefixes: ['/api'], readyPath: '/ready' },
        { name: 'special', url: special.url, prefixes: ['/api/internal'], readyPath: false },
      ],
    });
    expect(await (await fetch(`${edge.url}/api/internal/x`)).text()).toBe('special');
    expect(await (await fetch(`${edge.url}/api/runs`)).text()).toBe('api');
  });

  it('does not capture sibling paths that merely share a prefix', async () => {
    const api = await startUpstream((_request, response) => {
      response.end('api');
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
    });
    const response = await fetch(`${edge.url}/apiary`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  it('preserves status codes and headers, and drops hop-by-hop headers', async () => {
    const api = await startUpstream((request, response) => {
      response.writeHead(201, { 'content-type': 'application/json', 'x-custom': 'yes' });
      response.end(JSON.stringify(request.headers));
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
    });
    const response = await rawRequest(`${edge.url}/api/x`, {
      'x-hop': 'kept',
      te: 'trailers',
      upgrade: 'websocket',
    });
    expect(response.status).toBe(201);
    expect(response.headers['x-custom']).toBe('yes');
    const seen = JSON.parse(response.body) as Record<string, string>;
    expect(seen['x-hop']).toBe('kept');
    expect(seen.te).toBeUndefined();
    expect(seen['proxy-connection']).toBeUndefined();
  });
});

describe('gateway identity headers', () => {
  it('generates a request id and propagates forwarding headers', async () => {
    const api = await startUpstream((request, response) => {
      response.end(JSON.stringify(request.headers));
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
    });

    const generated = await fetch(`${edge.url}/api/x`);
    const headers = (await generated.json()) as Record<string, string>;
    expect(headers['x-request-id']).toMatch(/^req_[0-9a-f]{32}$/);
    expect(generated.headers.get('x-request-id')).toBe(headers['x-request-id']);
    expect(headers['x-forwarded-proto']).toBe('http');
    expect(headers['x-forwarded-for']).toContain('127.0.0.1');
  });

  it('keeps a well-formed request id and rejects a hostile one', async () => {
    const api = await startUpstream((request, response) => {
      response.end(JSON.stringify({ id: request.headers['x-request-id'] }));
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
    });

    const kept = await fetch(`${edge.url}/api/x`, { headers: { 'x-request-id': 'req_abc.123' } });
    expect(((await kept.json()) as { id: string }).id).toBe('req_abc.123');

    const oversized = await fetch(`${edge.url}/api/x`, {
      headers: { 'x-request-id': `req_${'a'.repeat(200)}` },
    });
    expect(((await oversized.json()) as { id: string }).id).toMatch(/^req_[0-9a-f]{32}$/);
  });
});

describe('gateway streaming', () => {
  it('streams server-sent events without buffering them', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await startUpstream((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write('event: run.started\ndata: {"sequence":1}\n\n');
      void gate.then(() => {
        response.write('event: run.completed\ndata: {"sequence":2}\n\n');
        response.end();
      });
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
    });

    const response = await fetch(`${edge.url}/api/runs/run_1/events/stream`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader?.read();
    const firstChunk = new TextDecoder().decode(first?.value);
    expect(firstChunk).toContain('run.started');

    release?.();
    let rest = '';
    for (;;) {
      const chunk = await reader?.read();
      if (chunk?.done !== false) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain('run.completed');
  });
});

describe('gateway failure handling', () => {
  it('answers 502 with an actionable body when the upstream refuses connections', async () => {
    const port = await freePort();
    const edge = await gateway({
      upstreams: [
        { name: 'api', url: `http://127.0.0.1:${port}`, prefixes: ['/api'], readyPath: false },
      ],
    });
    const response = await fetch(`${edge.url}/api/runs`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.error.message).toContain('api is unavailable');
  });

  it('answers 504 when the upstream never sends a byte', async () => {
    const api = await startUpstream(() => {
      // Intentionally never responses.
    });
    const edge = await gateway({
      upstreams: [
        { name: 'api', url: api.url, prefixes: ['/api'], readyPath: false, timeoutMs: 120 },
      ],
    });
    const response = await fetch(`${edge.url}/api/slow`);
    expect(response.status).toBe(504);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'UPSTREAM_TIMEOUT',
    );
  });

  it('refuses work past its concurrency limit instead of queueing forever', async () => {
    const pending: (() => void)[] = [];
    const api = await startUpstream((_request, response) => {
      pending.push(() => {
        response.end('done');
      });
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
      maxInFlight: 2,
    });

    const first = fetch(`${edge.url}/api/a`);
    const second = fetch(`${edge.url}/api/b`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const third = await fetch(`${edge.url}/api/c`);
    expect(third.status).toBe(503);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'RESOURCE_EXHAUSTED',
    );
    expect(third.headers.get('retry-after')).toBe('1');

    for (const resolve of pending) resolve();
    expect(await (await first).text()).toBe('done');
    expect(await (await second).text()).toBe('done');
  });
});

describe('gateway health', () => {
  it('reports liveness, readiness and the route table', async () => {
    const api = await startUpstream((request, response) => {
      if (request.url === '/ready') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"ready"}');
        return;
      }
      response.end('ok');
    });
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: '/ready' }],
    });

    const health = await fetch(`${edge.url}/healthz`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { service: string }).service).toBe('kazi-agentos-gateway');

    const ready = await fetch(`${edge.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { status: string }).status).toBe('ready');

    const routes = await fetch(`${edge.url}/gateway/routes`);
    const body = (await routes.json()) as { routes: { name: string; url: string }[] };
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]?.name).toBe('api');
    expect(body.routes[0]?.url).toBe(api.url);
  });

  it('reports not-ready when a fronted upstream is down', async () => {
    const port = await freePort();
    const edge = await gateway({
      upstreams: [
        { name: 'api', url: `http://127.0.0.1:${port}`, prefixes: ['/api'], readyPath: '/ready' },
      ],
    });
    const ready = await fetch(`${edge.url}/readyz`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { status: string; checks: { ok: boolean }[] };
    expect(body.status).toBe('not-ready');
    expect(body.checks[0]?.ok).toBe(false);
  });
});

describe('gateway configuration and lifecycle', () => {
  it('derives its route table from the environment', () => {
    const fromEnv = upstreamsFromEnv({
      KZ_API_URL: 'http://api:4000',
      KZ_DASHBOARD_URL: 'http://dashboard:5173',
      KZ_GATEWAY_CORS_ORIGIN: 'https://console.example',
    });
    expect(fromEnv.upstreams[0]?.url).toBe('http://api:4000');
    expect(fromEnv.upstreams[0]?.prefixes).toContain('/api');
    expect(fromEnv.fallback?.url).toBe('http://dashboard:5173');
    expect(fromEnv.corsOrigin).toBe('https://console.example');

    const minimal = upstreamsFromEnv({});
    expect(minimal.upstreams[0]?.url).toBe('http://127.0.0.1:4000');
    expect(minimal.fallback).toBeUndefined();
  });

  it('answers CORS preflight when an origin is configured', async () => {
    const api = await startUpstream((_request, response) => response.end('ok'));
    const edge = await gateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
      corsOrigin: 'https://console.example',
    });
    const preflight = await fetch(`${edge.url}/api/runs`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');

    const normal = await fetch(`${edge.url}/api/runs`);
    expect(normal.headers.get('access-control-allow-origin')).toBe('https://console.example');
  });

  it('stops accepting connections on stop()', async () => {
    const api = await startUpstream((_request, response) => response.end('ok'));
    const handle = await startGateway({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
      host: '127.0.0.1',
      port: 0,
    });
    expect(await (await fetch(`${handle.url}/api/x`)).text()).toBe('ok');
    await handle.stop();
    await expect(fetch(`${handle.url}/api/x`)).rejects.toThrow();
  });

  it('exposes a handler that can be driven without a listener', async () => {
    const api = await startUpstream((_request, response) => response.end('ok'));
    const app = createGatewayApp({
      upstreams: [{ name: 'api', url: api.url, prefixes: ['/api'], readyPath: false }],
    });
    expect(app.router.list()).toHaveLength(1);
    expect(app.proxies[0]?.origin).toBe(api.url);
  });
});
