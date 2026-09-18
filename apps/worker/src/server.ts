import { createAgentOS, type AgentOS, type AgentOSOptions } from '@kazi-ai/agentos';
import { StructuredLogger, type Logger } from '@kazi-ai/agentos-core';
import { StoreRunQueue, type RunQueue } from './queue.js';
import { AgentWorker, type WorkerStats } from './worker.js';
import { startBullMqConsumer } from './bullmq.js';
import { startWorkerHealthServer } from './health.js';

export interface WorkerAppOptions extends AgentOSOptions {
  os?: AgentOS;
  queue?: RunQueue;
  /**
   * Where work comes from: the durable store queue (default, zero extra
   * services) or BullMQ over Redis (spec §43). `KZ_QUEUE` picks it in the
   * deployment images so the worker and the API always agree.
   */
  queueBackend?: 'store' | 'bullmq';
  /** Redis connection for `queueBackend: 'bullmq'`. */
  redisUrl?: string;
  /** Injected BullMQ module, so the queue wiring is testable without Redis. */
  bullMqModule?: import('./bullmq.js').BullMqModule;
  concurrency?: number;
  pollIntervalMs?: number;
  staleClaimMs?: number;
  workerId?: string;
  logger?: Logger;
  /** Health endpoint; set to false to run without one. */
  health?: { host?: string; port?: number } | false;
}

export interface StartedWorker {
  worker: AgentWorker;
  os: AgentOS;
  queue: RunQueue;
  stats(): WorkerStats;
  /** Stop claiming, drain, and release resources (spec §84). */
  stop(): Promise<void>;
  url?: string;
}

/** Compose a store, a queue, a runtime and the worker that drains them. */
export async function startWorker(options: WorkerAppOptions = {}): Promise<StartedWorker> {
  const logger = options.logger ?? new StructuredLogger({ name: 'kazi-agentos-worker' });
  const ownsOs = options.os === undefined;
  const os =
    options.os ??
    (await createAgentOS({
      ...options,
      logger,
      builtinTools: options.builtinTools ?? { terminal: { defaultTimeoutMs: 120_000 } },
    }));
  const organizationId = os.organizationId;
  const queue =
    options.queue ??
    new StoreRunQueue({
      store: os.store,
      workerId: options.workerId ?? 'worker',
      logger,
      ...(organizationId ? { organizationId } : {}),
    });

  const worker = new AgentWorker({
    os,
    queue,
    logger,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.staleClaimMs === undefined ? {} : { staleClaimMs: options.staleClaimMs }),
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
  });

  const health =
    options.health === false
      ? undefined
      : await startWorkerHealthServer({
          store: os.store,
          stats: () => worker.statsSnapshot(),
          ...(options.health?.host === undefined ? {} : { host: options.health.host }),
          port: options.health?.port ?? 0,
        });
  void health;

  let consumer: { close(): Promise<void> } | undefined;
  if ((options.queueBackend ?? 'store') === 'bullmq') {
    consumer = await startBullMqConsumer({
      worker,
      ...(options.redisUrl === undefined ? {} : { redisUrl: options.redisUrl }),
      ...(options.bullMqModule === undefined ? {} : { module: options.bullMqModule }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    worker.beginServing();
  } else {
    worker.start();
  }

  return {
    worker,
    os,
    queue,
    stats: () => worker.statsSnapshot(),
    ...(health ? { url: health.url } : {}),
    async stop() {
      // Stop pulling, drain what is already running, then close the store.
      await consumer?.close();
      await worker.stop();
      await health?.close();
      if (ownsOs) await os.close();
    },
  };
}
