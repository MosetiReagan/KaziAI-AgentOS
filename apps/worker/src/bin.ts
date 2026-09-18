#!/usr/bin/env node
import { startWorker } from './server.js';

/**
 * `kazi-agentos-worker` — claim queued runs and execute them. Configuration
 * comes from the same environment the API reads, so a container can be given
 * one set of variables.
 */
async function main(): Promise<void> {
  const worker = await startWorker({
    concurrency: Number(process.env['KZ_WORKER_CONCURRENCY'] ?? 2),
    pollIntervalMs: Number(process.env['KZ_WORKER_POLL_MS'] ?? 500),
    health: { port: Number(process.env['KZ_WORKER_PORT'] ?? 4100) },
    ...(process.env['KZ_WORKER_ID'] ? { workerId: process.env['KZ_WORKER_ID'] } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      msg: 'kazi-agentos-worker started',
      workerId: worker.worker.workerId,
      health: worker.url,
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
