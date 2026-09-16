import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { EnvironmentSnapshot } from '@kazi-ai/agentos-core';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.kazi-snapshots']);

export interface CaptureOptions {
  workspaceDir: string;
  /** Directory holding the content-addressed blob store for snapshots. */
  storeDir: string;
  kind: string;
}

/**
 * Capture the workspace as a content-addressed snapshot. Blobs are deduplicated
 * by sha256, so repeated checkpoints of a large workspace stay cheap, and a
 * restore is a genuine byte-for-byte recovery rather than a manifest check.
 */
export function captureWorkspace(options: CaptureOptions): EnvironmentSnapshot {
  const workspaceDir = resolve(options.workspaceDir);
  const blobDir = join(resolve(options.storeDir), 'blobs');
  mkdirSync(blobDir, { recursive: true });
  const files: Array<{ path: string; sha256: string; size: number }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = readFileSync(full);
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const blob = join(blobDir, sha256);
      if (!existsSync(blob)) writeFileSync(blob, buffer);
      files.push({ path: relative(workspaceDir, full), sha256, size: buffer.byteLength });
    }
  };
  if (existsSync(workspaceDir)) walk(workspaceDir);
  files.sort((left, right) => left.path.localeCompare(right.path));

  return {
    kind: options.kind,
    workspaceDir,
    files,
    capturedAt: Date.now(),
    handle: { storeDir: resolve(options.storeDir), fileCount: files.length },
  };
}

export interface RestoreOptions {
  /** Remove workspace files that are not present in the snapshot. */
  removeExtra?: boolean;
}

/** Restore a captured workspace. Files already matching are skipped, making this idempotent. */
export function restoreWorkspace(snapshot: EnvironmentSnapshot, options: RestoreOptions = {}): { written: number; skipped: number; removed: number } {
  const storeDir = typeof snapshot.handle?.['storeDir'] === 'string' ? (snapshot.handle['storeDir'] as string) : undefined;
  if (!storeDir) {
    throw new Error(`Snapshot ${snapshot.kind} has no blob store; cannot restore`);
  }
  const blobDir = join(storeDir, 'blobs');
  const workspaceDir = resolve(snapshot.workspaceDir);
  mkdirSync(workspaceDir, { recursive: true });
  let written = 0;
  let skipped = 0;

  const expected = new Set<string>();
  for (const file of snapshot.files ?? []) {
    expected.add(file.path);
    const target = join(workspaceDir, file.path);
    mkdirSync(resolve(target, '..'), { recursive: true });
    if (existsSync(target)) {
      const existing = readFileSync(target);
      if (existing.byteLength === file.size && createHash('sha256').update(existing).digest('hex') === file.sha256) {
        skipped += 1;
        continue;
      }
    }
    const blob = join(blobDir, file.sha256);
    if (!existsSync(blob)) {
      throw new Error(`Snapshot blob missing for ${file.path} (${file.sha256})`);
    }
    copyFileSync(blob, target);
    written += 1;
  }

  let removed = 0;
  if (options.removeExtra) {
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = relative(workspaceDir, full);
        if (!expected.has(rel)) {
          rmSync(full, { force: true });
          removed += 1;
        }
      }
    };
    walk(workspaceDir);
  }

  return { written, skipped, removed };
}

export function writeSeedFile(workspaceDir: string, name: string, contents: string): void {
  const target = join(workspaceDir, name);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

export function workspaceSizeBytes(workspaceDir: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(workspaceDir);
  return total;
}

