/**
 * Starts `worker-child.ts` in its own OS process and exposes its events.
 *
 * The child is a separate process because that is the only honest way to show
 * what a crash does: an in-process fake can always be resurrected by the code
 * that "killed" it (spec §114).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'worker-child.ts');
const ROOT = join(HERE, '..', '..');

export interface WorkerEvent {
  event: 'ready' | 'status' | 'finished' | 'error';
  pid?: number;
  workerId?: string;
  status?: string;
  steps?: number;
  toolCalls?: number;
  checkpoints?: number;
  recoveries?: number;
  modelCalls?: number;
  message?: string;
}

export interface Worker {
  pid: number;
  waitFor(predicate: (event: WorkerEvent) => boolean, timeoutMs?: number): Promise<WorkerEvent>;
  kill(): void;
  stopped: Promise<void>;
}

export interface StartWorkerOptions {
  dataDir: string;
  runId: string;
  script: string;
  workerId: string;
  staleClaimMs?: number;
}

export function startWorker(options: StartWorkerOptions): Worker {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      CHILD,
      '--data-dir',
      options.dataDir,
      '--run-id',
      options.runId,
      '--script',
      options.script,
      '--worker-id',
      options.workerId,
      '--stale-claim-ms',
      String(options.staleClaimMs ?? 30_000),
      '--org',
      'org_example',
      '--project',
      'prj_crash_resume',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );

  const events: WorkerEvent[] = [];
  const waiters: Array<{
    predicate: (event: WorkerEvent) => boolean;
    resolve: (event: WorkerEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = '';
  let stderr = '';

  const settle = (event: WorkerEvent): void => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        settle(JSON.parse(line) as WorkerEvent);
      } catch {
        // Non-JSON output from a dependency is not an event; keep reading.
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const stopped = new Promise<void>((resolve) => {
    child.once('exit', () => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `worker exited before the expected event. seen=${JSON.stringify(events)} stderr=${stderr.slice(0, 1_000)}`,
          ),
        );
      }
      resolve();
    });
  });

  return {
    pid: child.pid ?? -1,
    stopped,
    waitFor(predicate, timeoutMs = 60_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<WorkerEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for a worker event. seen=${JSON.stringify(events)} stderr=${stderr.slice(0, 1_000)}`,
            ),
          );
        }, timeoutMs);
        waiters.push({ predicate, resolve, reject, timer });
      });
    },
    kill() {
      child.kill('SIGKILL');
    },
  };
}
