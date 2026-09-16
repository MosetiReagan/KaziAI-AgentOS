import { ConfigurationError } from '@kazi-ai/agentos-core';
import { EmbeddedStore } from './embedded/embedded-store.js';
import type { AgentOSStore, CreateStoreOptions } from './store.js';

/**
 * Create the configured storage driver. The Postgres driver is loaded lazily so
 * the runtime works with zero external services by default.
 */
export async function createStore(options: CreateStoreOptions = {}): Promise<AgentOSStore> {
  const driver = options.driver ?? 'memory';
  if (driver === 'memory') {
    const store = new EmbeddedStore(options.dataDir ? { dir: options.dataDir } : {});
    await store.init();
    return store;
  }
  if (!options.databaseUrl) {
    throw new ConfigurationError('Postgres storage requires a databaseUrl');
  }
  const { PrismaStore } = await import('./prisma/prisma-store.js');
  const store = new PrismaStore(options.databaseUrl);
  await store.init();
  return store;
}

