import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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

export interface DockerEnvironmentOptions {
  workspaceDir: string;
  image: string;
  snapshotStoreDir?: string;
  /** Network is off by default so an agent cannot exfiltrate or call out. */
  networkEnabled?: boolean;
  memoryLimit?: string;
  cpuLimit?: number;
  pidsLimit?: number;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  dockerBin?: string;
  /** Injected for tests so no real Docker daemon is needed. */
  runner?: DockerRunner;
}

export interface DockerRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface DockerRunner {
  run(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal; stdin?: string; maxStdoutBytes?: number; maxStderrBytes?: number }): Promise<DockerRunResult>;
}

const CONTAINER_WORKDIR = '/workspace';

/** Executes commands through the Docker CLI with a locked-down container. */
export class DockerRunnerImpl implements DockerRunner {
  constructor(private readonly dockerBin = 'docker') {}

  async run(
    args: string[],
    options: { timeoutMs?: number; signal?: AbortSignal; stdin?: string; maxStdoutBytes?: number; maxStderrBytes?: number } = {},
  ): Promise<DockerRunResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const maxStdout = options.maxStdoutBytes ?? 512 * 1024;
    const maxStderr = options.maxStderrBytes ?? 256 * 1024;
    const started = Date.now();
    return await new Promise<DockerRunResult>((resolve, reject) => {
      const child = spawn(this.dockerBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const trim = (current: string, chunk: string, limit: number): string => {
        if (current.length >= limit) return current;
        return (current + chunk).slice(0, limit);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = trim(stdout, chunk.toString('utf8'), maxStdout);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = trim(stderr, chunk.toString('utf8'), maxStderr);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const onAbort = (): void => {
        child.kill('SIGKILL');
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new EnvironmentError(`Docker CLI unavailable: ${error.message}`, {
            code: 'environment.docker_unavailable',
            retryable: false,
            cause: error,
            details: { dockerBin: this.dockerBin },
          }),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - started });
      });
    });
  }
}

/**
 * Real isolation boundary: a container with no network by default, dropped
 * capabilities, a PID limit, memory/CPU caps, and only the run workspace
 * bind-mounted.
 */
export class DockerExecutionEnvironment implements ExecutionEnvironment {
  readonly kind = 'docker';
  private containerId: string | undefined;
  private readonly runner: DockerRunner;
  private readonly snapshotStoreDir: string;

  constructor(private readonly options: DockerEnvironmentOptions) {
    this.runner = options.runner ?? new DockerRunnerImpl(options.dockerBin);
    this.snapshotStoreDir = options.snapshotStoreDir ?? join(options.workspaceDir, '.kazi-snapshots');
  }

  private baseArgs(): string[] {
    const args = [
      'run',
      '-d',
      '--rm',
      '--workdir',
      CONTAINER_WORKDIR,
      '-v',
      `${this.options.workspaceDir}:${CONTAINER_WORKDIR}`,
      '--memory',
      this.options.memoryLimit ?? '1g',
      '--cpus',
      String(this.options.cpuLimit ?? 1),
      '--pids-limit',
      String(this.options.pidsLimit ?? 256),
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      this.options.networkEnabled ? 'bridge' : 'none',
      '--env',
      'HOME=/workspace',
    ];
    return args;
  }

  async create(): Promise<void> {
    mkdirSync(this.options.workspaceDir, { recursive: true });
    mkdirSync(this.snapshotStoreDir, { recursive: true });
    const result = await this.runner.run([
      ...this.baseArgs(),
      this.options.image,
      'sh',
      '-lc',
      'while true; do sleep 3600; done',
    ]);
    if (result.code !== 0) {
      throw new EnvironmentError(`Failed to start docker environment: ${result.stderr.trim()}`, {
        code: 'environment.docker_start_failed',
        retryable: true,
      });
    }
    this.containerId = result.stdout.trim();
  }

  workspaceDir(): string {
    return this.options.workspaceDir;
  }

  containerWorkspaceDir(): string {
    return CONTAINER_WORKDIR;
  }

  metadata(): JsonObject {
    return {
      kind: 'docker',
      image: this.options.image,
      containerId: this.containerId ?? null,
      network: this.options.networkEnabled ? 'bridge' : 'none',
      memoryLimit: this.options.memoryLimit ?? '1g',
      cpuLimit: this.options.cpuLimit ?? 1,
    };
  }

  async isReady(): Promise<boolean> {
    if (!this.containerId) return false;
    const result = await this.runner.run(['inspect', '-f', '{{.State.Running}}', this.containerId], { timeoutMs: 15_000 });
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  async execute(command: ShellCommand, options: ShellExecutionOptions = {}): Promise<ShellResult> {
    if (!this.containerId) {
      throw new EnvironmentError('Docker environment has not been created', { code: 'environment.not_created' });
    }
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 120_000;
    const shellLine = [command.command, ...(command.args ?? []).map(shellQuote)].join(' ');
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(command.env ?? {})) {
      envArgs.push('-e', `${key}=${value}`);
    }
    const result = await this.runner.run(['exec', '-i', ...envArgs, this.containerId, 'sh', '-lc', shellLine], {
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
      maxStdoutBytes: options.maxStdoutBytes ?? this.options.maxStdoutBytes,
      maxStderrBytes: options.maxStderrBytes ?? this.options.maxStderrBytes,
    });
    return {
      exitCode: result.timedOut ? 124 : result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  async snapshot(): Promise<EnvironmentSnapshot> {
    const { captureWorkspace } = await import('./snapshot.js');
    const snapshot = captureWorkspace({
      workspaceDir: this.options.workspaceDir,
      storeDir: this.snapshotStoreDir,
      kind: 'docker',
    });
    return {
      ...snapshot,
      handle: { ...(snapshot.handle ?? {}), containerId: this.containerId ?? null, image: this.options.image },
    };
  }

  async restore(snapshot: EnvironmentSnapshot): Promise<void> {
    const { restoreWorkspace } = await import('./snapshot.js');
    restoreWorkspace(snapshot, { removeExtra: false });
  }

  async destroy(): Promise<void> {
    if (!this.containerId) return;
    await this.runner.run(['rm', '-f', this.containerId], { timeoutMs: 30_000 });
    this.containerId = undefined;
  }
}

export class DockerEnvironmentProvider implements EnvironmentProvider {
  readonly kind = 'docker';

  constructor(private readonly options: Omit<DockerEnvironmentOptions, 'workspaceDir'>) {}

  async create(run: { runId: string; organizationId: string; workspaceDir: string }): Promise<ExecutionEnvironment> {
    const environment = new DockerExecutionEnvironment({ ...this.options, workspaceDir: run.workspaceDir });
    await environment.create();
    return environment;
  }

  async available(): Promise<boolean> {
    const runner = this.options.runner ?? new DockerRunnerImpl(this.options.dockerBin);
    try {
      const result = await runner.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  remediation(): string {
    return 'Install Docker Desktop (or the Docker Engine) and ensure `docker version` succeeds, then set KZ_ENVIRONMENT=docker.';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
