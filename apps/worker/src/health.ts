import { createServer, type Server } from 'node:http';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { WorkerStats } from './worker.js';

export interface WorkerHealthOptions {
  store: AgentOSStore;
  stats: () => WorkerStats;
  host?: string;
  port?: number;
}

export interface WorkerHealthServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * A small HTTP surface for container probes (spec §106). The worker is not a
 * control plane; this exists so an orchestrator can tell whether it is alive
 * and ready, and what it is doing.
 */
export async function startWorkerHealthServer(
  options: WorkerHealthOptions,
): Promise<WorkerHealthServer> {
  const server: Server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.url === '/health') {
        send(200, { status: 'ok', service: 'kazi-agentos-worker', time: Date.now() });
        return;
      }
      if (request.url === '/ready' || request.url === '/stats') {
        const store = await options.store.healthCheck();
        const stats = options.stats();
        const ready = store.ok && stats.running;
        send(ready || request.url === '/stats' ? 200 : 503, {
          status: ready ? 'ready' : 'not-ready',
          checks: { store: { ok: store.ok, ...(store.detail ? { detail: store.detail } : {}) } },
          stats,
        });
        return;
      }
      send(404, { error: { code: 'NOT_FOUND', message: `No route for ${request.url ?? '/'}` } });
    })();
  });

  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
