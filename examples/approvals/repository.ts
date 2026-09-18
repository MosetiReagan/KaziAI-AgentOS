/**
 * The little bit of world this example needs: a git repository with a commit,
 * and a bare remote beside it to push to.
 *
 * It lives in its own module because the example's driver and its end-to-end
 * test both build the same world, and a test that set up something different
 * would be testing something else.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

/** Run git with the example's own identity, never the caller's global config. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // The example is the only thing talking to the operator: a git error that
    // is expected (an empty remote) must not leak onto the output.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

/** Same, for the states that are expected: an empty remote has no `main` yet. */
export function gitOrEmpty(cwd: string, args: string[]): string[] {
  try {
    return git(cwd, args).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Give the run something real to push. The workspace stays the run's own; the
 * remote is the only thing outside it.
 */
export function prepareRepository(workspaceDir: string, originDir: string): void {
  git(workspaceDir, ['init', '-b', 'main']);
  git(workspaceDir, ['config', 'user.name', 'Release Agent']);
  git(workspaceDir, ['config', 'user.email', 'release-agent@localhost']);
  git(workspaceDir, ['add', '-A']);
  git(workspaceDir, ['commit', '-m', 'chore: initial import']);
  mkdirSync(originDir, { recursive: true });
  git(originDir, ['init', '--bare', '-b', 'main']);
  git(workspaceDir, ['remote', 'add', 'origin', originDir]);
}
