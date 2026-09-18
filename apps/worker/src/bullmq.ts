import { randomUUID } from 'node:crypto';
import type { Logger } from '@kazi-ai/agentos-core';
import type { DispatchContext, RunDispatcher } from '@kazi-ai/agentos-runtime';
import type { QueuedRun } from './queue.js';
import type { AgentWorker } from './worker.js';

export const DEFAULT_QUEUE_NAME = 'agentos-runs';
export const DEFAULT_JOB_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 1_000;

export interface BullMqOptions {
  /** Redis connection string; omit to use BullMQ's own defaults. */
  redisUrl?: string;
  queueName?: string;
  logger?: Logger;
}

interface BullMqJob {
  id?: string;
  data: unknown;
  attemptsMade: number;
}

interface BullMqQueueLike {
  add(name: string, data: unknown, options: Record<string, unknown>): Promise<{ id?: string }>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  close(): Promise<void>;
}

interface BullMqWorkerLike {
  close(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

export type BullMqModule = {
  Queue: new (name: string, options: Record<string, unknown>) => BullMqQueueLike;
  Worker: new (
    name: string,
    processor: (job: BullMqJob) => Promise<void>,
    options: Record<string, unknown>,
  ) => BullMqWorkerLike;
};

async function loadBullMq(module?: BullMqModule): Promise<BullMqModule> {
  if (module) return module;
  try {
    return (await import('bullmq')) as unknown as BullMqModule;
  } catch (error) {
    throw new Error(
      'BullMQ is not installed. Install "bullmq" (and a Redis instance) or use the durable ' +
        `store-backed queue instead. Underlying error: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/**
 * BullMQ deduplicates by job id, which is what makes enqueueing idempotent:
 * asking for the same run and action twice cannot execute it twice (spec §32,
 * §43).
 */
export function bullMqJobId(context: DispatchContext): string {
  return `${context.runId}:${context.action}`;
}

export function bullMqJobOptions(context: DispatchContext): Record<string, unknown> {
  return {
    jobId: bullMqJobId(context),
    attempts: DEFAULT_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_MS },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  };
}

/** A `RunDispatcher` that puts runs on a BullMQ queue for separate workers. */
export class BullMqDispatcher implements RunDispatcher {
  private constructor(
    private readonly queue: BullMqQueueLike,
    private readonly queueName: string,
  ) {}

  static async create(
    options: BullMqOptions & { module?: BullMqModule } = {},
  ): Promise<BullMqDispatcher> {
    const { Queue } = await loadBullMq(options.module);
    const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
    const queue = new Queue(queueName, connectionOptions(options));
    return new BullMqDispatcher(queue, queueName);
  }

  async dispatch(context: DispatchContext): Promise<void> {
    await this.queue.add('run', context, bullMqJobOptions(context));
  }

  async depth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    return Object.values(counts).reduce((total, value) => total + value, 0);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export interface BullMqConsumerOptions extends BullMqOptions {
  /** The worker whose `executeItem` runs each job. */
  worker: AgentWorker;
  concurrency?: number;
  module?: BullMqModule;
}

/**
 * Consume runs from BullMQ. BullMQ owns retries and backoff here; the run
 * itself is still durable in the store, so a Redis restart or a killed worker
 * resumes from the last checkpoint instead of restarting the work.
 */
export async function startBullMqConsumer(
  options: BullMqConsumerOptions,
): Promise<{ close(): Promise<void> }> {
  const { Worker } = await loadBullMq(options.module);
  const queueName = options.queueName ?? DEFAULT_QUEUE_NAME;
  const consumer = new Worker(
    queueName,
    async (job: BullMqJob) => {
      const context = job.data as DispatchContext;
      const item: QueuedRun = {
        ...context,
        attempt: job.attemptsMade + 1,
        claimedAt: Date.now(),
        claimedBy: 'bullmq',
      };
      // Route through the worker's own accounting so graceful shutdown still
      // waits for in-flight runs, whichever queue delivered them (spec §84).
      await options.worker.executeClaimed(item);
    },
    { ...connectionOptions(options), concurrency: options.concurrency ?? 2 },
  );
  consumer.on('failed', (...args: unknown[]) => {
    const job = args[0] as BullMqJob | undefined;
    options.logger?.warn('bullmq job failed', {
      jobId: job?.id ?? randomUUID(),
      attempts: job?.attemptsMade ?? 0,
    });
  });
  return {
    async close() {
      // Stop pulling first; the caller owns the worker's own drain so the two
      // cannot deadlock waiting on each other.
      await consumer.close();
    },
  };
}

function connectionOptions(options: BullMqOptions): Record<string, unknown> {
  return options.redisUrl ? { connection: { url: options.redisUrl } } : {};
}
