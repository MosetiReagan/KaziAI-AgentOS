import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { McpServerConfigInput } from '../src/config.js';
import { McpManager } from '../src/manager.js';
import { createFakeServerHandler } from './fake-server.js';

interface TestServer {
  url: string;
  close(): Promise<void>;
  requests: Array<{ headers: IncomingMessage['headers']; body: unknown }>;
}

/** A real streamable-HTTP MCP endpoint answering with JSON or SSE. */
async function startHttpServer(options: { token?: string; sse?: boolean } = {}): Promise<TestServer> {
  const handler = createFakeServerHandler();
  const requests: TestServer['requests'] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk);
    });
    req.on('end', () => {
      const body = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
      requests.push({ headers: req.headers, body });
      if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthorized' } }));
        return;
      }
      if ((body as { id?: unknown } | undefined)?.id === undefined) {
        // A compliant server acknowledges notifications without a body, and
        // must never hold the connection open for them.
        res.writeHead(202, { 'mcp-session-id': 'session-1' });
        res.end();
        handler(body, () => undefined);
        return;
      }
      const respond = (message: unknown): void => {
        if (options.sse === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
          res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
        res.end(JSON.stringify(message));
      };
      handler(body, respond);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function httpConfig(
  url: string,
  overrides: { auth?: { header: string; scheme?: string; secretRef: string }; id?: string } = {},
): McpServerConfigInput {
  return {
    id: overrides.id ?? 'remote',
    transport: { type: 'http', url, headers: {}, ...(overrides.auth === undefined ? {} : { auth: overrides.auth }) },
    risk: 'MEDIUM',
    permissions: {},
  };
}

describe('MCP over streamable HTTP', () => {
  it('discovers and calls tools through a real HTTP endpoint', async () => {
    const server = await startHttpServer();
    const manager = new McpManager();
    manager.addServer(httpConfig(server.url));
    const [status] = await manager.start();

    expect(status?.connected).toBe(true);
    expect(status?.toolCount).toBe(4);
    const result = await manager.callTool('remote', 'echo_tool', { message: 'over http' });
    expect(result).toEqual({ echoed: 'over http', name: 'echo_tool' });

    // The session id handed out on initialize is echoed on later requests.
    const withSession = server.requests.filter((request) => request.headers['mcp-session-id'] === 'session-1');
    expect(withSession.length).toBeGreaterThan(3);
    // The initialize notification was acknowledged rather than held open.
    const notification = server.requests.find((request) => (request.body as { id?: unknown }).id === undefined);
    expect(notification).toBeDefined();
    await manager.close();
    await server.close();
  }, 60_000);

  it('parses an SSE response body', async () => {
    const server = await startHttpServer({ sse: true });
    const manager = new McpManager();
    manager.addServer(httpConfig(server.url));
    const [status] = await manager.start();
    expect(status?.connected).toBe(true);
    expect(await manager.callTool('remote', 'echo_tool', { message: 'sse' })).toEqual({ echoed: 'sse', name: 'echo_tool' });
    await manager.close();
    await server.close();
  }, 60_000);

  it('resolves a bearer token from a secret reference and keeps it out of status output', async () => {
    const server = await startHttpServer({ token: 's3cret' });
    const manager = new McpManager({
      resolveSecret: async (reference) => (reference === 'secret://mcp/token' ? 's3cret' : Promise.reject(new Error('unknown reference'))),
    });
    manager.addServer(httpConfig(server.url, { auth: { header: 'Authorization', scheme: 'Bearer', secretRef: 'secret://mcp/token' } }));
    const [status] = await manager.start();

    expect(status?.connected).toBe(true);
    expect(server.requests[0]?.headers.authorization).toBe('Bearer s3cret');
    expect(JSON.stringify(manager.status())).not.toContain('s3cret');
    expect(JSON.stringify(manager.health())).not.toContain('s3cret');
    await manager.close();
    await server.close();
  }, 60_000);

  it('reports rejected credentials as an auth failure', async () => {
    const server = await startHttpServer({ token: 's3cret' });
    const manager = new McpManager({ resolveSecret: async () => 'wrong-token' });
    manager.addServer(httpConfig(server.url, { auth: { header: 'Authorization', scheme: 'Bearer', secretRef: 'secret://mcp/token' } }));
    const [status] = await manager.start();
    expect(status?.connected).toBe(false);
    expect(status?.error?.code).toBe('mcp.auth_error');
    await manager.close();
    await server.close();
  }, 60_000);

  it('refuses an auth config with no way to resolve the secret', async () => {
    const manager = new McpManager();
    manager.addServer(httpConfig('http://127.0.0.1:9/mcp', { auth: { header: 'X-Api-Key', secretRef: 'secret://mcp/key' } }));
    const [status] = await manager.start();
    expect(status?.error?.code).toBe('mcp.auth_error');
    await manager.close();
  });

  it('requires credentials to be secret references, not literals', () => {
    const manager = new McpManager();
    expect(() =>
      manager.addServer(httpConfig('http://127.0.0.1:9/mcp', { auth: { header: 'Authorization', secretRef: 'literal-token-value' } })),
    ).toThrow(/secret:\/\//);
    expect(() => manager.addServer(httpConfig('not-a-url'))).toThrow(/Invalid URL|url/i);
  });

  it('classifies an unreachable endpoint as a retryable transport error', async () => {
    const manager = new McpManager();
    manager.addServer(httpConfig('http://127.0.0.1:9/mcp'));
    const [status] = await manager.start();
    expect(status?.connected).toBe(false);
    expect(status?.error?.code).toBe('mcp.transport_error');
    expect(status?.error?.message).toMatch(/POST/);
    await manager.close();
  }, 60_000);
});
