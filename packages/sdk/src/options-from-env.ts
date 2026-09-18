import type { AgentOSOptions } from './agentos.js';

export const ENV_DEFAULT_ORGANIZATION = 'org_local';
export const ENV_DEFAULT_PROJECT = 'prj_default';

/** Read a variable, preferring an injected environment over the process one. */
export type EnvReader = (name: string) => string | undefined;

export interface AgentOSOptionsFromEnv {
  dataDir: string;
  driver: 'memory' | 'postgres';
  databaseUrl?: string;
  providersFromEnv: boolean;
  organizationId: string;
  projectId: string;
  environment: NonNullable<AgentOSOptions['environment']>;
  builtinTools: NonNullable<AgentOSOptions['builtinTools']>;
  /** Every `KZ_*` / connection variable that was actually read. */
  sources: Record<string, string | undefined>;
}

/**
 * One definition of "how an AgentOS process is configured", shared by the API
 * and the worker so a container can be handed a single set of variables and
 * both services read them the same way (spec §77).
 *
 * Nothing here guesses: an unknown `KZ_STORAGE_DRIVER` is treated as the
 * embedded store, and a Postgres driver without a `DATABASE_URL` fails later
 * with an explicit configuration error rather than silently using memory.
 */
export function agentOSOptionsFromEnv(
  read: EnvReader,
  cwd: string = process.cwd(),
): AgentOSOptionsFromEnv {
  const dataDir = read('KZ_DATA_DIR') ?? `${cwd}/.kazi`;
  const driver = read('KZ_STORAGE_DRIVER') === 'postgres' ? 'postgres' : 'memory';
  const databaseUrl = read('DATABASE_URL');
  const organizationId = read('KZ_ORGANIZATION') ?? ENV_DEFAULT_ORGANIZATION;
  const projectId = read('KZ_PROJECT') ?? ENV_DEFAULT_PROJECT;

  return {
    dataDir,
    driver,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    providersFromEnv: true,
    organizationId,
    projectId,
    environment: {
      kind: read('KZ_ENVIRONMENT') === 'docker' ? 'docker' : 'local',
      workspaceRoot: `${dataDir}/workspaces`,
      networkEnabled: read('KZ_NETWORK_ENABLED') === 'true',
    },
    builtinTools: { terminal: { defaultTimeoutMs: 120_000 } },
    sources: {
      KZ_DATA_DIR: read('KZ_DATA_DIR'),
      KZ_STORAGE_DRIVER: read('KZ_STORAGE_DRIVER'),
      DATABASE_URL: databaseUrl,
      KZ_ORGANIZATION: read('KZ_ORGANIZATION'),
      KZ_PROJECT: read('KZ_PROJECT'),
      KZ_ENVIRONMENT: read('KZ_ENVIRONMENT'),
      KZ_NETWORK_ENABLED: read('KZ_NETWORK_ENABLED'),
    },
  };
}
