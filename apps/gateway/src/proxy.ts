import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@kazi-ai/agentos-core';
import type { GatewayUpstream } from './types.js';

/**
 * Headers that describe a single hop and must not be forwarded (RFC 9110
 * §7.6.1). `transfer-encoding` is dropped too: Node re-frames the body itself,
 * and forwarding both a stale `content-length` and a `transfer-encoding` is a
 * request-smuggling primitive.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ProxyExchange {
  upstream: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
}

export interface ProxyRequestContext {
  requestId: string;
  clientIp?: string;
  onExchange?: (exchange: ProxyExchange) => void;
}

export interface HttpProxy {
  readonly name: string;
  /** The upstream origin, without a trailing slash. */
  readonly origin: string;
  readonly prefixes: string[];
  readonly readyPath: string | false;
  /** Proxy one request. Always ends the response, success or failure. */
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: ProxyRequestContext,
  ): Promise<void>;
}

function forwardedHeaders(
  headers: IncomingHttpHeaders,
  context: ProxyRequestContext,
  target: URL,
): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name)) continue;
    if (value === undefined) continue;
    result[name] = value;
  }
  const prior = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : '';
  const clientIp = context.clientIp ?? '';
  if (clientIp.length > 0) {
    result['x-forwarded-for'] = prior.length > 0 ? `${prior}, ${clientIp}` : clientIp;
  }
  const host = typeof headers.host === 'string' ? headers.host : '';
  if (host.length > 0) result['x-forwarded-host'] = host;
  result['x-forwarded-proto'] = target.protocol === 'https:' ? 'https' : 'http';
  result['x-request-id'] = context.requestId;
  return result;
}

function joinedPath(basePath: string, requestUrl: string | undefined): string {
  const suffix = requestUrl ?? '/';
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  if (base.length === 0) return suffix.startsWith('/') ? suffix : `/${suffix}`;
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}

function errorBody(code: string, message: string, requestId: string): string {
  return JSON.stringify({ error: { code, message, requestId } });
}

/**
 * Create a streaming reverse proxy for one upstream. The body is piped in both
 * directions without buffering, which is what makes server-sent events and
 * large downloads work through the edge.
 */
export function createProxy(upstream: GatewayUpstream, logger: Logger): HttpProxy {
  const target = new URL(upstream.url);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const timeoutMs = upstream.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: upstream.name,
    origin: upstream.url.endsWith('/') ? upstream.url.slice(0, -1) : upstream.url,
    prefixes: upstream.prefixes,
    readyPath: upstream.readyPath ?? false,
    handle(request, response, context) {
      const startedAt = Date.now();
      const method = request.method ?? 'GET';
      const path = joinedPath(target.pathname, request.url);

      return new Promise<void>((resolve) => {
        let settled = false;
        let timedOut = false;
        let clientGone = false;

        const finish = (status: number): void => {
          if (settled) return;
          settled = true;
          context.onExchange?.({
            upstream: upstream.name,
            method,
            path,
            status,
            durationMs: Date.now() - startedAt,
            requestId: context.requestId,
          });
          resolve();
        };

        const fail = (status: number, code: string, message: string): void => {
          if (response.headersSent || response.writableEnded) {
            response.destroy();
            finish(status);
            return;
          }
          const body = errorBody(code, message, context.requestId);
          response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
            'x-request-id': context.requestId,
          });
          response.end(body);
          finish(status);
        };

        const proxied = transport(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port === '' ? undefined : Number(target.port),
            method,
            path,
            headers: forwardedHeaders(request.headers, context, target),
          },
          (upstreamResponse) => {
            const status = upstreamResponse.statusCode ?? 502;
            const headers: IncomingHttpHeaders = {};
            for (const [key, value] of Object.entries(upstreamResponse.headers)) {
              if (HOP_BY_HOP.has(key.toLowerCase())) continue;
              if (value === undefined) continue;
              headers[key] = value;
            }
            headers['x-request-id'] = context.requestId;
            headers['x-kazi-upstream'] = upstream.name;
            response.writeHead(status, headers);
            // We have bytes flow: stop the time-to-first-byte clock so a legitimately
            // idle stream (an SSE run with no events yet) is not cut off. The
            // upstream's own timeouts govern the rest of the exchange.
            proxied.setTimeout(0);
            upstreamResponse.pipe(response);
            upstreamResponse.on('end', () => finish(status));
            upstreamResponse.on('error', () => {
              response.destroy();
              finish(status);
            });
            response.on('close', () => {
              upstreamResponse.destroy();
              finish(status);
            });
          },
        );

        proxied.setTimeout(timeoutMs, () => {
          timedOut = true;
          proxied.destroy(new Error(`no response within ${timeoutMs}ms`));
        });

        proxied.on('error', (error: Error) => {
          if (clientGone) {
            finish(499);
            return;
          }
          const detail = (error as NodeJS.ErrnoException).code ?? error.name;
          logger.warn('gateway upstream request failed', {
            upstream: upstream.name,
            method,
            path,
            detail,
            requestId: context.requestId,
          });
          if (timedOut) {
            fail(504, 'UPSTREAM_TIMEOUT', `${upstream.name} did not answer within ${timeoutMs}ms`);
            return;
          }
          fail(502, 'UPSTREAM_UNAVAILABLE', `${upstream.name} is unavailable (${detail})`);
        });

        // A client that walks away must not keep the upstream working.
        const abandon = (): void => {
          if (request.complete) return;
          clientGone = true;
          proxied.destroy();
          if (!response.writableEnded) response.destroy();
          finish(499);
        };
        request.on('close', abandon);
        response.on('close', () => {
          if (!response.writableFinished) abandon();
        });

        request.pipe(proxied);
      });
    },
  };
}
