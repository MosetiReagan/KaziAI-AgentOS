import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import type { Logger } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import { ApiKeyAuthenticator, localPrincipal } from './auth.js';
import { AgentCatalog } from './catalog.js';
import { InProcessDispatcher, type RunDispatcher } from './dispatcher.js';
import { WebhookDispatcher } from './webhooks.js';
import { errorBody, toApiError } from './errors.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerStreamRoutes } from './routes/stream.js';
import type { ApiContext, ApiOptions } from './types.js';

export interface ApiHandle {
  app: FastifyInstance;
  context: ApiContext;
  /** Close the HTTP server and everything the context owns. */
  close(): Promise<void>;
}

export const DEFAULT_ORGANIZATION = 'org_local';
export const DEFAULT_PROJECT = 'prj_default';

/** Build the HTTP layer without binding a port. Tests use this directly. */
export async function buildApi(options: ApiOptions = {}): Promise<ApiHandle> {
  const context = await createApiContext(options);
  const app = Fastify({
    logger: false,
    // Bodies are small control-plane payloads; large tool output belongs in
    // artifacts, never in a request body.
    bodyLimit: 1_048_576,
  });
  app.decorate('api', context);

  const origins = options.cors?.origins ?? [];
  await app.register(cors, {
    origin: origins.length === 0 ? false : origins.includes('*') ? true : origins,
    credentials: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.statusCode >= 500) {
      context.os.runtime.logger.error('request failed', {
        method: request.method,
        url: request.url,
        code: apiError.code,
        error: apiError.message,
      });
    }
    reply.code(apiError.statusCode).send(errorBody(apiError));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(
      errorBody({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: `No route for ${request.method} ${request.url}`,
        name: 'ApiError',
      } as never),
    );
  });

  app.addHook('onClose', async () => {
    await context.close();
  });

  registerHealthRoutes(app);
  registerRunRoutes(app);
  registerApprovalRoutes(app);
  registerCatalogRoutes(app);
  registerIdentityRoutes(app);
  registerStreamRoutes(app);
  registerWebhookRoutes(app);

  return {
    app,
    context,
    close: () => app.close(),
  };
}

export async function createApiContext(options: ApiOptions = {}): Promise<ApiContext> {
  const readEnv = (name: string): string | undefined => options.env?.[name] ?? process.env[name];
  const organizationId =
    options.organizationId ?? readEnv('KZ_ORGANIZATION') ?? DEFAULT_ORGANIZATION;
  const projectId = options.projectId ?? readEnv('KZ_PROJECT') ?? DEFAULT_PROJECT;

  const ownsOs = options.os === undefined;
  const os: AgentOS =
    options.os ??
    (await createAgentOS({
      dataDir: options.dataDir ?? readEnv('KZ_DATA_DIR') ?? `${process.cwd()}/.kazi`,
      driver: options.driver ?? (readEnv('KZ_STORAGE_DRIVER') === 'postgres' ? 'postgres' : 'memory'),
      ...(options.databaseUrl ?? readEnv('DATABASE_URL')
        ? { databaseUrl: options.databaseUrl ?? readEnv('DATABASE_URL') }
        : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.defaultLimits ? { defaultLimits: options.defaultLimits } : {}),
      providersFromEnv: options.providersFromEnv ?? true,
      organizationId,
      projectId,
      builtinTools: { terminal: { defaultTimeoutMs: 120_000 } },
      environment: {
        kind: readEnv('KZ_ENVIRONMENT') === 'docker' ? 'docker' : 'local',
        workspaceRoot: `${options.dataDir ?? readEnv('KZ_DATA_DIR') ?? `${process.cwd()}/.kazi`}/workspaces`,
        networkEnabled: readEnv('KZ_NETWORK_ENABLED') === 'true',
      },
    }));

  const catalog = new AgentCatalog({
    os,
    dirs: options.agentDirs ?? [options.dataDir ? `${options.dataDir}/agents` : 'agents'],
  });

  const dispatcher: RunDispatcher =
    options.dispatcher ?? new InProcessDispatcher(os.runtime, options.logger);

  // Authentication is on unless an operator explicitly turns it off for a
  // single-tenant local install. Turning it off is a deliberate act, and it is
  // the only way to get an implicit principal.
  const authRequired = options.auth?.required ?? readEnv('KZ_API_AUTH') !== 'none';
  const auth = new ApiKeyAuthenticator({
    store: os.store,
    organizationId,
    projectId,
    ...(options.auth?.bootstrapKey ?? readEnv('KZ_API_BOOTSTRAP_KEY')
      ? { bootstrapKey: options.auth?.bootstrapKey ?? readEnv('KZ_API_BOOTSTRAP_KEY') }
      : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const bootstrap: { created: boolean; key?: string } =
    authRequired && (options.auth?.bootstrap ?? readEnv('KZ_API_BOOTSTRAP') !== '0')
      ? await auth.bootstrap()
      : { created: false };

  const implicit = localPrincipal(organizationId, projectId);

  // Webhooks follow the runtime's own event bus, so a delivery happens exactly
  // once per event in this process and is recorded durably either way.
  const webhooksEnabled = options.webhooks?.enabled ?? readEnv('KZ_WEBHOOKS') !== 'off';
  const webhooks = webhooksEnabled
    ? new WebhookDispatcher({
        store: os.store,
        bus: os.runtime.bus,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.webhooks?.maxAttempts === undefined
          ? {}
          : { maxAttempts: options.webhooks.maxAttempts }),
        ...(options.webhooks?.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.webhooks.timeoutMs }),
        ...(options.webhooks?.backoffMs === undefined
          ? {}
          : { backoffMs: options.webhooks.backoffMs }),
        ...(options.webhooks?.fetchImpl ? { fetchImpl: options.webhooks.fetchImpl } : {}),
      })
    : undefined;
  webhooks?.start();

  const context: ApiContext = {
    os,
    store: os.store as AgentOSStore,
    catalog,
    dispatcher,
    organizationId,
    projectId,
    options,
    auth,
    ...(webhooks ? { webhooks } : {}),
    ...(bootstrap.key ? { bootstrap: { created: bootstrap.created, key: bootstrap.key } } : {}),
    now: () => Date.now(),
    principal: (request) => (authRequired ? auth.authenticate(request) : Promise.resolve(implicit)),
    close: async () => {
      await webhooks?.close();
      await dispatcher.close?.();
      if (ownsOs) await os.close();
    },
  };
  return context;
}

export type { Logger };
