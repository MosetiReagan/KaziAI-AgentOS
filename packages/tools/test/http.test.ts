import { describe, expect, it } from 'vitest';
import { assertPublicHost, createHttpRequestTool, createTestToolContext, isBlockedAddress } from '../src/index.js';

const networkPermissions = { network: { enabled: true } };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

const publicResolve = async (): Promise<string[]> => ['93.184.216.34'];

describe('SSRF defenses', () => {
  it('blocks loopback, link-local, private and metadata ranges', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
      expect(isBlockedAddress(address)).toBe(true);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isBlockedAddress(address)).toBe(false);
    }
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    await expect(assertPublicHost('metadata.example', async () => ['169.254.169.254'])).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('blocks literal internal hostnames without a DNS lookup', async () => {
    await expect(assertPublicHost('localhost')).rejects.toMatchObject({ code: 'tool.invalid_input' });
    await expect(assertPublicHost('metadata.google.internal')).rejects.toMatchObject({ code: 'tool.invalid_input' });
  });

  it('treats a bracketed IPv6 literal as an address, not a hostname', async () => {
    // `URL.hostname` hands us `[::1]`, and `isIP('[::1]')` is 0. Previously the
    // literal skipped the address check and went to DNS instead, which is both
    // the wrong path and a confusing error.
    let lookedUp = false;
    await expect(
      assertPublicHost('[::1]', async () => {
        lookedUp = true;
        return ['93.184.216.34'];
      }),
    ).rejects.toThrow(/blocked range/);
    expect(lookedUp).toBe(false);

    await expect(assertPublicHost('[fd00::1]')).rejects.toThrow(/blocked range/);
    // A public IPv6 literal still gets through.
    await expect(assertPublicHost('[2606:2800:220:1:248:1893:25c8:1946]')).resolves.toBeUndefined();
  });
});

describe('http tool', () => {
  it('refuses the cloud metadata endpoint by default', async () => {
    const context = await createTestToolContext({ permissions: networkPermissions });
    const tool = await createHttpRequestTool();
    await expect(tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('refuses localhost even when the network permission is granted', async () => {
    const context = await createTestToolContext({ permissions: networkPermissions });
    const tool = await createHttpRequestTool();
    await expect(tool.execute({ url: 'http://localhost:8080/admin' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('denies the request when network access is not granted', async () => {
    const context = await createTestToolContext({ permissions: {} });
    const tool = await createHttpRequestTool({ resolveHost: publicResolve });
    await expect(tool.execute({ url: 'https://example.com' }, context)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
  });

  it('honours the host allow list', async () => {
    const context = await createTestToolContext({
      permissions: { network: { enabled: true, allowedHosts: ['api.example.com'] } },
    });
    const tool = await createHttpRequestTool({ resolveHost: publicResolve, fetchImpl: async () => jsonResponse({ ok: true }) });
    await expect(tool.execute({ url: 'https://other.example.com' }, context)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
    const result = await tool.execute({ url: 'https://api.example.com/health' }, context);
    expect(result.success).toBe(true);
  });

  it('performs a request and normalizes the JSON body', async () => {
    const context = await createTestToolContext({ permissions: networkPermissions });
    const tool = await createHttpRequestTool({
      resolveHost: publicResolve,
      fetchImpl: async () => jsonResponse({ status: 'ok', items: [1, 2, 3] }),
    });
    const result = await tool.execute({ url: 'https://example.com/api', method: 'POST', body: '{"a":1}' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ status: 200, content_type: 'application/json' });
    expect(JSON.stringify(result.output)).toContain('"status":"ok"');
  });

  it('does not follow redirects by default', async () => {
    const context = await createTestToolContext({ permissions: networkPermissions });
    const tool = await createHttpRequestTool({
      resolveHost: publicResolve,
      fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    });
    const result = await tool.execute({ url: 'https://example.com/redirect' }, context);
    expect(result.output).toMatchObject({ status: 302, redirected: true });
    expect(JSON.stringify(result.output)).toContain('not followed');
  });

  it('resolves secret:// header references instead of accepting raw secrets', async () => {
    const context = await createTestToolContext({
      permissions: networkPermissions,
      secrets: { 'github/token': 'resolved-token-value' },
    });
    let sentAuthorization: string | undefined;
    const tool = await createHttpRequestTool({
      resolveHost: publicResolve,
      fetchImpl: async (_url, init) => {
        sentAuthorization = (init?.headers as Record<string, string>)['authorization'];
        return jsonResponse({ ok: true });
      },
    });
    await tool.execute(
      { url: 'https://api.example.com', headers: { authorization: 'secret://github/token' } },
      context,
    );
    expect(sentAuthorization).toBe('resolved-token-value');
  });

  it('rejects credentials embedded in the URL', async () => {
    const context = await createTestToolContext({ permissions: networkPermissions });
    const tool = await createHttpRequestTool({ resolveHost: publicResolve });
    await expect(tool.execute({ url: 'https://user:pass@example.com' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('reports timeout as a retryable tool error', async () => {
    const context = await createTestToolContext({ permissions: networkPermissions });
    const tool = await createHttpRequestTool({
      resolveHost: publicResolve,
      fetchImpl: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    await expect(tool.execute({ url: 'https://example.com', timeout_ms: 50 }, context)).rejects.toMatchObject({
      code: 'tool.timeout',
      retryable: true,
    });
  });
});

