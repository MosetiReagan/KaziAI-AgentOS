import { describe, expect, it } from 'vitest';
import {
  DefaultToolRegistry,
  canExecuteTerminal,
  matchesCommand,
  mergePermissions,
  restrictPermissions,
} from '../src/index.js';
import { createBuiltinTools } from '../src/index.js';

describe('tool registry', () => {
  it('registers built-in tools and resolves namespaces', async () => {
    const registry = new DefaultToolRegistry(await createBuiltinTools());
    expect(registry.ids()).toContain('filesystem.read');
    expect(registry.ids()).toContain('terminal.exec');
    expect(registry.ids()).toContain('http.request');
    expect(registry.resolve(['filesystem.*']).map((tool) => tool.id)).toContain('filesystem.edit');
    expect(registry.resolve(['terminal.exec'])).toHaveLength(1);
    expect(registry.resolve(['*']).length).toBe(registry.list().length);
    expect(registry.resolve(['does.not.exist'])).toHaveLength(0);
  });

  it('rejects duplicate registration instead of shadowing a tool', async () => {
    const registry = new DefaultToolRegistry();
    const [tool] = await createBuiltinTools({ filesystem: {} });
    if (!tool) throw new Error('expected at least one built-in filesystem tool');
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/already registered/);
    registry.override(tool);
    expect(registry.require(tool.id)).toBe(tool);
  });

  it('requires lowercase namespaced ids', () => {
    const registry = new DefaultToolRegistry();
    expect(() => registry.register({ id: 'FilesystemRead', description: '', inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) }, execute: async () => ({ success: true, output: null }) })).toThrow(
      /Invalid tool id/,
    );
  });

  it('emits provider tool definitions with JSON Schema parameters', async () => {
    const registry = new DefaultToolRegistry(await createBuiltinTools());
    const definitions = registry.toDefinitions(['filesystem.read']);
    expect(definitions[0]?.name).toBe('filesystem.read');
    expect(definitions[0]?.parameters).toBeTruthy();
  });
});

describe('permission merging', () => {
  it('intersects capability instead of unioning it', () => {
    const merged = mergePermissions([
      { filesystem: { read: true, write: true }, terminal: { execute: true } },
      { filesystem: { write: false }, network: { enabled: false } },
    ]);
    expect(merged.filesystem).toMatchObject({ read: true, write: false });
    expect(merged.terminal).toMatchObject({ execute: true });
    expect(merged.network).toMatchObject({ enabled: false });
  });

  it('denies by default when nothing is granted', () => {
    expect(mergePermissions([undefined, {}])).toEqual({});
    expect(canExecuteTerminal({}, 'ls').allowed).toBe(false);
  });

  it('never lets a tool widen the capability the run granted', () => {
    const effective = restrictPermissions(
      { filesystem: { read: true } },
      { filesystem: { read: true, write: true }, network: { enabled: true } },
    );
    expect(effective.filesystem).toMatchObject({ read: true, write: false });
    expect(effective.network).toMatchObject({ enabled: false });
  });

  it('lets a tool narrow itself but not open a capability the run granted', () => {
    const narrowed = restrictPermissions({ git: { read: true, commit: true, push: true } }, { git: { push: false } });
    expect(narrowed.git).toMatchObject({ read: true, commit: true, push: false });
  });

  it('intersects allow lists, unions deny lists and never widens a list to empty', () => {
    const effective = restrictPermissions(
      { terminal: { execute: true, allowCommands: ['ls', 'git*'] }, network: { enabled: true, allowedHosts: ['api.example.com'] } },
      { terminal: { allowCommands: ['git*', 'rm*'], denyCommands: ['git push*'] }, network: { allowedHosts: ['other.example.com'] } },
    );
    expect(effective.terminal?.allowCommands).toEqual(['git*']);
    expect(effective.terminal?.denyCommands).toEqual(['git push*']);
    // The intersection is empty, so the run's own list stands: still no wider
    // than what the run granted.
    expect(effective.network?.allowedHosts).toEqual(['api.example.com']);
  });

  it('denies everything when the run grants nothing', () => {
    expect(restrictPermissions(undefined, { terminal: { execute: true } })).toEqual({
      terminal: { execute: false },
    });
    expect(restrictPermissions({}, undefined)).toEqual({});
  });

  it('enforces deny lists over allow lists', () => {
    const permissions = { terminal: { execute: true, allowCommands: ['npm*'], denyCommands: ['npm publish*'] } };
    expect(canExecuteTerminal(permissions, 'npm test').allowed).toBe(true);
    expect(canExecuteTerminal(permissions, 'npm publish').allowed).toBe(false);
    expect(canExecuteTerminal(permissions, 'rm').allowed).toBe(false);
    expect(matchesCommand('npm*', 'npm test')).toBe(true);
    expect(matchesCommand('ls', 'ls -la')).toBe(false);
  });
});

