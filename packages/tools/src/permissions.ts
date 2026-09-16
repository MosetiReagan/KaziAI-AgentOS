import type { ToolPermissions } from '@kazi-ai/agentos-core';
import { deepMerge } from '@kazi-ai/agentos-core';

/**
 * Permissions are intersected, never unioned: a run may only ever use less
 * capability than the agent declares. Default-deny on anything unspecified.
 */
export function mergePermissions(layers: Array<ToolPermissions | undefined>): ToolPermissions {
  const defined = layers.filter((layer): layer is ToolPermissions => layer !== undefined);
  if (defined.length === 0) return {};
  const merged: ToolPermissions = {};
  for (const layer of defined) {
    if (layer.filesystem) {
      merged.filesystem = {
        read: intersectBool(merged.filesystem?.read, layer.filesystem.read),
        write: intersectBool(merged.filesystem?.write, layer.filesystem.write),
        delete: intersectBool(merged.filesystem?.delete, layer.filesystem.delete),
        roots: intersectList(merged.filesystem?.roots, layer.filesystem.roots),
      };
    }
    if (layer.terminal) {
      merged.terminal = {
        execute: intersectBool(merged.terminal?.execute, layer.terminal.execute),
        allowCommands: intersectList(merged.terminal?.allowCommands, layer.terminal.allowCommands),
        denyCommands: unionList(merged.terminal?.denyCommands, layer.terminal.denyCommands),
      };
    }
    if (layer.network) {
      merged.network = {
        enabled: intersectBool(merged.network?.enabled, layer.network.enabled),
        allowedHosts: intersectList(merged.network?.allowedHosts, layer.network.allowedHosts),
        methods: intersectList(merged.network?.methods, layer.network.methods),
      };
    }
    if (layer.git) {
      merged.git = {
        read: intersectBool(merged.git?.read, layer.git.read),
        commit: intersectBool(merged.git?.commit, layer.git.commit),
        push: intersectBool(merged.git?.push, layer.git.push),
      };
    }
    if (layer.database) {
      merged.database = {
        read: intersectBool(merged.database?.read, layer.database.read),
        write: intersectBool(merged.database?.write, layer.database.write),
        connections: intersectList(merged.database?.connections, layer.database.connections),
      };
    }
  }
  return stripUndefined(merged);
}

function intersectBool(current: boolean | undefined, next: boolean | undefined): boolean | undefined {
  if (current === false || next === false) return false;
  if (current === undefined) return next;
  if (next === undefined) return current;
  return current && next;
}

function intersectList(current: string[] | undefined, next: string[] | undefined): string[] | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return current.filter((item) => next.includes(item));
}

function unionList(current: string[] | undefined, next: string[] | undefined): string[] | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return [...new Set([...current, ...next])];
}

function stripUndefined(permissions: ToolPermissions): ToolPermissions {
  const out: ToolPermissions = {};
  for (const [key, value] of Object.entries(permissions)) {
    const cleaned = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined));
    if (Object.keys(cleaned).length > 0) (out as Record<string, unknown>)[key] = cleaned;
  }
  return out;
}

export interface PermissionCheck {
  allowed: boolean;
  reason?: string;
}

export const DENIED: PermissionCheck = { allowed: false };

export function canReadFilesystem(permissions: ToolPermissions): PermissionCheck {
  return permissions.filesystem?.read === true
    ? { allowed: true }
    : { allowed: false, reason: 'filesystem read is not permitted for this run' };
}

export function canWriteFilesystem(permissions: ToolPermissions): PermissionCheck {
  return permissions.filesystem?.write === true
    ? { allowed: true }
    : { allowed: false, reason: 'filesystem write is not permitted for this run' };
}

export function canDeleteFilesystem(permissions: ToolPermissions): PermissionCheck {
  return permissions.filesystem?.delete === true
    ? { allowed: true }
    : { allowed: false, reason: 'filesystem delete is not permitted for this run' };
}

export function canExecuteTerminal(permissions: ToolPermissions, command: string): PermissionCheck {
  if (permissions.terminal?.execute !== true) {
    return { allowed: false, reason: 'terminal execution is not permitted for this run' };
  }
  const deny = permissions.terminal.denyCommands ?? [];
  for (const pattern of deny) {
    if (matchesCommand(pattern, command)) {
      return { allowed: false, reason: `command matches denied pattern "${pattern}"` };
    }
  }
  const allow = permissions.terminal.allowCommands ?? [];
  if (allow.length > 0 && !allow.some((pattern) => matchesCommand(pattern, command))) {
    return { allowed: false, reason: 'command is not in the allow list for this run' };
  }
  return { allowed: true };
}

export function canUseNetwork(permissions: ToolPermissions, host: string): PermissionCheck {
  if (permissions.network?.enabled !== true) {
    return { allowed: false, reason: 'network access is not permitted for this run' };
  }
  const allowedHosts = permissions.network.allowedHosts ?? [];
  if (allowedHosts.length === 0) return { allowed: true };
  const matches = allowedHosts.some((pattern) => {
    if (pattern === host) return true;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
    return false;
  });
  return matches ? { allowed: true } : { allowed: false, reason: `host ${host} is not in the allow list` };
}

export function canUseGit(permissions: ToolPermissions, operation: 'read' | 'commit' | 'push'): PermissionCheck {
  const value = permissions.git?.[operation];
  return value === true ? { allowed: true } : { allowed: false, reason: `git ${operation} is not permitted for this run` };
}

export function canUseDatabase(permissions: ToolPermissions, operation: 'read' | 'write'): PermissionCheck {
  const value = permissions.database?.[operation];
  return value === true ? { allowed: true } : { allowed: false, reason: `database ${operation} is not permitted for this run` };
}

/** Simple, predictable matcher: exact, prefix, or `*` wildcard. */
export function matchesCommand(pattern: string, command: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return command.startsWith(pattern.slice(0, -1));
  return command === pattern;
}

export { deepMerge };

