import { describe, expect, it } from 'vitest';
import { McpClient, type McpClientOptions } from '../src/client.js';
import { createFakeServerHandler, inProcessClientOptions } from './fake-server.js';

function connectClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}

describe('MCP client', () => {
  it('performs the handshake and reports the server identity', async () => {
    const client = connectClient(inProcessClientOptions('fake'));
    const server = await client.connect();
    expect(server.protocolVersion).toBe('2025-06-18');
    expect(server.serverInfo.name).toBe('fake-server');
    expect(client.capabilities.tools).toBeTruthy();
    // connect() is idempotent: a second call must not re-handshake.
    expect(await client.connect()).toEqual(server);
    await client.close();
  });

  it('walks paginated tool listings', async () => {
    const client = connectClient(inProcessClientOptions('fake'));
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo_tool', 'slow_tool', 'failing_tool', 'second_page_tool']);
    expect(tools[0]?.inputSchema?.['type']).toBe('object');
    await client.close();
  });

  it('skips discovery for capabilities the server does not advertise', async () => {
    const handler = createFakeServerHandler({ capabilities: { tools: {} } });
    const client = connectClient(inProcessClientOptions('fake', handler));
    await client.connect();
    expect(await client.listTools()).toHaveLength(4);
    // No resources or prompts capability: those calls must not even be sent.
    expect(await client.listResources()).toEqual([]);
    expect(await client.listPrompts()).toEqual([]);
    await client.close();
  });

  it('calls a tool and returns its raw result', async () => {
    const client = connectClient(inProcessClientOptions('fake'));
    await client.connect();
    const result = await client.callTool('echo_tool', { message: 'hello' });
    expect(result.structuredContent).toEqual({ echoed: 'hello', name: 'echo_tool' });
    expect(result.content?.[0]?.text).toBe('echo:hello');
    await client.close();
  });

  it('times out a call the server leaves hanging', async () => {
    const client = connectClient(inProcessClientOptions('fake', createFakeServerHandler({ callDelayMs: 200 }), { requestTimeoutMs: 30 }));
    await client.connect();
    await expect(client.callTool('slow_tool', {})).rejects.toMatchObject({ code: 'mcp.timeout', retryable: true });
    await client.close();
  });

  it('surfaces a JSON-RPC error from a tool call', async () => {
    const client = connectClient(inProcessClientOptions('fake', createFakeServerHandler({ failCalls: true })));
    await client.connect();
    await expect(client.callTool('echo_tool', { message: 'x' })).rejects.toMatchObject({ code: 'mcp.protocol_error' });
    await client.close();
  });

  it('reads resources and prompts', async () => {
    const client = connectClient(inProcessClientOptions('fake'));
    await client.connect();
    const resources = await client.listResources();
    expect(resources[0]?.uri).toBe('file:///workspace/README.md');
    const contents = await client.readResource('file:///workspace/README.md');
    expect(contents[0]?.text).toBe('hello from resource');
    const prompts = await client.listPrompts();
    expect(prompts[0]?.name).toBe('review');
    const prompt = await client.getPrompt('review', { diff: 'x' });
    expect(prompt.messages[0]?.role).toBe('user');
    await client.close();
  });

  it('answers a server-initiated request through the configured handler', async () => {
    const client = connectClient(
      inProcessClientOptions('fake', createFakeServerHandler(), {
        onServerRequest: (request) => (request.method === 'roots/list' ? { roots: [{ uri: 'file:///ws', name: 'ws' }] } : undefined),
      }),
    );
    await client.connect();
    expect(await client.ping()).toBe(true);
    await client.close();
  });

  it('refuses to start when the server name is not advertised and the payload is unusable', async () => {
    const client = connectClient(
      inProcessClientOptions('fake', (_message, reply) => reply({ jsonrpc: '2.0', id: 1, result: { nonsense: true } })),
    );
    await expect(client.connect()).rejects.toMatchObject({ code: 'mcp.protocol_error' });
    await client.close();
  });
});
