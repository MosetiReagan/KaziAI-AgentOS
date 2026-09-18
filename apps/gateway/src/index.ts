/**
 * `@kazi-ai/agentos-gateway` — the single origin in front of an AgentOS
 * deployment.
 *
 * ```ts
 * import { startGateway, upstreamsFromEnv } from '@kazi-ai/agentos-gateway';
 * const gateway = await startGateway({ ...upstreamsFromEnv(), port: 8080 });
 * ```
 */
export * from './health.js';
export * from './proxy.js';
export * from './router.js';
export * from './server.js';
export * from './types.js';
