import { describe, expect, it } from 'vitest';
import { mergePermissions, restrictPermissions } from '../src/index.js';

/**
 * Permissions are combined by narrowing only. A layer that says nothing must
 * never widen what an earlier layer granted, and a layer that says `false` must
 * always win (spec §21, §47).
 */
describe('merging permission layers', () => {
  it('intersects booleans instead of letting the last layer win', () => {
    const merged = mergePermissions([
      { filesystem: { read: true, write: true } },
      { filesystem: { write: true } },
    ]);
    expect(merged.filesystem).toEqual({ read: true, write: true });
  });

  it('lets a later layer narrow a grant', () => {
    const merged = mergePermissions([
      { network: { enabled: true, allowedHosts: ['a.com', 'b.com'] } },
      { network: { allowedHosts: ['b.com'] } },
    ]);
    expect(merged.network?.enabled).toBe(true);
    expect(merged.network?.allowedHosts).toEqual(['b.com']);
  });

  it('never re-opens a capability a layer switched off', () => {
    const merged = mergePermissions([
      { terminal: { execute: false } },
      { terminal: { execute: true } },
    ]);
    expect(merged.terminal?.execute).toBe(false);
  });

  it('keeps an isolation waiver through a layer that has no opinion', () => {
    const merged = mergePermissions([
      { terminal: { execute: true, allowUnisolated: true } },
      undefined,
    ]);
    expect(merged.terminal).toEqual({ execute: true, allowUnisolated: true });
  });

  it('lets a run withdraw an isolation waiver the definition granted', () => {
    const merged = mergePermissions([
      { terminal: { execute: true, allowUnisolated: true } },
      { terminal: { allowUnisolated: false } },
    ]);
    expect(merged.terminal?.allowUnisolated).toBe(false);
  });

  it('unions deny lists and intersects allow lists', () => {
    const merged = mergePermissions([
      { terminal: { denyCommands: ['rm'], allowCommands: ['npm', 'node'] } },
      { terminal: { denyCommands: ['curl'], allowCommands: ['npm'] } },
    ]);
    expect(merged.terminal?.denyCommands?.sort()).toEqual(['curl', 'rm']);
    expect(merged.terminal?.allowCommands).toEqual(['npm']);
  });
});

describe('restricting a grant to what a tool asked for', () => {
  it('passes the run grant through when the tool declares the family but not the flag', () => {
    const restricted = restrictPermissions(
      { terminal: { execute: true, allowUnisolated: true } },
      { terminal: { execute: true } },
    );
    expect(restricted.terminal).toEqual({ execute: true, allowUnisolated: true });
  });

  it('never invents a grant the run did not make', () => {
    const restricted = restrictPermissions(
      { terminal: { execute: true } },
      { terminal: { execute: true } },
    );
    expect(restricted.terminal?.allowUnisolated).toBeUndefined();
  });

  it('lets a tool refuse an isolation waiver', () => {
    const restricted = restrictPermissions(
      { terminal: { execute: true, allowUnisolated: true } },
      { terminal: { execute: true, allowUnisolated: false } },
    );
    expect(restricted.terminal?.allowUnisolated).toBe(false);
  });

  it('keeps a granted family the tool did not ask about, so direct reads still work', () => {
    // The run's grant is the ceiling and a tool's declaration only narrows it:
    // a tool that consults `context.permissions.network` itself must still see
    // what the run granted.
    const restricted = restrictPermissions(
      { network: { enabled: true }, terminal: { execute: true } },
      { terminal: { execute: true } },
    );
    expect(restricted).toEqual({ network: { enabled: true }, terminal: { execute: true } });
  });

  it('honours a tool that switches a capability off', () => {
    const restricted = restrictPermissions(
      { network: { enabled: true } },
      { network: { enabled: false } },
    );
    expect(restricted.network?.enabled).toBe(false);
  });
});
