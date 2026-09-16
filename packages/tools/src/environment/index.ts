import type { ExecutionEnvironment, EnvironmentProvider } from '@kazi-ai/agentos-core';
import { LocalEnvironmentProvider, type LocalEnvironmentOptions } from './local.js';
import { DockerEnvironmentProvider } from './docker.js';

export * from './local.js';
export * from './docker.js';
export * from './snapshot.js';

export interface EnvironmentProviderConfig {
  kind: 'local' | 'docker';
  workspaceRoot: string;
  dockerImage?: string;
  networkEnabled?: boolean;
  snapshotStoreRoot?: string;
  local?: Omit<LocalEnvironmentOptions, 'workspaceDir'>;
  memoryLimit?: string;
  cpuLimit?: number;
}

export function createEnvironmentProvider(config: EnvironmentProviderConfig): EnvironmentProvider {
  if (config.kind === 'docker') {
    return new DockerEnvironmentProvider({
      image: config.dockerImage ?? 'node:20-bookworm-slim',
      networkEnabled: config.networkEnabled ?? false,
      ...(config.snapshotStoreRoot ? { snapshotStoreDir: config.snapshotStoreRoot } : {}),
      ...(config.memoryLimit ? { memoryLimit: config.memoryLimit } : {}),
      ...(config.cpuLimit ? { cpuLimit: config.cpuLimit } : {}),
    });
  }
  return new LocalEnvironmentProvider({
    ...(config.local ?? {}),
    ...(config.snapshotStoreRoot ? { snapshotStoreDir: config.snapshotStoreRoot } : {}),
  });
}

export async function createEnvironment(
  provider: EnvironmentProvider,
  run: { runId: string; organizationId: string; workspaceDir: string },
): Promise<ExecutionEnvironment> {
  return provider.create(run);
}

