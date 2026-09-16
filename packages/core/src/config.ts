import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigurationError } from './errors.js';
import { deepMerge, toJsonValue, type JsonObject } from './json.js';
import { containsSecretLike } from './redact.js';

const limitsSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    maxDurationSeconds: z.number().positive().optional(),
    maxNetworkRequests: z.number().int().nonnegative().optional(),
    maxStorageBytes: z.number().int().nonnegative().optional(),
    maxRecoveryAttempts: z.number().int().nonnegative().optional(),
    stepTimeoutMs: z.number().int().positive().optional(),
    toolTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const providerEntrySchema = z
  .object({
    kind: z.enum(['openai-compatible', 'anthropic', 'gemini', 'ollama', 'http']),
    model: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKeyRef: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const configSchema = z
  .object({
    env: z.enum(['development', 'test', 'production']).default('development'),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    storage: z
      .object({
        driver: z.enum(['memory', 'postgres']).default('memory'),
        databaseUrl: z.string().optional(),
        /** Directory for the embedded driver's durable file, when set. */
        dataDir: z.string().optional(),
      })
      .default({ driver: 'memory' }),
    queue: z
      .object({
        driver: z.enum(['inline', 'bullmq']).default('inline'),
        redisUrl: z.string().optional(),
        concurrency: z.number().int().positive().default(2),
        maxQueueDepth: z.number().int().positive().default(10_000),
        pollIntervalMs: z.number().int().positive().default(250),
        lockTtlMs: z.number().int().positive().default(60_000),
      })
      .default({ driver: 'inline', concurrency: 2, maxQueueDepth: 10_000, pollIntervalMs: 250, lockTtlMs: 60_000 }),
    environment: z
      .object({
        kind: z.enum(['local', 'docker']).default('local'),
        dockerImage: z.string().default('node:20-bookworm-slim'),
        workspaceRoot: z.string().default('.kazi/workspaces'),
        /** Off by default: agents must not reach the network unless policy allows it. */
        networkEnabled: z.boolean().default(false),
        allowHostExecution: z.boolean().default(true),
      })
      .default({
        kind: 'local',
        dockerImage: 'node:20-bookworm-slim',
        workspaceRoot: '.kazi/workspaces',
        networkEnabled: false,
        allowHostExecution: true,
      }),
    api: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().positive().default(4319),
        apiKey: z.string().optional(),
        corsOrigins: z.array(z.string()).default(['http://localhost:5173']),
      })
      .default({ host: '127.0.0.1', port: 4319, corsOrigins: ['http://localhost:5173'] }),
    providers: z.record(z.string(), providerEntrySchema).default({}),
    limits: limitsSchema.default({}),
    recovery: z
      .object({
        maxAttempts: z.number().int().positive().default(3),
        baseDelayMs: z.number().int().nonnegative().default(250),
        maxDelayMs: z.number().int().positive().default(30_000),
        circuitFailureThreshold: z.number().int().positive().default(5),
        circuitOpenMs: z.number().int().positive().default(30_000),
      })
      .default({ maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 30_000, circuitFailureThreshold: 5, circuitOpenMs: 30_000 }),
    backpressure: z
      .object({
        maxConcurrentRuns: z.number().int().positive().default(25),
        maxRunsPerOrganization: z.number().int().positive().default(5),
        maxToolExecutions: z.number().int().positive().default(50),
        maxContainers: z.number().int().positive().default(10),
        maxQueueDepth: z.number().int().positive().default(10_000),
      })
      .default({
        maxConcurrentRuns: 25,
        maxRunsPerOrganization: 5,
        maxToolExecutions: 50,
        maxContainers: 10,
        maxQueueDepth: 10_000,
      }),
    context: z
      .object({
        maxInputTokens: z.number().int().positive().default(24_000),
        summaryTriggerRatio: z.number().min(0.1).max(1).default(0.75),
        keepRecentObservations: z.number().int().nonnegative().default(12),
      })
      .default({ maxInputTokens: 24_000, summaryTriggerRatio: 0.75, keepRecentObservations: 12 }),
    memory: z
      .object({
        enabled: z.boolean().default(true),
        defaultTtlMs: z.number().int().positive().optional(),
        maxEntryBytes: z.number().int().positive().default(16_384),
      })
      .default({ enabled: true, maxEntryBytes: 16_384 }),
    checkpoint: z
      .object({
        everySteps: z.number().int().positive().default(5),
        everyMs: z.number().int().positive().default(60_000),
        beforeRiskyActions: z.boolean().default(true),
        beforeRecovery: z.boolean().default(true),
        retain: z.number().int().positive().default(50),
      })
      .default({ everySteps: 5, everyMs: 60_000, beforeRiskyActions: true, beforeRecovery: true, retain: 50 }),
    webhooks: z
      .array(
        z.object({
          url: z.string(),
          secretRef: z.string().optional(),
          events: z.array(z.string()).default(['run.completed', 'run.failed', 'approval.requested', 'budget.exceeded']),
          enabled: z.boolean().default(true),
        }),
      )
      .default([]),
    research: z
      .object({
        enabled: z.boolean().default(false),
        experimentName: z.string().optional(),
        variables: z.record(z.string(), z.unknown()).default({}),
      })
      .default({ enabled: false, variables: {} }),
    telemetry: z
      .object({
        enabled: z.boolean().default(false),
        serviceName: z.string().default('kazi-agentos'),
        otlpEndpoint: z.string().optional(),
      })
      .default({ enabled: false, serviceName: 'kazi-agentos' }),
  })
  .strict();

export type AgentOSConfig = z.infer<typeof configSchema>;

export interface ConfigOverrides {
  env?: Record<string, string | undefined>;
  cli?: Record<string, unknown>;
  cwd?: string;
  /** Skip reading files from disk (used by tests). */
  ignoreFiles?: boolean;
}

export interface LoadedConfig {
  config: AgentOSConfig;
  /** Which sources contributed, in increasing precedence order. */
  sources: string[];
  warnings: string[];
}

/** Map of `KZ_*` environment variables onto nested config paths. */
const ENV_MAP: Record<string, string[]> = {
  KZ_ENV: ['env'],
  KZ_LOG_LEVEL: ['logLevel'],
  KZ_STORAGE_DRIVER: ['storage', 'driver'],
  DATABASE_URL: ['storage', 'databaseUrl'],
  KZ_DATA_DIR: ['storage', 'dataDir'],
  KZ_QUEUE_DRIVER: ['queue', 'driver'],
  REDIS_URL: ['queue', 'redisUrl'],
  KZ_QUEUE_CONCURRENCY: ['queue', 'concurrency'],
  KZ_QUEUE_MAX_DEPTH: ['queue', 'maxQueueDepth'],
  KZ_ENVIRONMENT: ['environment', 'kind'],
  KZ_DOCKER_IMAGE: ['environment', 'dockerImage'],
  KZ_WORKSPACE_ROOT: ['environment', 'workspaceRoot'],
  KZ_NETWORK_ENABLED: ['environment', 'networkEnabled'],
  KZ_ALLOW_HOST_EXECUTION: ['environment', 'allowHostExecution'],
  KZ_API_HOST: ['api', 'host'],
  KZ_API_PORT: ['api', 'port'],
  KZ_API_KEY: ['api', 'apiKey'],
  KZ_CORS_ORIGINS: ['api', 'corsOrigins'],
  KZ_MAX_CONCURRENT_RUNS: ['backpressure', 'maxConcurrentRuns'],
  KZ_MAX_RUNS_PER_ORG: ['backpressure', 'maxRunsPerOrganization'],
  KZ_MAX_TOOL_EXECUTIONS: ['backpressure', 'maxToolExecutions'],
  KZ_MAX_CONTAINERS: ['backpressure', 'maxContainers'],
  KZ_TELEMETRY_ENABLED: ['telemetry', 'enabled'],
  KZ_OTLP_ENDPOINT: ['telemetry', 'otlpEndpoint'],
  KZ_RESEARCH_ENABLED: ['research', 'enabled'],
  KZ_MEMORY_ENABLED: ['memory', 'enabled'],
  OPENAI_API_KEY: ['providers', 'openai', 'apiKeyRef'],
  OPENAI_BASE_URL: ['providers', 'openai', 'baseUrl'],
  ANTHROPIC_API_KEY: ['providers', 'anthropic', 'apiKeyRef'],
  GEMINI_API_KEY: ['providers', 'gemini', 'apiKeyRef'],
  OLLAMA_BASE_URL: ['providers', 'ollama', 'baseUrl'],
};

const NUMBER_PATHS = new Set([
  'queue.concurrency',
  'queue.maxQueueDepth',
  'api.port',
  'backpressure.maxConcurrentRuns',
  'backpressure.maxRunsPerOrganization',
  'backpressure.maxToolExecutions',
  'backpressure.maxContainers',
]);

const BOOLEAN_PATHS = new Set([
  'environment.networkEnabled',
  'environment.allowHostExecution',
  'telemetry.enabled',
  'research.enabled',
  'memory.enabled',
]);

const ARRAY_PATHS = new Set(['api.corsOrigins']);

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const existing = cursor[key];
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
}

function envOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(ENV_MAP)) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const dotted = path.join('.');
    let value: unknown = raw;
    if (NUMBER_PATHS.has(dotted)) {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new ConfigurationError(`Environment variable ${key} must be a number`, { key });
      value = parsed;
    } else if (BOOLEAN_PATHS.has(dotted)) {
      value = raw === '1' || raw.toLowerCase() === 'true';
    } else if (ARRAY_PATHS.has(dotted)) {
      value = raw.split(',').map((item) => item.trim()).filter(Boolean);
    } else if (dotted.startsWith('providers.')) {
      const providerId = path[1] as string;
      const field = path[2] as string;
      const kindMap: Record<string, string> = {
        openai: 'openai-compatible',
        anthropic: 'anthropic',
        gemini: 'gemini',
        ollama: 'ollama',
      };
      setPath(out, ['providers', providerId, 'kind'], kindMap[providerId] ?? 'openai-compatible');
      setPath(out, ['providers', providerId, field], value);
      continue;
    }
    setPath(out, path, value);
  }
  return out;
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = path.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
  } catch (error) {
    throw new ConfigurationError(`Failed to parse config file ${path}: ${(error as Error).message}`, { path });
  }
  if (parsed === null || parsed === undefined) return undefined;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigurationError(`Config file ${path} must contain an object`, { path });
  }
  const record = parsed as Record<string, unknown>;
  for (const [key, value] of flatten(record)) {
    if (typeof value === 'string' && containsSecretLike(value)) {
      warnings.push(`Config file ${path} appears to contain a literal secret at "${key}"; use a secret:// reference instead.`);
    }
  }
  return record;
}

function* flatten(value: Record<string, unknown>, prefix = ''): Generator<[string, unknown]> {
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      yield* flatten(item as Record<string, unknown>, path);
    } else {
      yield [path, item];
    }
  }
}

export function projectConfigPaths(cwd: string): string[] {
  return [join(cwd, 'agentos.yaml'), join(cwd, 'agentos.yml'), join(cwd, 'agentos.json')];
}

export function userConfigPaths(): string[] {
  return [join(homedir(), '.config', 'kazi-agentos', 'config.yaml'), join(homedir(), '.kazi-agentos.yaml')];
}

/**
 * Load configuration with explicit precedence:
 * CLI overrides > environment > project config > user config > defaults.
 */
export function loadConfig(overrides: ConfigOverrides = {}): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = ['defaults'];
  let merged: Record<string, unknown> = {};

  const filePaths = overrides.ignoreFiles
    ? []
    : [...userConfigPaths(), ...projectConfigPaths(overrides.cwd ?? process.cwd())];
  for (const path of filePaths) {
    const contents = readConfigFile(path, warnings);
    if (!contents) continue;
    merged = deepMerge(merged, contents);
    sources.push(path);
  }

  const env = overrides.env ?? process.env;
  const envLayer = envOverrides(env as Record<string, string | undefined>);
  if (Object.keys(envLayer).length > 0) {
    merged = deepMerge(merged, envLayer);
    sources.push('environment');
  }

  if (overrides.cli && Object.keys(overrides.cli).length > 0) {
    merged = deepMerge(merged, overrides.cli);
    sources.push('cli');
  }

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid configuration: ${detail}`, { issues: toJsonValue(parsed.error.issues) });
  }

  const config = parsed.data;
  validateCrossField(config);
  return { config, sources, warnings };
}

function validateCrossField(config: AgentOSConfig): void {
  if (config.storage.driver === 'postgres' && !config.storage.databaseUrl) {
    throw new ConfigurationError('storage.driver=postgres requires storage.databaseUrl (DATABASE_URL)');
  }
  if (config.queue.driver === 'bullmq' && !config.queue.redisUrl) {
    throw new ConfigurationError('queue.driver=bullmq requires queue.redisUrl (REDIS_URL)');
  }
  if (config.environment.kind === 'docker' && !config.environment.dockerImage) {
    throw new ConfigurationError('environment.kind=docker requires environment.dockerImage');
  }
}

export function configToJson(config: AgentOSConfig): JsonObject {
  return toJsonValue(config) as JsonObject;
}

export function resolveWorkspaceRoot(config: AgentOSConfig, cwd = process.cwd()): string {
  return resolve(cwd, config.environment.workspaceRoot);
}

