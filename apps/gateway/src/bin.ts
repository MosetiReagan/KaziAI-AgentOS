#!/usr/bin/env node
import { startGateway, upstreamsFromEnv } from './server.js';

/**
 * `kazi-agentos-gateway` — proxy the API, the dashboard and the event streams
 * they share onto one origin.
 */
async function main(): Promise<void> {
  const env = process.env;
  const gateway = await startGateway({
    ...upstreamsFromEnv(env),
    host: env.KZ_GATEWAY_HOST ?? '0.0.0.0',
    port: Number(env.KZ_GATEWAY_PORT ?? env.PORT ?? 8080),
    ...(env.KZ_GATEWAY_MAX_IN_FLIGHT === undefined
      ? {}
      : { maxInFlight: Number(env.KZ_GATEWAY_MAX_IN_FLIGHT) }),
  });

  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      msg: 'kazi-agentos-gateway listening',
      url: gateway.url,
      routes: gateway.routes,
    })}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'shutting down', signal })}\n`);
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      msg: 'gateway failed to start',
      error: (error as Error).message,
    })}\n`,
  );
  process.exit(1);
});
