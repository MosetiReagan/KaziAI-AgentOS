import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  ToolExecutionError,
  ToolInputError,
  ToolTimeoutError,
  redactString,
  toAgentError,
  toolResult,
  truncateJson,
  type AgentTool,
  type JsonObject,
  type JsonValue,
  type ToolContext,
} from '@kazi-ai/agentos-core';
import { canUseNetwork } from '../permissions.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

const httpInput = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeout_ms: z.number().int().positive().max(300_000).optional(),
  max_response_bytes: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  /**
   * Redirects are not followed by default: each hop would need its own SSRF
   * check and an allowed redirect is a common bypass.
   */
  follow_redirects: z.boolean().default(false),
});

export interface HttpToolOptions {
  /** Overrides the OS resolver; used by tests to simulate DNS answers. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
  maxResponseBytes?: number;
}

export async function createHttpRequestTool(options: HttpToolOptions = {}): Promise<AgentTool> {
  const timeoutDefault = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultMaxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    id: 'http.request',
    description:
      'Make an HTTP request. Only https/http are permitted, private and link-local addresses are blocked by default, and redirects are not followed unless explicitly enabled.',
    kind: 'http',
    risk: 'MEDIUM',
    timeoutMs: 300_000,
    inputSchema: httpInput,
    permissions: { network: { enabled: true } },
    async execute(input: unknown, context: ToolContext) {
      const args = httpInput.parse(input);
      let url: URL;
      try {
        url = new URL(args.url);
      } catch {
        throw new ToolInputError('http.request', `Invalid URL: ${args.url}`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ToolInputError('http.request', `Protocol ${url.protocol} is not permitted`);
      }
      if (url.username || url.password) {
        throw new ToolInputError('http.request', 'Credentials in URLs are not permitted; use a secret:// header reference');
      }
      const permission = canUseNetwork(context.permissions, url.hostname);
      if (!permission.allowed) {
        throw new ToolExecutionError('http.request', permission.reason ?? 'network access denied', {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency: 'idempotent',
          details: { host: url.hostname },
        });
      }
      await assertPublicHost(url.hostname, options.resolveHost);

      const headers = await resolveHeaderSecrets(args.headers ?? {}, context);
      const timeoutMs = args.timeout_ms ?? timeoutDefault;
      const maxBytes = Math.min(args.max_response_bytes ?? defaultMaxBytes, defaultMaxBytes);
      const controller = new AbortController();
      const onAbort = (): void => controller.abort(context.signal.reason);
      context.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
      const started = Date.now();

      try {
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(url.toString(), {
          method: args.method,
          headers,
          ...(args.body === undefined ? {} : { body: args.body }),
          redirect: args.follow_redirects ? 'follow' : 'manual',
          signal: controller.signal,
        });
        if (!args.follow_redirects && response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location') ?? '';
          return toolResult({
            success: true,
            output: {
              status: response.status,
              redirected: true,
              location: redactString(location),
              note: 'redirect not followed; re-request the target URL explicitly after review',
            } as JsonValue,
            idempotency: 'idempotent',
            durationMs: Date.now() - started,
          });
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const truncated = buffer.byteLength > maxBytes;
        const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
        const text = slice.toString('utf8');
        const contentType = response.headers.get('content-type') ?? '';
        const isJson = contentType.includes('json');
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = /^(set-cookie|authorization)$/i.test(key) ? '[redacted]' : redactString(value);
        });
        let parsedBody: JsonValue | undefined;
        if (isJson) {
          try {
            parsedBody = truncateJson(JSON.parse(text) as JsonValue, maxBytes).value;
          } catch {
            parsedBody = undefined;
          }
        }
        return toolResult({
          success: response.status < 400,
          output: {
            status: response.status,
            headers: responseHeaders,
            content_type: contentType,
            body: parsedBody ?? truncateJson(text, maxBytes).value,
            bytes: buffer.byteLength,
            truncated,
          } as JsonValue,
          ...(response.status >= 400
            ? {
                error: {
                  code: 'tool.http_error',
                  message: `HTTP ${response.status}`,
                  category: 'network',
                  retryable: response.status === 429 || response.status >= 500,
                  idempotency: 'idempotent',
                },
              }
            : {}),
          idempotency: 'idempotent',
          durationMs: Date.now() - started,
          metadata: { host: url.hostname, method: args.method },
        });
      } catch (error) {
        const agentError = toAgentError(error);
        if (controller.signal.aborted && !context.signal.aborted) throw new ToolTimeoutError('http.request', timeoutMs);
        throw new ToolExecutionError('http.request', `Request failed: ${redactString(agentError.message)}`, {
          code: agentError.code === 'internal.error' ? 'tool.network_error' : agentError.code,
          retryable: true,
          idempotency: 'idempotent',
          cause: error,
        });
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

async function resolveHeaderSecrets(
  headers: Record<string, string>,
  context: ToolContext,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value.startsWith('secret://')) {
      const reference = value.slice('secret://'.length);
      resolved[key] = await context.secrets.resolve(reference);
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^192\.0\.0\./,
  /^198\.1[89]\./,
];

export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return PRIVATE_V4.some((pattern) => pattern.test(address));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // IPv4-mapped IPv6, e.g. ::ffff:169.254.169.254
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;
}

export const BLOCKED_HOSTNAMES = ['localhost', 'metadata.google.internal', 'metadata', 'instance-data'];

/**
 * SSRF guard. Every resolved address must be public, so a hostname pointing at
 * the cloud metadata service or an internal network is rejected before any
 * connection is attempted.
 */
export async function assertPublicHost(
  hostname: string,
  resolveHost?: (hostname: string) => Promise<string[]>,
): Promise<void> {
  const lowered = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(lowered) || lowered.endsWith('.localhost') || lowered.endsWith('.internal')) {
    throw new ToolInputError('http.request', `Host ${hostname} is not permitted (internal name)`, { host: hostname });
  }
  if (isIP(lowered) !== 0) {
    if (isBlockedAddress(lowered)) {
      throw new ToolInputError('http.request', `Address ${hostname} is in a blocked range`, { host: hostname });
    }
    return;
  }
  const addresses = resolveHost ? await resolveHost(lowered) : await defaultResolve(lowered);
  if (addresses.length === 0) {
    throw new ToolInputError('http.request', `Host ${hostname} did not resolve`, { host: hostname });
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new ToolInputError('http.request', `Host ${hostname} resolves to a blocked address (${address})`, {
        host: hostname,
        address,
      });
    }
  }
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export function networkMetadata(context: ToolContext): JsonObject {
  return { networkEnabled: context.permissions.network?.enabled === true };
}

