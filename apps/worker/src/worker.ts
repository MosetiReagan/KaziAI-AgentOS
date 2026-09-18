import { randomUUID } from 'node:crypto';
import type { AgentOS } from '@kazi-ai/agentos';
import { NullLogger, type Logger } from '@kazi-ai/agentos-core';
import type { FailureRecord } from '@kazi-ai/agentos-persistence';
import type { QueuedRun, RunQueue } from './queue.js';

export interface AgentWorkerOptions {
  os: AgentOS;
  /** Where runs come from. `StoreRunQueue` is the durable default. */
  queue: RunQueue;
  /** Runs executed at the same time by this worker. */
  concurrency?: number;
  /** How long to wait when there is nothing to claim. */
  pollIntervalMs?: number;
  /** How often to look for claims left behind by a worker that died. */
  sweepIntervalMs?: number;
  /** A claim older than this is considered abandoned. */
  staleClaimMs?: number;
  /** Executions attempted before a run is left for an operator. */
  maxAttempts?: number;
  workerId?: string;
  logger?: Logger;
  /** Injectable sleep, so tests do not wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerStats {
  workerId: string;
  running: boolean;
  inFlight: number;
  claimed: number;
  completed: number;
  failed: number;
  reclaimed: number;
  startedAt?: number;
  lastTickAt?: number;
}

export interface StopOptions {
  /** How long in-flight runs may take to reach a resting point. */
  timeoutMs?: number;
}

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_STALE_CLAIM_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * The AgentOS worker (spec §44).
 *
 * The worker owns nothing durable. It claims a run from the queue, hands it to
 * the runtime, and the runtime loads everything it needs from the store. If
 * this process disappears the claim goes stale, another worker takes it, and
 * the run continues from its last checkpoint rather than starting over.
 */
export class AgentWorker {
  readonly workerId: string;
  readonly queue: RunQueue;

  private readonly logger: Logger;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly sweepIntervalMs: number;
  private readonly staleClaimMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<void>>();
  private loop?: Promise<void>;
  private running = false;
  private startedAt?: number;
  private lastTickAt?: number;
  private lastSweepAt = 0;
  private stats = { claimed: 0, completed: 0, failed: 0, reclaimed: 0 };

  constructor(private readonly options: AgentWorkerOptions) {
    this.workerId = options.workerId ?? `wrk_${randomUUID().slice(0, 8)}`;
    this.logger = options.logger ?? new NullLogger();
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, this.staleClaimMs / 2);
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.queue = options.queue;
  }

  get isRunning(): boolean {
    return this.running;
  }

  statsSnapshot(): WorkerStats {
    return {
      workerId: this.workerId,
      running: this.running,
      inFlight: this.inFlight.size,
      ...this.stats,
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.logger.info('worker started', { workerId: this.workerId, concurrency: this.concurrency });
    this.loop = this.runLoop();
  }

  /**
   * Serve items pushed by an external queue instead of polling the store
   * (spec §43/§44). The worker is still the thing that knows about
   * concurrency, shutdown and in-flight work; only the source of items moves.
   */
  beginServing(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.startedAt ?? Date.now();
    this.logger.info('worker serving an external queue', { workerId: this.workerId });
  }

  /** Track and run one item, so external queues share shutdown accounting. */
  async executeClaimed(item: QueuedRun): Promise<void> {
    if (this.inFlight.has(item.runId)) return;
    return this.track(item);
  }

  /** One pass: claim up to the free capacity and execute what was claimed. */
  async tick(): Promise<number> {
    this.lastTickAt = Date.now();
    const free = this.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    let claimed = 0;
    for (let slot = 0; slot < free; slot += 1) {
      const item = await this.queue.claim();
      if (!item) break;
      claimed += 1;
      this.stats.claimed += 1;
      this.track(item);
    }
    // Sweeping must not depend on having claimed something. If the only
    // queued run carries the stale claim of a worker that died, `claim()`
    // correctly refuses to touch it — so gating the sweep on `claimed > 0`
    // means the run is never reclaimed and the queue looks empty forever.
    // `maybeSweep` is interval-gated, so this does not poll the store on every
    // iteration (spec §31, §44).
    await this.maybeSweep();
    return claimed;
  }

  /** Reset abandoned claims so another worker can pick the run up. */
  async sweep(): Promise<string[]> {
    this.lastSweepAt = Date.now();
    if (!this.queue.reclaimStale) return [];
    const released = await this.queue.reclaimStale({ olderThanMs: this.staleClaimMs });
    if (released.length > 0) {
      this.stats.reclaimed += released.length;
      this.logger.warn('reclaimed runs from workers that stopped reporting', {
        count: released.length,
        runs: released.join(','),
      });
    }
    return released;
  }

  /** Wait until every in-flight run reaches a resting point. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * Graceful shutdown (spec §84): stop accepting work, let the runs that are
   * executing reach a resting point, and checkpoint them if they do not. The
   * runtime pauses the run and writes a checkpoint, so a restart resumes
   * rather than restarts.
   */
  async stop(options: StopOptions = {}): Promise<void> {
    if (!this.running && this.inFlight.size === 0) return;
    this.running = false;
    this.logger.info('worker draining', { workerId: this.workerId, inFlight: this.inFlight.size });
    await this.loop?.catch(() => undefined);
    this.loop = undefined;

    if (this.inFlight.size > 0) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      const drained = Promise.allSettled([...this.inFlight.values()]);
      const timedOut = await Promise.race([
        drained.then(() => false),
        this.sleep(timeoutMs).then(() => true),
      ]);
      if (timedOut && this.inFlight.size > 0) {
        // Ask the runtime to bring the active runs to a safe stopping point:
        // each one checkpoints and pauses.
        await this.options.os.runtime.shutdown();
        await this.drain();
      }
    }
    await this.queue.close?.();
    this.logger.info('worker stopped', { workerId: this.workerId, ...this.stats });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const claimed = await this.tick();
        if (claimed === 0) await this.sleep(this.pollIntervalMs);
      } catch (error) {
        this.logger.error('worker tick failed', { workerId: this.workerId, error: (error as Error).message });
        await this.sleep(this.pollIntervalMs);
      }
    }
  }

  private track(item: QueuedRun): Promise<void> {
    const promise = this.executeItem(item).finally(() => {
      this.inFlight.delete(item.runId);
    });
    this.inFlight.set(item.runId, promise);
    return promise;
  }

  /** Execute one claimed run. Public so a queue that owns its own retries
   * (BullMQ) can drive the same code path instead of a second implementation. */
  async executeItem(item: QueuedRun): Promise<void> {
    const decision = await this.options.os.runtime.backpressure.check({
      organizationId: item.organizationId,
      queueDepth: await this.queue.depth(),
    });
    if (!decision.allowed) {
      this.logger.warn('backpressure: leaving the run queued', {
        runId: item.runId,
        reason: decision.reason,
      });
      await this.release(item);
      return;
    }

    const started = Date.now();
    try {
      const runtime = this.options.os.runtime;
      if (item.action === 'resume') await runtime.resume(item.runId);
      else if (item.action === 'retry') await runtime.retry(item.runId);
      else await runtime.start(item.runId);
      this.stats.completed += 1;
      this.logger.info('run finished', {
        runId: item.runId,
        action: item.action,
        attempt: item.attempt,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      this.stats.failed += 1;
      await this.recordFailure(item, error);
      this.logger.error('run execution failed', {
        runId: item.runId,
        attempt: item.attempt,
        error: (error as Error).message,
      });
    }
  }

  /**
   * A failure here is the worker's, not the agent's: the runtime already
   * classified and recovered from anything it could. The run is either put back
   * on the queue for another attempt or left claimed for an operator, and either
   * way the failure is durable.
   */
  private async recordFailure(item: QueuedRun, error: unknown): Promise<void> {
    const run = await this.options.os.store.runs.get(item.runId);
    const failure: FailureRecord = {
      id: `fail_${randomUUID()}`,
      runId: item.runId,
      code: 'worker.execution_failed',
      category: 'infrastructure',
      message: (error as Error).message,
      retryable: true,
      terminal: item.attempt >= this.maxAttempts,
      at: Date.now(),
      detail: { workerId: this.workerId, attempt: item.attempt, action: item.action },
    };
    await this.options.os.store.failures.save(failure);
    if (item.attempt < this.maxAttempts && run && !run.status.match(/COMPLETED|CANCELLED|TIMED_OUT|FAILED/)) {
      await this.release(item);
      return;
    }
    this.logger.warn('run left claimed after repeated worker failures', {
      runId: item.runId,
      attempts: item.attempt,
    });
  }

  /** Return a claimed run to the queue so any worker can try again. */
  private async release(item: QueuedRun): Promise<void> {
    await this.queue.release(item).catch(() => undefined);
  }

  private async maybeSweep(): Promise<void> {
    if (Date.now() - this.lastSweepAt < this.sweepIntervalMs) return;
    await this.sweep();
  }
}
