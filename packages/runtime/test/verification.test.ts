import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandVerifier,
  CompositeVerifier,
  FilesystemVerifier,
  parseVerificationCommand,
  type ProgressVerifier,
  type VerificationContext,
} from '../src/index.js';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function context(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    runId: 'run_test',
    objective: 'Make the tests pass',
    observations: [],
    permissions: { terminal: { execute: true } },
    ...overrides,
  };
}

async function environmentFor(workspaceDir: string) {
  const { LocalExecutionEnvironment } = await import('@kazi-ai/agentos-tools');
  const environment = new LocalExecutionEnvironment({ workspaceDir });
  await environment.create();
  return environment;
}

describe('parseVerificationCommand', () => {
  it('splits a command and its arguments without a shell', () => {
    expect(parseVerificationCommand('pnpm test --silent')).toEqual({ command: 'pnpm', args: ['test', '--silent'] });
    expect(parseVerificationCommand('node  -e  "1"')).toEqual({ command: 'node', args: ['-e', '"1"'] });
  });

  it('rejects shell metacharacters instead of interpolating them', () => {
    for (const command of ['pnpm test && rm -rf /', 'cat a | grep b', 'echo $(whoami)', 'echo `id`', 'a > b', 'a \\ b']) {
      expect(() => parseVerificationCommand(command)).toThrow(/metacharacters|empty/);
    }
    expect(() => parseVerificationCommand('   ')).toThrow(/empty/);
  });
});

describe('CommandVerifier', () => {
  it('runs real commands and reports exit codes', async () => {
    const workspaceDir = process.cwd();
    const environment = await environmentFor(workspaceDir);
    const verifier = new CommandVerifier({ commands: ['node -e process.exit(0)'] });
    const result = await verifier.verify(context({ environment }));
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.passed).toBe(true);

    const failing = new CommandVerifier({ commands: ['node -e process.exit(3)'] });
    const failed = await failing.verify(context({ environment }));
    expect(failed.passed).toBe(false);
    expect(failed.checks[0]?.summary).toContain('exit code 3');
  });

  it('fails closed when the environment or permission is missing', async () => {
    const noEnvironment = await new CommandVerifier({ commands: ['node -e 0'] }).verify(context());
    expect(noEnvironment.passed).toBe(false);
    expect(noEnvironment.summary).toMatch(/environment/);

    const environment = await environmentFor(process.cwd());
    const noPermission = await new CommandVerifier({ commands: ['node -e 0'] }).verify(
      context({ environment, permissions: { terminal: { execute: false } } }),
    );
    expect(noPermission.passed).toBe(false);
    expect(noPermission.summary).toMatch(/not permitted/);
  });
});

describe('FilesystemVerifier', () => {
  it('checks the workspace instead of trusting the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kazi-verify-'));
    writeFileSync(join(dir, 'result.json'), '{"ok":true}');

    const verifier = new FilesystemVerifier(
      { checks: [{ path: 'result.json', exists: true, contains: '"ok":true' }, { path: 'missing.txt', exists: false }] },
      (path) => {
        try {
          return readFileSync(join(dir, path), 'utf8');
        } catch {
          return undefined;
        }
      },
    );
    const result = await verifier.verify(context());
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
  });
});

describe('verification inside a run', () => {
  it('completes only after configured verification commands pass', async () => {
    harness = await createHarness({
      turns: [
        { text: 'writing the file', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'out.txt', content: 'done' } }] },
        { text: 'I am finished.' },
      ],
      runtime: {
        verifier: () =>
          new CompositeVerifier([
          // No reader supplied: the verifier reads the run's workspace itself.
          new FilesystemVerifier({ checks: [{ path: 'out.txt', exists: true, contains: 'done' }] }),
          ]),
      },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    const result = await harness.runtime.result(run.id);
    expect(result.verification?.passed).toBe(true);
    const events = await harness.store.events.list(run.id);
    expect(events.map((event) => event.type)).toContain('verification.completed');
  });

  it('sends a failed verification back to work instead of declaring success', async () => {
    let attempts = 0;
    const verifier: ProgressVerifier = {
      id: 'stubborn',
      async verify() {
        attempts += 1;
        return {
          passed: attempts > 1,
          summary: attempts > 1 ? 'second attempt passed' : 'the file is still missing',
          checks: [{ name: 'exists', passed: attempts > 1, summary: '', durationMs: 1 }],
          at: Date.now(),
        };
      },
    };
    harness = await createHarness({
      turns: [
        { text: 'working', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
        { text: 'done, honestly' },
        { text: 'fixing it', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'b.txt', content: 'b' } }] },
        { text: 'done for real' },
      ],
      runtime: { verifier },
      limits: { maxSteps: 12 },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(finished.workspaceDir, 'b.txt'))).toBe(true);
    const recoveries = await harness.store.recoveries.list(run.id);
    expect(recoveries.some((recovery) => recovery.strategy === 'replan' || recovery.strategy === 'retry')).toBe(true);
  });

  it('exposes a verifier to the outside world through verifyRun', async () => {
    harness = await createHarness({
      turns: [{ text: 'nothing to do' }],
      runtime: {
        verifier: {
          id: 'always',
          async verify() {
            return { passed: true, summary: 'checked by the operator', checks: [], at: Date.now() };
          },
        },
      },
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const verified = await harness.runtime.verifyRun(run.id);
    expect(verified?.summary).toBe('checked by the operator');
  });
});
