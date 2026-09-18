import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { EnvironmentError, ValidationError, type Logger } from '@kazi-ai/agentos-core';

export type WorkspaceStatus = 'CREATE' | 'ACTIVE' | 'CHECKPOINTED' | 'CLEANUP' | 'DELETED';

export interface WorkspaceHandle {
  runId: string;
  organizationId: string;
  path: string;
  status: WorkspaceStatus;
  createdAt: number;
  retentionMs?: number;
}

export interface WorkspaceManagerOptions {
  root: string;
  logger?: Logger;
  /** Default retention for finished workspaces; undefined keeps them forever. */
  retentionMs?: number;
}

/**
 * Every run gets its own directory. Nothing outside it is reachable through the
 * filesystem or terminal tools, which is what bounds the blast radius of a
 * misbehaving agent.
 */
export class WorkspaceManager {
  private readonly root: string;
  private readonly handles = new Map<string, WorkspaceHandle>();

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.root = resolve(options.root);
    mkdirSync(this.root, { recursive: true });
  }

  get rootDir(): string {
    return this.root;
  }

  pathFor(organizationId: string, runId: string): string {
    return join(this.root, sanitize(organizationId), sanitize(runId));
  }

  create(input: { runId: string; organizationId: string; retentionMs?: number }): WorkspaceHandle {
    const path = this.pathFor(input.organizationId, input.runId);
    mkdirSync(path, { recursive: true });
    const handle: WorkspaceHandle = {
      runId: input.runId,
      organizationId: input.organizationId,
      path,
      status: 'ACTIVE',
      createdAt: Date.now(),
      ...(input.retentionMs === undefined ? {} : { retentionMs: input.retentionMs }),
    };
    this.handles.set(input.runId, handle);
    this.options.logger?.debug('workspace created', { runId: input.runId, path });
    return handle;
  }

  get(runId: string): WorkspaceHandle | undefined {
    return this.handles.get(runId);
  }

  require(runId: string): WorkspaceHandle {
    const handle = this.handles.get(runId);
    if (handle) return handle;
    throw new EnvironmentError(`No workspace registered for run ${runId}`, { code: 'workspace.missing' });
  }

  /** Re-attach to an existing workspace after a worker restart. */
  adopt(input: { runId: string; organizationId: string; path: string }): WorkspaceHandle {
    const path = resolve(input.path);
    mkdirSync(path, { recursive: true });
    const handle: WorkspaceHandle = {
      runId: input.runId,
      organizationId: input.organizationId,
      path,
      status: 'ACTIVE',
      createdAt: statSync(path).birthtimeMs || Date.now(),
    };
    this.handles.set(input.runId, handle);
    return handle;
  }

  markCheckpointed(runId: string): void {
    const handle = this.handles.get(runId);
    if (handle) handle.status = 'CHECKPOINTED';
  }

  cleanup(runId: string, options: { remove: boolean } = { remove: true }): void {
    const handle = this.handles.get(runId);
    if (!handle) return;
    handle.status = 'CLEANUP';
    if (options.remove) {
      rmSync(handle.path, { recursive: true, force: true });
      handle.status = 'DELETED';
      this.handles.delete(runId);
    }
    this.options.logger?.debug('workspace cleaned', { runId });
  }

  /** Remove workspaces whose retention window has elapsed. */
  pruneExpired(now = Date.now()): string[] {
    const removed: string[] = [];
    for (const handle of [...this.handles.values()]) {
      if (handle.retentionMs === undefined) continue;
      if (handle.status !== 'ACTIVE' && handle.status !== 'CHECKPOINTED') continue;
      if (now - handle.createdAt < handle.retentionMs) continue;
      this.cleanup(handle.runId);
      removed.push(handle.runId);
    }
    return removed;
  }

  list(): WorkspaceHandle[] {
    return [...this.handles.values()];
  }

  /**
   * Seed a workspace with files before the run starts (spec §70).
   *
   * A seed is caller-supplied, not agent-supplied, but a relative path that
   * escapes the workspace is still refused: the boundary has to hold no matter
   * who is holding the other end.
   */
  seed(runId: string, files: Record<string, string>): void {
    const handle = this.require(runId);
    for (const [name, contents] of Object.entries(files)) {
      const target = this.confine(handle.path, name);
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    }
  }

  /**
   * Copy a host directory into the workspace, which is how a run starts on an
   * existing repository (spec §94). The caller names the directory and is
   * trusted to; `ignore` skips path segments such as `node_modules`.
   */
  seedFrom(runId: string, sourceDir: string, options: { ignore?: string[] } = {}): number {
    const handle = this.require(runId);
    const source = resolve(sourceDir);
    if (!statSync(source).isDirectory()) {
      throw new ValidationError(`Workspace seed source is not a directory: ${source}`, { source });
    }
    const ignore = new Set(options.ignore ?? []);
    cpSync(source, handle.path, {
      recursive: true,
      filter: (entry) => !entry.split(sep).some((segment) => ignore.has(segment)),
    });
    return countFiles(handle.path);
  }

  /** Resolve a path inside the workspace, refusing anything that escapes it. */
  private confine(root: string, name: string): string {
    const target = resolve(root, name);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new ValidationError(`Workspace seed path escapes the workspace: ${name}`, { path: name });
    }
    return target;
  }
}

function readdirSyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSyncSafe(dir)) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else total += 1;
  }
  return total;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

