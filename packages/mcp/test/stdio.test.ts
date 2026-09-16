import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpManager } from '../src/manager.js';
import { StdioTransport } from '../src/transports/stdio.js';

const serverPath = fileURLToPath(new URL('./fixtures/echo-server.mjs', import.meta.url));

function stdioConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'echo',
    transport: { type: 'stdio' as const, command: process.execPath, args: [serverPath] },
    risk: 'MEDIUM' as const,
    permissions: {},
    ...overrides,
  };
}

describe('stdio transport against a real child process', () => {
  it('drives the full lifecycle: handshake, discovery, invocation, shutdown', async () => {
    const manager = new McpManager();
    manager.addServer(stdioConfig());
    const [status] = await manager.start();

    expect(status?.connected).toBe(true);
    expect(status?.serverName).toBe('echo-server');
    expect(status?.toolCount).toBe(2);
    expect(manager.toolIds()).toEqual(['mcp.echo.add', 'mcp.echo.crash']);

    const sum = await manager.callTool('echo', 'add', { a: 2, b: 3 });
    expect(sum).toEqual({ sum: 5 });

    const resources = await manager.listResources('echo');
    expect(resources[0]?.uri).toBe('echo://greeting');
    const contents = await manager.readResource('echo', 'echo://greeting');
    expect(contents[0]?.text).toBe('hello from a real process');

    const prompts = await manager.listPrompts('echo');
    expect(prompts[0]?.name).toBe('greet');

    await manager.close();
    expect(manager.status()[0]?.connected).toBe(false);
  }, 60_000);

  it('classifies a server process that dies mid-request', async () => {
    const transport = new StdioTransport({ id: 'echo', command: process.execPath, args: [serverPath] });
    const manager = new McpManager({ createTransport: () => transport, strict: true });
    manager.addServer(stdioConfig({ id: 'echo', allowedTools: ['crash'] }));
    await manager.start();

    const tools = manager.tools();
    expect(tools).toHaveLength(1);
    const crash = tools[0];
    expect(crash?.defaultIdempotency).toBe('non-idempotent');

    await expect(
      crash?.execute({}, {
        runId: 'run_test' as never,
        organizationId: 'org',
        projectId: 'prj',
        workspaceDir: '/tmp',
        permissions: {},
        logger: console as never,
        clock: { now: () => Date.now(), iso: () => new Date().toISOString() } as never,
        signal: new AbortController().signal,
        secrets: { resolve: async () => '', has: async () => false },
        environment: { execute: async () => ({ exitCode: 1, stdout: '', stderr: '', durationMs: 0, timedOut: false, stdoutTruncated: false, stderrTruncated: false }), workspaceDir: () => '/tmp' },
        artifacts: { write: async () => ({ artifactId: 'a', sha256: '0', size: 0 }) },
      }),
    ).rejects.toBeDefined();

    await transport.close();
    await manager.close();
  }, 60_000);

  it('reports a diagnostic when the command does not exist', async () => {
    const manager = new McpManager();
    manager.addServer(stdioConfig({ id: 'missing', transport: { type: 'stdio', command: '/definitely/not/a/binary', args: [] } }));
    const statuses = await manager.start();
    expect(statuses[0]?.connected).toBe(false);
    expect(statuses[0]?.error?.message).toMatch(/failed to spawn|failed to start/);
    expect(manager.tools()).toEqual([]);
    await manager.close();
  }, 60_000);
});
