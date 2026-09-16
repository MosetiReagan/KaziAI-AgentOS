import { describe, expect, it } from 'vitest';
import {
  idempotencyFor,
  mcpToolId,
  normalizeToolResult,
  riskFor,
  sanitizeSegment,
  toolDescription,
  unmetPermissions,
} from '../src/normalize.js';
import { echoTool, failingTool, slowTool } from './fake-server.js';

describe('MCP normalization', () => {
  it('namespaces tool ids the way the registry expects', () => {
    expect(mcpToolId('github', 'create_issue')).toBe('mcp.github.create_issue');
    expect(mcpToolId('Filesystem Server', 'read/file')).toBe('mcp.filesystem_server.read_file');
    expect(mcpToolId('weird', '...')).toBe('mcp.weird.unnamed');
    expect(sanitizeSegment('GitHub MCP')).toBe('github_mcp');
  });

  it('maps server annotations onto the runtime idempotency model', () => {
    expect(idempotencyFor(echoTool, [])).toBe('idempotent');
    expect(idempotencyFor(slowTool, [])).toBe('non-idempotent');
    expect(idempotencyFor(slowTool, ['slow_tool'])).toBe('idempotent');
    expect(idempotencyFor({ ...slowTool, annotations: { destructiveHint: false } }, [])).toBe('retry-safe');
    // A destructive tool is HIGH risk even when the server is configured lower.
    expect(riskFor(failingTool, 'MEDIUM')).toBe('HIGH');
    expect(riskFor(slowTool, 'HIGH')).toBe('HIGH');
    expect(riskFor(echoTool, 'HIGH')).toBe('MEDIUM');
  });

  it('labels the description with the server it came from', () => {
    expect(toolDescription(echoTool, 'fake')).toContain('[mcp:fake]');
  });

  it('normalizes content blocks without streaming blobs into context', () => {
    const normalized = normalizeToolResult({
      content: [
        { type: 'text', text: 'plain text' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///x.txt', mimeType: 'text/plain', text: 'body' } },
      ],
      structuredContent: { ok: true },
    });
    const output = normalized.output as { content: Array<Record<string, unknown>>; structured?: unknown };
    expect(output.content[0]).toEqual({ type: 'text', text: 'plain text' });
    expect(output.content[1]).toEqual({ type: 'image', mimeType: 'image/png', bytes: 5 });
    expect(output.content[2]).toEqual({ type: 'resource', uri: 'file:///x.txt', mimeType: 'text/plain', text: 'body' });
    expect(output.structured).toEqual({ ok: true });
    expect(normalized.text).toContain('plain text');
    expect(normalized.text).toContain('body');
    expect(normalized.metadata['binaryBytes']).toBe(5);
  });

  it('flags server-reported errors and keeps their text as data', () => {
    const normalized = normalizeToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true });
    expect(normalized.metadata['isError']).toBe(true);
    expect(normalized.text).toBe('boom');
  });

  it('bounds huge tool output before it reaches the context window', () => {
    const normalized = normalizeToolResult({ content: [{ type: 'text', text: 'x'.repeat(200_000) }] });
    expect(normalized.truncated).toBe(true);
    expect(JSON.stringify(normalized.output).length).toBeLessThan(70_000);
  });

  it('reports which declared capabilities the run has not granted', () => {
    expect(unmetPermissions({ network: { enabled: true } }, {})).toEqual(['network.enabled']);
    expect(unmetPermissions({ network: { enabled: true } }, { network: { enabled: true } })).toEqual([]);
    expect(unmetPermissions({ filesystem: { read: true, write: true } }, { filesystem: { read: true } })).toEqual([
      'filesystem.write',
    ]);
  });
});
