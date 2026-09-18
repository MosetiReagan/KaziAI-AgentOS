import type { FastifyInstance } from 'fastify';

/** Liveness and readiness (spec §106). Readiness checks the durable store. */
export function registerHealthRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/health', async () => ({
    status: 'ok',
    service: 'kazi-agentos-api',
    time: context.now(),
  }));

  app.get('/ready', async (_request, reply) => {
    const store = await context.store.healthCheck();
    const ready = store.ok;
    if (!ready) reply.code(503);
    return {
      status: ready ? 'ready' : 'not-ready',
      checks: {
        store: { ok: store.ok, ...(store.detail ? { detail: store.detail } : {}) },
        dispatcher: { ok: true, detail: context.dispatcher.constructor.name },
      },
      time: context.now(),
    };
  });

  app.get('/version', async () => ({
    name: 'kazi-agentos-api',
    version: '0.1.0',
    runtime: 'AgentOSRuntime',
  }));
}
