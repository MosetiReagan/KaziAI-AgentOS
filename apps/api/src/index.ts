/**
 * `@kazi-ai/agentos-api` — the KaziAI AgentOS HTTP surface.
 *
 * ```ts
 * import { startApi } from '@kazi-ai/agentos-api';
 * const api = await startApi({ port: 4000 });
 * ```
 */
export * from './app.js';
export * from './auth.js';
export * from './catalog.js';
export * from './dispatcher.js';
export * from './errors.js';
export * from './http.js';
export { registerStreamRoutes } from './routes/stream.js';
export * from './schemas.js';
export * from './server.js';
export * from './types.js';
export * from './routes/runs.js';
export * from './routes/approvals.js';
export * from './routes/catalog.js';
export * from './routes/health.js';
export * from './routes/identity.js';
