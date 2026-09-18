import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import {
  EnvironmentError,
  type EnvironmentProvider,
  type EnvironmentSnapshot,
  type ExecutionEnvironment,
  type JsonObject,
  type ShellCommand,
  type ShellExecutionOptions,
  type ShellResult,
} from '@kazi-ai/agentos-core';
import { PathGuard } from '../path-guard.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STDOUT = 256 * 1024;
const DEFAULT_MAX_STDERR = 128 * 1024;
const DEFAULT_MAX_PROCESSES = 64;

export interface LocalEnvironmentOptions {
  workspaceDir: string;
  /** Where content-addressed checkpoint blobs live. Defaults inside the workspace. */
  snapshotStoreDir?: string;
  /** Environment variables explicitly forwarded to the agent's commands. */
  passthroughEnv?: string[];
  /** Extra variables always provided. */
  env?: Record<string, string>;
  /** Refuse commands whose executable is not in this list. Empty means allow all. */
  allowedCommands?: string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  maxProcesses?: number;
  /** Wall-clock ceiling applied regardless of per-call options. */
  hardTimeoutMs?: number;
}

const BASE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SHELL'];

/**
 * Runs commands as host processes inside the run workspace.
 *
 * This is a *confinement* boundary (working directory, environment allow-list,
 * timeouts, output caps), not a security boundary. Use the Docker environment
 * when you need real isolation; `doctor` reports which one is active.
 */
export class LocalExecutionEnvironment implements ExecutionEnvironment {
  readonly kind = 'local';
  /** Host processes share the host user's access: this is a confinement, not a boundary. */
  readonly isolating = false;
  private readonly guard: PathGuard;
  private readonly snapshotStoreDir: string;
  private ready = false;

  constructor(private readonly options: LocalEnvironmentOptions) {
    this.guard = new PathGuard({ root: options.workspaceDir });
    this.snapshotStoreDir = options.snapshotStoreDir ?? join(options.workspaceDir, '.kazi-snapshots');
  }

  async create(): Promise<void> {
    mkdirSync(this.options.workspaceDir, { recursive: true });
    this.ready = true;
  }

  workspaceDir(): string {
    return this.options.workspaceDir;
  }

  metadata(): JsonObject {
    return {
      kind: 'local',
      platform: platform(),
      workspace: this.options.workspaceDir,
      isolation: 'process-confinement',
      note: 'local environment is not a security boundary; use docker for untrusted code',
    };
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  private buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      // HOME is redirected into the workspace so tooling cannot reach the real
      // user's dotfiles, credentials, or git config.
      HOME: this.options.workspaceDir,
      TMPDIR: resolve(this.options.workspaceDir, '.tmp'),
      PWD: this.options.workspaceDir,
      KAZI_SANDBOX: '1',
    };
    for (const key of [...BASE_ENV_KEYS, ...(this.options.passthroughEnv ?? [])]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    if (!env['PATH']) env['PATH'] = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
    return { ...env, ...(this.options.env ?? {}), ...(extra ?? {}) };
  }

  private assertAllowed(command: string): void {
    const allow = this.options.allowedCommands ?? [];
    if (allow.length === 0) return;
    const base = command.split('/').pop() ?? command;
    if (!allow.includes(base)) {
      throw new EnvironmentError(`Command not permitted: ${base}`, {
        code: 'environment.command_not_allowed',
        retryable: false,
        details: { command: base, allowed: allow },
      });
    }
  }

  async execute(command: ShellCommand, options: ShellExecutionOptions = {}): Promise<ShellResult> {
    this.assertAllowed(command.command);
    const cwd = command.cwd ? this.guard.resolvePath(command.cwd) : this.options.workspaceDir;
    mkdirSync(resolve(this.options.workspaceDir, '.tmp'), { recursive: true });
    const timeoutMs = Math.min(
      options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      this.options.hardTimeoutMs ?? 30 * 60_000,
    );
    const maxStdout = options.maxStdoutBytes ?? this.options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    const maxStderr = options.maxStderrBytes ?? this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR;
    const maxProcesses = this.options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    const started = Date.now();

    return await new Promise<ShellResult>((resolvePromise, reject) => {
      const child = spawn(command.command, command.args ?? [], {
        cwd,
        env: this.buildEnv(command.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: platform() !== 'win32',
        shell: false,
      });

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let aborted = false;

      const collect = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
        const limit = target === 'stdout' ? maxStdout : maxStderr;
        if (target === 'stdout') {
          if (stdout.byteLength >= limit) {
            stdoutTruncated = true;
            return;
          }
          stdout = Buffer.concat([stdout, chunk]);
          if (stdout.byteLength > limit) {
            stdout = stdout.subarray(0, limit);
            stdoutTruncated = true;
          }
        } else {
          if (stderr.byteLength >= limit) {
            stderrTruncated = true;
            return;
          }
          stderr = Buffer.concat([stderr, chunk]);
          if (stderr.byteLength > limit) {
            stderr = stderr.subarray(0, limit);
            stderrTruncated = true;
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
      child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));

      const killTree = (signal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          if (platform() === 'win32') child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // Process already gone.
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGKILL');
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        killTree('SIGKILL');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      if (command.stdin !== undefined) {
        child.stdin.write(command.stdin);
      }
      child.stdin.end();

      child.on('error', (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(
          new EnvironmentError(`Failed to start command: ${error.message}`, {
            code: 'environment.spawn_failed',
            retryable: false,
            cause: error,
          }),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (aborted) {
          reject(new EnvironmentError('Command aborted', { code: 'environment.aborted', retryable: false }));
          return;
        }
        resolvePromise({
          exitCode: timedOut ? 124 : (code ?? -1),
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          durationMs: Date.now() - started,
          timedOut,
          stdoutTruncated,
          stderrTruncated,
        });
      });

      void maxProcesses;
    });
  }

  async snapshot(): Promise<EnvironmentSnapshot> {
    const { captureWorkspace } = await import('./snapshot.js');
    return captureWorkspace({
      workspaceDir: this.options.workspaceDir,
      storeDir: this.snapshotStoreDir,
      kind: 'local',
    });
  }

  async restore(snapshot: EnvironmentSnapshot): Promise<void> {
    const { restoreWorkspace } = await import('./snapshot.js');
    restoreWorkspace(snapshot, { removeExtra: false });
  }

  async destroy(): Promise<void> {
    this.ready = false;
    // The workspace itself is owned by the WorkspaceManager, not the environment.
    rmSync(resolve(this.options.workspaceDir, '.tmp'), { recursive: true, force: true });
  }
}

export class LocalEnvironmentProvider implements EnvironmentProvider {
  readonly kind = 'local';

  constructor(private readonly options: Omit<LocalEnvironmentOptions, 'workspaceDir'> = {}) {}

  async create(run: { runId: string; organizationId: string; workspaceDir: string }): Promise<ExecutionEnvironment> {
    const environment = new LocalExecutionEnvironment({ ...this.options, workspaceDir: run.workspaceDir });
    await environment.create();
    return environment;
  }

  async available(): Promise<boolean> {
    return true;
  }
}
