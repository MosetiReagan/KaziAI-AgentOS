import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { ToolInputError } from '@kazi-ai/agentos-core';

export interface PathGuardOptions {
  /** Root the sandbox is confined to. */
  root: string;
  /** Additional directories explicitly granted by policy. */
  allowedRoots?: string[];
}

/**
 * Resolves agent-supplied paths inside the run workspace and refuses anything
 * that escapes it — including through symlinks. This is the single choke point
 * for filesystem confinement.
 */
export class PathGuard {
  private readonly root: string;
  private readonly allowedRoots: string[];

  constructor(options: PathGuardOptions) {
    this.root = resolve(options.root);
    this.allowedRoots = (options.allowedRoots ?? []).map((entry) => resolve(entry));
  }

  get workspaceRoot(): string {
    return this.root;
  }

  /**
   * Resolve `input` relative to `cwd` (which itself must be inside the root)
   * and verify the result stays inside an allowed root.
   */
  resolvePath(input: string, cwd?: string): string {
    if (typeof input !== 'string' || input.length === 0) {
      throw new ToolInputError('filesystem', 'Path must be a non-empty string');
    }
    if (input.includes('\0')) {
      throw new ToolInputError('filesystem', 'Path contains a null byte');
    }
    const base = cwd ? this.assertInside(this.resolveRaw(cwd)) : this.root;
    const candidate = isAbsolute(input) ? normalize(input) : resolve(base, input);
    return this.assertInside(candidate);
  }

  private resolveRaw(input: string): string {
    const candidate = isAbsolute(input) ? normalize(input) : resolve(this.root, input);
    return this.assertInside(candidate);
  }

  /** Verify a resolved path is inside an allowed root, following symlinks when the path exists. */
  assertInside(candidate: string): string {
    const roots = [this.root, ...this.allowedRoots];
    const normalized = normalize(candidate);
    if (isInsideAny(normalized, roots)) return this.dereferenceIfPossible(normalized);
    throw new ToolInputError('filesystem', `Path escapes the workspace: ${candidate}`, {
      requested: candidate,
      workspace: this.root,
    });
  }

  private dereferenceIfPossible(target: string): string {
    if (!existsSync(target)) {
      // For a path that does not exist yet, validate the deepest existing ancestor.
      const ancestor = nearestExistingAncestor(target);
      if (ancestor) {
        const resolvedAncestor = realpathSync(ancestor);
        const roots = [this.root, ...this.allowedRoots].map((root) => realpathOf(root));
        if (!isInsideAny(resolvedAncestor, roots)) {
          throw new ToolInputError('filesystem', `Path resolves outside the workspace via a symlink: ${target}`, {
            requested: target,
          });
        }
      }
      return target;
    }
    const resolved = realpathSync(target);
    const roots = [this.root, ...this.allowedRoots].map((root) => realpathOf(root));
    if (!isInsideAny(resolved, roots)) {
      throw new ToolInputError('filesystem', `Path resolves outside the workspace: ${target}`, {
        requested: target,
        resolved,
      });
    }
    return target;
  }

  /** Workspace-relative display path, used in traces and tool output. */
  toRelative(target: string): string {
    const rel = relative(this.root, target);
    return rel === '' ? '.' : rel;
  }

  joinWorkspace(...segments: string[]): string {
    return this.assertInside(join(this.root, ...segments));
  }
}

function realpathOf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return normalize(target);
  }
}

function nearestExistingAncestor(target: string): string | undefined {
  let cursor = target;
  for (;;) {
    const parent = resolve(cursor, '..');
    if (existsSync(cursor)) return cursor;
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function isInsideAny(candidate: string, roots: string[]): boolean {
  return roots.some((root) => {
    if (candidate === root) return true;
    const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
    return candidate.startsWith(normalizedRoot);
  });
}

/** Paths agents must never reach, even if a policy mistakenly allows a broad root. */
export const PROTECTED_PATHS: readonly string[] = [
  '/etc',
  '/root',
  '/home',
  '/var/run/docker.sock',
  '/proc',
  '/sys',
  '/dev',
  '/.dockerenv',
];

export function isProtectedPath(target: string): boolean {
  const normalized = normalize(target);
  return PROTECTED_PATHS.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

