import type { FastifyRequest } from 'fastify';
import type { Logger, Principal, RunLimits, SecretProvider } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { AgentOS } from '@kazi-ai/agentos';
import type { ApiKeyAuthenticator } from './auth.js';
import type { AgentCatalog } from './catalog.js';
import type { RunDispatcher } from './dispatcher.js';
import type { WebhookDispatcher } from './webhooks.js';

/** Role ordering used for authorization (spec §64). */
export const ROLE_RANK: Record<Principal['role'], number> = {
  viewer: 0,
  developer: 1,
  operator: 2,
  admin: 3,
};

export interface AuthOptions {
  /**
   * When false the API runs as a single-operator local install and every
   * request is served as the configured tenant's admin. Never enable this on a
   * shared deployment.
   */
  required?: boolean;
  /** Fixed bootstrap key, mainly for CI. When absent one is generated. */
  bootstrapKey?: string;
  /** Create the bootstrap organization, project and key at startup. */
  bootstrap?: boolean;
}

export interface WebhookOptions {
  /** Deliver events to subscriptions (default true). */
  enabled?: boolean;
  /** Attempts per delivery before it is recorded as failed. */
  maxAttempts?: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Base delay for exponential backoff between attempts. */
  backoffMs?: number;
  /** Injectable transport, used by tests. */
  fetchImpl?: typeof fetch;
}

export interface ApiOptions {
  /** Use an existing AgentOS instead of building one from these options. */
  os?: AgentOS;
  dataDir?: string;
  driver?: 'memory' | 'postgres';
  databaseUrl?: string;
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Directories scanned for `*.yaml` / `*.json` agent definitions. */
  agentDirs?: string[];
  /** Default tenant scope; also the tenant used when auth is disabled. */
  organizationId?: string;
  projectId?: string;
  /** Replace the execution dispatcher (the worker app supplies a queue-backed one). */
  dispatcher?: RunDispatcher;
  auth?: AuthOptions;
  webhooks?: WebhookOptions;
  cors?: { origins?: string[] };
  /** Secrets resolved for tools, MCP and webhook signing. */
  secrets?: SecretProvider;
  defaultLimits?: RunLimits;
  /** Whether to discover model providers from the environment. Default true. */
  providersFromEnv?: boolean;
  /** Bind address for `startApi`. */
  host?: string;
  port?: number;
}

/** Everything a route handler needs. Decorated onto the Fastify instance. */
export interface ApiContext {
  readonly os: AgentOS;
  readonly store: AgentOSStore;
  readonly catalog: AgentCatalog;
  readonly dispatcher: RunDispatcher;
  readonly organizationId: string;
  readonly projectId: string;
  readonly options: ApiOptions;
  /** Key management and bootstrap, exposed for the CLI and `doctor`. */
  readonly auth: ApiKeyAuthenticator;
  /** The plaintext bootstrap key, present only when one was just created. */
  readonly bootstrap?: { created: boolean; key?: string };
  /** Signed delivery of run events to subscribed endpoints (spec §98). */
  readonly webhooks?: WebhookDispatcher;
  /** Every route the app actually serves, so the OpenAPI document can be checked. */
  readonly routes: Set<string>;
  now(): number;
  /** Resolve the caller. Never trusts a header it has not verified. */
  principal(request: FastifyRequest): Promise<Principal>;
  /** Close anything this context created. Injected runtimes are left alone. */
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Dependencies every route handler receives. */
    api: ApiContext;
  }
}
