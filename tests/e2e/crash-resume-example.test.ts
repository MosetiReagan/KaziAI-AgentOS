import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runExample(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'examples/crash-resume/run.ts'], {
      cwd: ROOT,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The example is the project's headline claim, so it runs in CI exactly as a
 * reader would run it: a real worker is killed and a second one must finish the
 * job from durable state alone (spec §114).
 */
describe('the crash-and-resume example', () => {
  it('kills a real worker and finishes the run on a second one', async () => {
    const result = await runExample();
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('SIGKILL');
    expect(result.stdout).toContain('run status        EXECUTING');
    expect(result.stdout).toContain('files written     5 / 5');
    expect(result.stdout).toContain('The worker died. The run did not.');
    expect(result.code).toBe(0);
  }, 300_000);
});
