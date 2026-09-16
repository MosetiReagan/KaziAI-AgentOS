import type { ToolPermissions } from '@kazi-ai/agentos-core';
import { deepMerge, mergePermissions, restrictPermissions } from '@kazi-ai/agentos-core';

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

export { deepMerge, mergePermissions, restrictPermissions };

