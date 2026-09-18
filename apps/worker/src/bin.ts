#!/usr/bin/env node
import { agentOSOptionsFromEnv } from '@kazi-ai/agentos';
import { startWorker } from './server.js';

/**
 * `kazi-agentos-worker` — claim queued runs and execute them.
 *
 * Configuration comes from the same environment the API reads, because both
 * are one process boundary apart in a deployment: a container gets one set of
 * variables and a worker must not silently fall back to a different store than
 * the API it is draining (spec §44).
 */
async function main(): Promise<void> {
  const env = process.env;
  const readEnv = (name: string): string | undefined => env[name];
  const worker = await startWorker({
    ...agentOSOptionsFromEnv(readEnv),
    concurrency: Number(env['KZ_WORKER_CONCURRENCY'] ?? 2),
    pollIntervalMs: Number(env['KZ_WORKER_POLL_MS'] ?? 500),
    health: {
      host: env['KZ_WORKER_HOST'] ?? '127.0.0.1',
      port: Number(env['KZ_WORKER_PORT'] ?? 4100),
    },
    ...(env['KZ_WORKER_ID'] ? { workerId: env['KZ_WORKER_ID'] } : {}),
    queueBackend: env['KZ_QUEUE'] === 'bullmq' ? 'bullmq' : 'store',
    ...(env['KZ_REDIS_URL'] ?? env['REDIS_URL']
      ? { redisUrl: (env['KZ_REDIS_URL'] ?? env['REDIS_URL']) as string }
      : {}),
  });
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      msg: 'kazi-agentos-worker started',
      workerId: worker.worker.workerId,
      health: worker.url,
      store: agentOSOptionsFromEnv(readEnv).sources.KZ_STORAGE_DRIVER === 'postgres' ? 'postgres' : 'embedded',
      queue: env['KZ_QUEUE'] === 'bullmq' ? 'bullmq' : 'store',
    })}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'draining worker', signal })}\n`);
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'worker failed to start', error: (error as Error).message })}\n`,
  );
  process.exit(1);
});
