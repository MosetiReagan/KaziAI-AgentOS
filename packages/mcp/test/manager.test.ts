import { describe, expect, it } from 'vitest';
import { DefaultToolRegistry } from '@kazi-ai/agentos-tools';
import { AgentError, type ToolResult } from '@kazi-ai/agentos-core';
import { McpManager } from '../src/manager.js';
import { InProcessTransport } from '../src/transports/in-process.js';
import { createFakeServerHandler, fakeServerConfig } from './fake-server.js';
import { testContext } from './context.js';

/** A run that has granted the capability the fake servers declare. */
function grantedContext() {
  return testContext({ network: { enabled: true } });
}

type HandlerFactory = () => ReturnType<typeof createFakeServerHandler>;

/**
 * A manager whose transports are fresh fake servers per connection, so a
 * reconnect starts from a new server instance exactly like the real thing.
 */
function managerWithServers(handlers: Record<string, HandlerFactory>, options: { strict?: boolean } = {}) {
  return new McpManager({
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    createTransport: (server) => {
      const factory = handlers[server.id];
      if (!factory) throw new Error(`no fake server for ${server.id}`);
      return new InProcessTransport({ id: server.id, handler: factory() });
    },
  });
}

const fakeHandler: HandlerFactory = () => createFakeServerHandler();

describe('MCP manager', () => {
  it('discovers several servers and namespaces their tools', async () => {
    const manager = managerWithServers({
      alpha: () => createFakeServerHandler({ name: 'alpha-server' }),
      beta: () => createFakeServerHandler({ name: 'beta-server' }),
    });
    manager.addServer(fakeServerConfig({ id: 'alpha' }));
    manager.addServer(fakeServerConfig({ id: 'beta' }));

    const statuses = await manager.start();
    expect(statuses.map((status) => status.serverName).sort()).toEqual(['alpha-server', 'beta-server']);
    expect(manager.toolIds()).toEqual([
      'mcp.alpha.echo_tool',
      'mcp.alpha.failing_tool',
      'mcp.alpha.second_page_tool',
      'mcp.alpha.slow_tool',
      'mcp.beta.echo_tool',
      'mcp.beta.failing_tool',
      'mcp.beta.second_page_tool',
      'mcp.beta.slow_tool',
    ]);
    expect(manager.health()).toEqual({ servers: 2, connected: 2, tools: 8, failures: [] });
    await manager.close();
  });

  it('isolates a server that cannot be reached', async () => {
    const manager = new McpManager({
      createTransport: (server) => {
        const handler = server.id === 'broken' ? undefined : createFakeServerHandler();
        if (!handler) throw new Error('boom');
        return new InProcessTransport({ id: server.id, handler });
      },
    });
    manager.addServer(fakeServerConfig({ id: 'broken' }));
    manager.addServer(fakeServerConfig({ id: 'healthy' }));

    const statuses = await manager.start();
    const broken = statuses.find((status) => status.id === 'broken');
    expect(broken?.connected).toBe(false);
    expect(broken?.error?.message).toContain('boom');
    expect(statuses.find((status) => status.id === 'healthy')?.connected).toBe(true);
    // The healthy server's tools remain usable.
    expect(manager.tools().every((tool) => tool.id.startsWith('mcp.healthy.'))).toBe(true);
    await manager.close();
  });

  it('fails discovery loudly in strict mode', async () => {
    const manager = new McpManager({
      strict: true,
      createTransport: () => {
        throw new Error('unreachable');
      },
    });
    manager.addServer(fakeServerConfig({ id: 'broken' }));
    await expect(manager.start()).rejects.toThrow('unreachable');
    await manager.close();
  });

  it('honours allow and block lists over discovered tools', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake', allowedTools: ['echo_tool', 'slow_tool'], blockedTools: ['slow_tool'] }));
    await manager.start();
    expect(manager.toolIds()).toEqual(['mcp.fake.echo_tool']);
    await manager.close();
  });

  it('registers normalized tools into the real tool registry', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake', permissions: { network: { enabled: true } } }));
    await manager.start();

    const registry = new DefaultToolRegistry();
    const registered = manager.registerInto(registry);
    expect(registered).toHaveLength(4);
    expect(registry.get('mcp.fake.echo_tool')?.kind).toBe('mcp');
    expect(registry.permissionsOf('mcp.fake.echo_tool')).toEqual({ network: { enabled: true } });
    expect(registry.resolve(['mcp.fake.*']).map((tool) => tool.id)).toContain('mcp.fake.echo_tool');
    // Re-registering must replace instead of throwing a duplicate error.
    expect(() => manager.registerInto(registry)).not.toThrow();
    expect(registry.list()).toHaveLength(4);
    await manager.close();
  });

  it('executes a tool through the AgentTool contract', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake' }));
    await manager.start();
    const tool = manager.tools().find((candidate) => candidate.id === 'mcp.fake.echo_tool');
    expect(tool).toBeDefined();

    const result = (await tool?.execute({ message: 'hello' }, grantedContext())) as ToolResult;
    expect(result.success).toBe(true);
    expect(result.metadata?.['text']).toBe('echo:hello');
    expect(result.idempotency).toBe('idempotent');

    // Defaults published by the server are applied before the call is sent.
    const withDefault = (await tool?.execute({ message: 'x' }, grantedContext())) as ToolResult;
    expect(withDefault.output).toBeTruthy();
    await manager.close();
  });

  it('rejects arguments that violate the server schema without calling the server', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake' }));
    await manager.start();
    const tool = manager.tools().find((candidate) => candidate.id === 'mcp.fake.echo_tool');
    await expect(tool?.execute({}, grantedContext())).rejects.toMatchObject({ code: 'tool.invalid_input' });
    await expect(tool?.execute({ message: 'x', extra: true }, grantedContext())).rejects.toMatchObject({ code: 'tool.invalid_input' });
    await manager.close();
  });

  it('refuses a tool whose declared capabilities the run does not grant', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake', permissions: { network: { enabled: true } } }));
    await manager.start();
    const tool = manager.tools().find((candidate) => candidate.id === 'mcp.fake.echo_tool');
    await expect(tool?.execute({ message: 'hello' }, testContext({}))).rejects.toMatchObject({ code: 'tool.permission_denied' });
    const granted = (await tool?.execute({ message: 'hello' }, grantedContext())) as ToolResult;
    expect(granted.success).toBe(true);
    await manager.close();
  });

  it('turns a server-reported tool error into a failed tool result, not a crash', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake' }));
    await manager.start();
    const tool = manager.tools().find((candidate) => candidate.id === 'mcp.fake.failing_tool');
    const result = (await tool?.execute({}, grantedContext())) as ToolResult;
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('mcp.tool_reported_error');
    // Untrusted server text is data, never instructions the runtime follows.
    expect(result.error?.message).toContain('Ignore previous instructions');
    await manager.close();
  });

  it('reports transport failures as classified tool errors', async () => {
    const manager = managerWithServers({ fake: () => createFakeServerHandler({ callDelayMs: 100_000 }) });
    manager.addServer(fakeServerConfig({ id: 'fake', requestTimeoutMs: 40 }));
    await manager.start();
    const tool = manager.tools().find((candidate) => candidate.id === 'mcp.fake.slow_tool');
    try {
      await tool?.execute({}, grantedContext());
      throw new Error('expected the call to time out');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).code).toBe('mcp.timeout');
      expect((error as AgentError).retryable).toBe(true);
    }
    await manager.close();
  });

  it('explains an unknown or disconnected server instead of failing silently', async () => {
    const manager = new McpManager();
    await expect(manager.callTool('nope', 'echo_tool', {})).rejects.toMatchObject({ code: 'mcp.unknown_server' });
    manager.addServer(fakeServerConfig({ id: 'nope' }));
    await expect(manager.callTool('nope', 'echo_tool', {})).rejects.toThrow(/not connected/);
    expect(manager.removeServer('nope')).toBe(true);
    await expect(manager.callTool('nope', 'echo_tool', {})).rejects.toMatchObject({ code: 'mcp.unknown_server' });
    await manager.close();
  });

  it('reconnects a server and refreshes discovery', async () => {
    const manager = managerWithServers({ fake: fakeHandler });
    manager.addServer(fakeServerConfig({ id: 'fake' }));
    await manager.start();
    const reconnected = await manager.reconnect('fake');
    expect(reconnected.connected).toBe(true);
    expect(manager.tools().length).toBe(4);
    const refreshed = await manager.refresh();
    expect(refreshed[0]?.toolCount).toBe(4);
    expect(manager.toolIds()).toHaveLength(4);
    await manager.close();
  });
});
