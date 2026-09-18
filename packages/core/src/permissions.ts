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
        // An explicit `false` in any layer narrows; a layer with no opinion
        // does not silently open the capability up (spec §21).
        allowUnisolated: intersectBool(
          merged.terminal?.allowUnisolated,
          layer.terminal.allowUnisolated,
        ),
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

/**
 * Hand a tool the capabilities it may use: the run's grant, restricted by what
 * the tool declares it needs.
 *
 * `mergePermissions` treats an unspecified layer as "inherit from the other
 * layer", which is what stacking policy layers wants. A tool declaration is not
 * a policy layer though: a tool must never be *given* a capability the run did
 * not grant just because the tool listed it. So here the run's grant is
 * authoritative and anything it does not state is denied, while a tool may
 * narrow itself further by declaring a capability `false`. Lists (allowed
 * hosts, command allow-lists, workspace roots) are intersected and deny-lists
 * are unioned, and an intersection that would erase the run's list falls back
 * to the run's list so it can never widen access.
 */
export function restrictPermissions(
  granted: ToolPermissions | undefined,
  required: ToolPermissions | undefined,
): ToolPermissions {
  const g = granted ?? {};
  const r = required ?? {};
  const out: ToolPermissions = {};
  if (g.filesystem ?? r.filesystem) {
    out.filesystem = {
      read: grantBool(g.filesystem?.read, r.filesystem?.read),
      write: grantBool(g.filesystem?.write, r.filesystem?.write),
      delete: grantBool(g.filesystem?.delete, r.filesystem?.delete),
      roots: narrowList(g.filesystem?.roots, r.filesystem?.roots),
    };
  }
  if (g.terminal ?? r.terminal) {
    out.terminal = {
      execute: grantBool(g.terminal?.execute, r.terminal?.execute),
      allowCommands: narrowList(g.terminal?.allowCommands, r.terminal?.allowCommands),
      denyCommands: unionList(g.terminal?.denyCommands, r.terminal?.denyCommands),
      // Whether an isolation-requiring tool may run unsandboxed is the
      // operator's decision, so it comes from the granted side. A tool can
      // refuse it (`false`) but can never grant it to itself.
      allowUnisolated: grantBool(g.terminal?.allowUnisolated, r.terminal?.allowUnisolated),
    };
  }
  if (g.network ?? r.network) {
    out.network = {
      enabled: grantBool(g.network?.enabled, r.network?.enabled),
      allowedHosts: narrowList(g.network?.allowedHosts, r.network?.allowedHosts),
      methods: narrowList(g.network?.methods, r.network?.methods),
    };
  }
  if (g.git ?? r.git) {
    out.git = {
      read: grantBool(g.git?.read, r.git?.read),
      commit: grantBool(g.git?.commit, r.git?.commit),
      push: grantBool(g.git?.push, r.git?.push),
    };
  }
  if (g.database ?? r.database) {
    out.database = {
      read: grantBool(g.database?.read, r.database?.read),
      write: grantBool(g.database?.write, r.database?.write),
      connections: narrowList(g.database?.connections, r.database?.connections),
    };
  }
  return stripUndefined(out);
}

function grantBool(granted: boolean | undefined, required: boolean | undefined): boolean | undefined {
  if (granted === undefined && required === undefined) return undefined;
  if (required === false) return false;
  return granted === true;
}

function narrowList(granted: string[] | undefined, required: string[] | undefined): string[] | undefined {
  if (granted === undefined) return required;
  if (required === undefined) return granted;
  const narrowed = granted.filter((item) => required.includes(item));
  // An empty allow-list means "no restriction" for the tools that read these
  // lists, so an empty intersection must fall back to the run's own list
  // rather than silently opening the capability up.
  return narrowed.length > 0 ? narrowed : granted;
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

