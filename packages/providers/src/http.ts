import { ProviderError, redactString, toAgentError } from '@kazi-ai/agentos-core';

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
  /** Retry attempts for transient transport failures. */
  retries?: number;
  /** Whether repeating the call is safe. Non-idempotent calls are not retried by default. */
  idempotent?: boolean;
  fetchImpl?: typeof fetch;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  durationMs: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.min(60_000, date - Date.now()));
}

/**
 * Minimal HTTP client used by every provider adapter. It enforces timeouts,
 * response size limits, and transient-failure retries, and it never puts
 * response bodies containing credentials into error messages verbatim.
 */
export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  const attempts = options.retries ?? (options.idempotent ? 3 : 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
    const started = Date.now();

    try {
      const response = await fetchImpl(options.url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: controller.signal,
      });
      const raw = await readBounded(response, maxBytes);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const result: HttpResponse = {
        status: response.status,
        headers,
        body: raw.body,
        truncated: raw.truncated,
        durationMs: Date.now() - started,
      };
      if (response.status >= 400) {
        const retryable = RETRYABLE_STATUS.has(response.status) && attempt < attempts;
        if (retryable) {
          const delay = parseRetryAfter(headers) ?? Math.min(4_000, 250 * 2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw httpStatusError(result);
      }
      return result;
    } catch (error) {
      lastError = error;
      const agentError = toAgentError(error);
      const transient =
        agentError.code === 'internal.error' &&
        /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout/i.test(agentError.message);
      if (!transient || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(4_000, 250 * 2 ** (attempt - 1))));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw toAgentError(lastError);
}

function httpStatusError(response: HttpResponse): ProviderError {
  let detail = response.body.slice(0, 500);
  try {
    const parsed = JSON.parse(response.body) as { error?: { message?: string; type?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Body is not JSON; keep the truncated raw text.
  }
  const retryable = response.status === 429 || response.status >= 500;
  return new ProviderError('http', `HTTP ${response.status}: ${redactString(detail)}`, {
    code: `provider.http_${response.status}`,
    retryable,
    details: { status: response.status },
  });
}

async function readBounded(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: await response.text(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      chunks.push(value.subarray(0, Math.max(0, value.byteLength - (size - maxBytes))));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'), truncated };
}

export function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

