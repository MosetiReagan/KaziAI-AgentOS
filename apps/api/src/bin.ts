#!/usr/bin/env node
import { startApi } from './server.js';

/**
 * `kazi-agentos-api` — start the API with configuration from the environment.
 * Nothing is guessed: an operator can see every knob in `kazi-agent doctor`.
 */
async function main(): Promise<void> {
  const api = await startApi();
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      msg: 'kazi-agentos-api listening',
      url: api.url,
      organizationId: api.context.organizationId,
      projectId: api.context.projectId,
    })}\n`,
  );

  const bootstrapKey = api.context.bootstrap?.key;
  if (bootstrapKey) {
    process.stdout.write(
      `${JSON.stringify({
        level: 'warn',
        msg: 'created a bootstrap admin API key; store it now, it is not shown again',
        organizationId: api.context.organizationId,
        projectId: api.context.projectId,
        apiKey: bootstrapKey,
      })}\n`,
    );
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'shutting down', signal })}\n`);
    await api.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'api failed to start', error: (error as Error).message })}\n`,
  );
  process.exit(1);
});
