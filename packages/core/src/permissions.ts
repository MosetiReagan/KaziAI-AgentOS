import type { ToolPermissions } from './contracts/tool.js';

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

