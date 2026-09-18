import type { FastifyInstance } from 'fastify';
import { buildApi, type ApiHandle } from './app.js';
import type { ApiOptions } from './types.js';

export interface StartedApi extends ApiHandle {
  url: string;
  host: string;
  port: number;
  /** Stop accepting connections and release resources (spec §84). */
  stop(): Promise<void>;
}

/**
 * Start the HTTP API. Services are started in order — store, runtime, then the
 * listener — so `/ready` can never report ready before the store is up.
 */
export async function startApi(options: ApiOptions = {}): Promise<StartedApi> {
  const readEnv = (name: string): string | undefined => options.env?.[name] ?? process.env[name];
  const host = options.host ?? readEnv('KZ_API_HOST') ?? '127.0.0.1';
  const port = Number(options.port ?? readEnv('KZ_API_PORT') ?? readEnv('PORT') ?? 4000);

  const handle = await buildApi(options);
  await handle.app.listen({ host, port });

  const address = handle.app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    ...handle,
    url: `http://${host}:${boundPort}`,
    host,
    port: boundPort,
    stop: () => handle.close(),
  };
}

export type { FastifyInstance };
