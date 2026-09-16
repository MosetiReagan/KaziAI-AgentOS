import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ConfigurationError,
  ValidationError,
  type AgentOSConfig,
  type ModelProvider,
  type RunLimits,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import {
  AnthropicProvider,
  CustomHttpProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
} from '@kazi-ai/agentos-providers';
import { parseAgentDefinitionYaml, type AgentDefinition } from '@kazi-ai/agentos-agent';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';

export const AGENT_FILE_PATTERN = /\.(ya?ml|json)$/i;
export const DEFAULT_ORGANIZATION = 'org_local';
export const DEFAULT_PROJECT = 'prj_default';

export interface CliContext {
  os: AgentOS;
  cwd: string;
  config: AgentOSConfig;
  close(): Promise<void>;
}

export interface BuildContextOptions {
  cwd?: string;
  config: AgentOSConfig;
  /** Extra tools the caller wants registered, used by tests and examples. */
  registerTools?(os: AgentOS): void | Promise<void>;
}

/**
 * Turn loaded configuration into a running AgentOS. Providers are built only
 * from what the operator configured; nothing is guessed from the environment
 * here, because `loadConfig` already folded environment variables in.
 */
export async function buildContext(options: BuildContextOptions): Promise<CliContext> {
  const cwd = options.cwd ?? process.cwd();
  const config = options.config;

  const os = await createAgentOS({
    dataDir: resolve(cwd, config.storage.dataDir ?? '.kazi'),
    driver: config.storage.driver,
    ...(config.storage.databaseUrl ? { databaseUrl: config.storage.databaseUrl } : {}),
    providers: providersFromConfig(config),
    providersFromEnv: false,
    builtinTools: { terminal: { defaultTimeoutMs: 120_000 } },
    environment: {
      kind: config.environment.kind,
      workspaceRoot: resolve(cwd, config.environment.workspaceRoot),
      snapshotStoreRoot: resolve(cwd, '.kazi/snapshots'),
      ...(config.environment.kind === 'docker'
        ? { dockerImage: config.environment.dockerImage }
        : {}),
      networkEnabled: config.environment.networkEnabled,
    },
    organizationId: DEFAULT_ORGANIZATION,
    projectId: DEFAULT_PROJECT,
    defaultLimits: config.limits,
  });
  await options.registerTools?.(os);
  return {
    os,
    cwd,
    config,
    close: () => os.close(),
  };
}

/** Map configured providers onto concrete adapters, resolving key references. */
export function providersFromConfig(config: AgentOSConfig): ModelProvider[] {
  const providers: ModelProvider[] = [];
  for (const [id, entry] of Object.entries(config.providers)) {
    const apiKey = entry.apiKeyRef ? resolveKeyReference(entry.apiKeyRef) : undefined;
    switch (entry.kind) {
      case 'openai-compatible':
        providers.push(
          new OpenAICompatibleProvider({
            id,
            baseUrl: entry.baseUrl ?? 'https://api.openai.com/v1',
            ...(apiKey ? { apiKey } : {}),
            ...(entry.model ? { defaultModel: entry.model } : {}),
            ...(entry.headers ? { headers: entry.headers } : {}),
          }),
        );
        break;
      case 'anthropic':
        if (!apiKey) throw missingKey(id);
        providers.push(
          new AnthropicProvider({
            id,
            apiKey,
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          }),
        );
        break;
      case 'gemini':
        if (!apiKey) throw missingKey(id);
        providers.push(
          new GeminiProvider({ id, apiKey, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}) }),
        );
        break;
      case 'ollama':
        providers.push(
          new OllamaProvider({ id, ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}) }),
        );
        break;
      case 'http': {
        if (!entry.baseUrl) {
          throw new ConfigurationError(`Provider ${id} of kind http needs a baseUrl`, {
            provider: id,
          });
        }
        providers.push(
          new CustomHttpProvider({
            id,
            url: entry.baseUrl,
            ...(entry.headers ? { headers: entry.headers } : {}),
          }),
        );
        break;
      }
      default: {
        const exhaustive: never = entry.kind;
        throw new ConfigurationError(`Unknown provider kind ${String(exhaustive)}`, {
          provider: id,
        });
      }
    }
  }
  return providers;
}

function missingKey(provider: string): ConfigurationError {
  return new ConfigurationError(
    `Provider ${provider} needs an API key; set it in the environment`,
    {
      provider,
    },
  );
}

/**
 * Resolve an `apiKeyRef`. Secrets are referenced, never inlined (spec §66):
 * `env:NAME` or a bare variable name reads the environment, `secret://x` reads
 * `KAZI_SECRET_x`.
 */
export function resolveKeyReference(reference: string): string | undefined {
  const name = reference.startsWith('env:')
    ? reference.slice(4)
    : reference.startsWith('secret://')
      ? `KAZI_SECRET_${reference
          .slice('secret://'.length)
          .replace(/[^a-zA-Z0-9]+/g, '_')
          .toUpperCase()}`
      : reference;
  return process.env[name];
}

/** Agent definition directories, nearest first. */
export function agentDirectories(cwd: string): string[] {
  return [join(cwd, 'agents'), join(homedir(), '.config', 'kazi-agentos', 'agents')];
}

export function loadAgentDefinitions(cwd: string): AgentDefinition[] {
  const definitions: AgentDefinition[] = [];
  for (const directory of agentDirectories(cwd)) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory).sort()) {
      if (!AGENT_FILE_PATTERN.test(entry)) continue;
      const path = join(directory, entry);
      const text = readFileSync(path, 'utf8');
      try {
        // JSON is a subset of YAML, so one parser covers both file types.
        definitions.push(parseAgentDefinitionYaml(text));
      } catch (error) {
        throw new ValidationError(
          `Failed to load agent definition ${path}: ${(error as Error).message}`,
          { path },
        );
      }
    }
  }
  return definitions;
}

export function findAgentDefinition(cwd: string, agentId: string): AgentDefinition | undefined {
  return loadAgentDefinitions(cwd).find((definition) => definition.id === agentId);
}

export interface ResolvedRunOptions {
  goal: string;
  limits?: RunLimits;
  permissions?: ToolPermissions;
  organizationId: string;
  projectId: string;
}

/** Default tenant scope for a single-operator local install. */
export function tenantScope(flags: { org?: string; project?: string }): {
  organizationId: string;
  projectId: string;
} {
  return {
    organizationId: flags.org ?? process.env['KZ_ORGANIZATION'] ?? DEFAULT_ORGANIZATION,
    projectId: flags.project ?? process.env['KZ_PROJECT'] ?? DEFAULT_PROJECT,
  };
}
