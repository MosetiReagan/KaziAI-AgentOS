import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeTurn } from '@kazi-ai/agentos-providers';

const CHILD = fileURLToPath(new URL('../fixtures/worker-child.ts', import.meta.url));

export interface WorkerChildEvent {
  event: 'ready' | 'status' | 'finished' | 'error';
  error?: unknown;
  failures?: string[];
  pid?: number;
  status?: string;
  steps?: number;
  toolCalls?: number;
  checkpoints?: number;
  recoveries?: number;
  modelCalls?: number;
  workerId?: string;
  message?: string;
}

export interface WorkerChild {
  child: ChildProcess;
  pid: number;
  events: WorkerChildEvent[];
  /** Resolve once an event matching the predicate has arrived. */
  waitFor(predicate: (event: WorkerChildEvent) => boolean, timeoutMs?: number): Promise<WorkerChildEvent>;
  /** Send SIGKILL, exactly as an OOM kill or a crashed node would. */
  kill(): void;
  stopped: Promise<void>;
}

export interface StartWorkerChildOptions {
  dataDir: string;
  runId: string;
  turns: FakeTurn[];
  staleClaimMs?: number;
  workerId?: string;
}

/**
 * Start a worker in its own OS process, so a test can kill it mid-run.
 *
 * `tsx` resolves the workspace sources through the repository's `paths`, so the
 * child exercises the same code the test does without a prior build.
 */
export function startWorkerChild(options: StartWorkerChildOptions): WorkerChild {
  const script = join(options.dataDir, `turns-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(script, JSON.stringify(options.turns), 'utf8');

  const args = [
    '--import',
    'tsx',
    CHILD,
    '--data-dir',
    options.dataDir,
    '--run-id',
    options.runId,
    '--script',
    script,
    '--stale-claim-ms',
    String(options.staleClaimMs ?? 30_000),
    '--worker-id',
    options.workerId ?? `child-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  ];
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  const events: WorkerChildEvent[] = [];
  const waiters: Array<{ predicate: (event: WorkerChildEvent) => boolean; resolve: (event: WorkerChildEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  let buffer = '';
  let stderr = '';

  const settle = (event: WorkerChildEvent): void => {
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
        settle(JSON.parse(line) as WorkerChildEvent);
      } catch {
        // A non-JSON line is noise from a dependency; keep reading.
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const stopped = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `worker process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}) before the expected event. ` +
              `stdout: ${JSON.stringify(events)} stderr: ${stderr.slice(0, 2_000)}`,
          ),
        );
      }
      resolve();
    });
  });

  return {
    child,
    pid: child.pid ?? -1,
    events,
    stopped,
    waitFor(predicate, timeoutMs = 60_000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<WorkerChildEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for a worker event. seen: ${JSON.stringify(events)} stderr: ${stderr.slice(0, 2_000)}`,
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
