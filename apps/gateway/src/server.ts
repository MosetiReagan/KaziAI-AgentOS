import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StructuredLogger, type Logger } from '@kazi-ai/agentos-core';
import { checkUpstreams } from './health.js';
import { createProxy, type HttpProxy, type ProxyExchange } from './proxy.js';
import { GatewayRouter } from './router.js';
import type { GatewayHandle, GatewayOptions, GatewayRouteView, GatewayUpstream } from './types.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface GatewayApp {
  server: Server;
  router: GatewayRouter;
  proxies: HttpProxy[];
  /** Handle a request without binding a port. Exposed for tests. */
  handler(request: IncomingMessage, response: ServerResponse): void;
}

function requestIdFor(request: IncomingMessage): string {
  const supplied = request.headers['x-request-id'];
  const value = Array.isArray(supplied) ? supplied[0] : supplied;
  if (typeof value === 'string' && REQUEST_ID_PATTERN.test(value)) return value;
  return `req_${randomUUID().replace(/-/g, '')}`;
}

function clientIpFor(request: IncomingMessage): string | undefined {
  const address = request.socket.remoteAddress;
  return address ?? undefined;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

export function createGatewayApp(options: GatewayOptions): GatewayApp {
  const logger = options.logger ?? new StructuredLogger({ name: 'kazi-agentos-gateway' });
  const proxies = options.upstreams.map((upstream) => createProxy(upstream, logger));
  const fallback = options.fallback === undefined ? undefined : createProxy(options.fallback, logger);
  const router = new GatewayRouter(proxies, fallback);
  const maxInFlight = options.maxInFlight ?? 512;
  const corsOrigin = options.corsOrigin;

  let inFlight = 0;
  const started = Date.now();

  const record = (exchange: ProxyExchange): void => {
    logger.info('request', {
      upstream: exchange.upstream,
      method: exchange.method,
      path: exchange.path,
      status: exchange.status,
      durationMs: exchange.durationMs,
      requestId: exchange.requestId,
    });
  };

  const routes: GatewayRouteView[] = router.list().map((route) => ({
    name: route.proxy.name,
    url: route.proxy.origin,
    prefixes: route.proxy.prefixes,
    readyPath: route.proxy.readyPath,
  }));

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const requestId = requestIdFor(request);
    const url = request.url ?? '/';
    const pathname = url.startsWith('/') ? (url.split('?')[0] ?? '/') : '/';
    response.setHeader('x-request-id', requestId);
    if (corsOrigin !== undefined) {
      response.setHeader('access-control-allow-origin', corsOrigin);
      response.setHeader('vary', 'origin');
    }

    if (pathname === '/healthz') {
      sendJson(response, 200, {
        status: 'ok',
        service: 'kazi-agentos-gateway',
        inFlight,
        uptimeMs: Date.now() - started,
        time: Date.now(),
      });
      return;
    }

    if (pathname === '/readyz') {
      response.removeHeader('content-length');
      void (async () => {
        const checks = await checkUpstreams(router.list().map((route) => route.proxy));
        const ready = checks.every((check) => check.ok);
        sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not-ready',
          checks,
          time: Date.now(),
        });
      })();
      return;
    }

    if (pathname === '/gateway/routes') {
      sendJson(response, 200, { routes });
      return;
    }

    if (pathname === '/version') {
      sendJson(response, 200, {
        name: 'kazi-agentos-gateway',
        version: '0.1.0',
        node: process.versions.node,
      });
      return;
    }

    if (request.method === 'OPTIONS' && corsOrigin !== undefined) {
      response.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,x-request-id',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }

    const route = router.match(pathname);
    if (route === undefined) {
      void request.resume();
      sendJson(response, 404, {
        error: {
          code: 'NOT_FOUND',
          message: `The gateway has no upstream for ${pathname}`,
          requestId,
        },
      });
      return;
    }

    if (inFlight >= maxInFlight) {
      // Explicit backpressure beats an unbounded queue (spec §83).
      logger.warn('gateway refusing work', { inFlight, maxInFlight, path: pathname, requestId });
      void request.resume();
      sendJson(
        response,
        503,
        {
          error: {
            code: 'RESOURCE_EXHAUSTED',
            message: `The gateway is at its limit of ${maxInFlight} concurrent requests`,
            requestId,
          },
        },
        { 'retry-after': '1' },
      );
      return;
    }

    inFlight += 1;
    void route.proxy
      .handle(request, response, {
        requestId,
        ...(clientIpFor(request) === undefined ? {} : { clientIp: clientIpFor(request) as string }),
        onExchange: record,
      })
      .finally(() => {
        inFlight -= 1;
      });
  };

  const server = createServer(handler);
  // Long-lived streams (SSE, log tails) must not be cut off by Node's default
  // request timeout; the upstream timeout is the real backstop.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;

  return { server, router, proxies, handler };
}

/** Build the gateway and bind it. */
export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const app = createGatewayApp(options);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  await new Promise<void>((resolve) => app.server.listen(port, host, () => resolve()));
  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    server: app.server,
    url: `http://${host}:${boundPort}`,
    host,
    port: boundPort,
    routes: app.router.list().map((route) => ({
      name: route.proxy.name,
      url: route.proxy.origin,
      prefixes: route.proxy.prefixes,
      readyPath: route.proxy.readyPath,
    })),
    stop: () =>
      new Promise<void>((resolve) => {
        // Stop accepting connections, let in-flight requests finish.
        app.server.closeIdleConnections();
        app.server.close(() => resolve());
      }),
  };
}

/** Read the route table from the environment (spec §77). */
export function upstreamsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  upstreams: GatewayUpstream[];
  fallback?: GatewayUpstream;
  corsOrigin?: string;
} {
  const apiUrl = env.KZ_API_URL ?? 'http://127.0.0.1:4000';
  const dashboardUrl = env.KZ_DASHBOARD_URL;
  const upstreams: GatewayUpstream[] = [
    {
      name: 'api',
      url: apiUrl,
      prefixes: ['/api', '/openapi.json', '/docs', '/health', '/ready', '/version'],
      readyPath: '/ready',
    },
  ];
  let fallback: GatewayUpstream | undefined;
  if (dashboardUrl !== undefined && dashboardUrl.length > 0) {
    fallback = { name: 'dashboard', url: dashboardUrl, prefixes: ['/'], readyPath: '/' };
  }
  const corsOrigin = env.KZ_GATEWAY_CORS_ORIGIN;
  return {
    upstreams,
    ...(fallback === undefined ? {} : { fallback }),
    ...(corsOrigin === undefined || corsOrigin.length === 0 ? {} : { corsOrigin }),
  };
}

export type { Logger };
