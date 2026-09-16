import { McpAuthError, McpTransportError } from '../errors.js';
import { TransportEmitter, isRecord, type McpTransport } from './types.js';

export interface HttpTransportOptions {
  id: string;
  url: string;
  /** Static headers, e.g. `X-Api-Key`. Never log these. */
  headers?: Record<string, string>;
  /** Resolved at start() so a rotated secret is picked up on reconnect. */
  auth?: { header: string; scheme?: string; secretRef: string };
  resolveSecret?(reference: string): Promise<string>;
  /** Per HTTP request ceiling; the JSON-RPC client also applies its own. */
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_RESPONSE = 4 * 1024 * 1024;

/**
 * Streamable-HTTP transport: one POST per message with a JSON or SSE response.
 * The server may hand back a session id on the initialize response, which must
 * be echoed on every later request.
 */
export class HttpTransport implements McpTransport {
  readonly kind = 'http' as const;
  private readonly emitter = new TransportEmitter();
  private sessionId?: string;
  private closed = false;
  private headers: Record<string, string> = {};

  constructor(private readonly options: HttpTransportOptions) {}

  get id(): string {
    return this.options.id;
  }

  get session(): string | undefined {
    return this.sessionId;
  }

  async start(): Promise<void> {
    this.headers = { ...(this.options.headers ?? {}) };
    if (this.options.auth) {
      const resolver = this.options.resolveSecret;
      if (!resolver) {
        throw new McpAuthError(this.id, `server requires ${this.options.auth.secretRef} but no secret resolver is configured`);
      }
      let secret: string;
      try {
        secret = await resolver(this.options.auth.secretRef);
      } catch (error) {
        throw new McpAuthError(this.id, `could not resolve ${this.options.auth.secretRef}`);
      }
      const value = this.options.auth.scheme ? `${this.options.auth.scheme} ${secret}` : secret;
      this.headers[this.options.auth.header] = value;
    }
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) throw new McpTransportError(this.id, 'http transport is closed', { retryable: false });
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeoutMs = this.options.requestTimeoutMs ?? 60_000;
    const timer = setTimeout(() => controller.abort(new Error('http transport timeout')), timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...this.headers,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      throw new McpTransportError(this.id, `POST ${this.options.url} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (response.status === 401 || response.status === 403) {
      throw new McpAuthError(this.id, `server rejected the configured credentials (HTTP ${response.status})`);
    }
    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      throw new McpTransportError(this.id, `server responded HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await this.readBody(response);
    if (body.length === 0) return;
    if (contentType.includes('text/event-stream')) {
      this.emitSse(body);
      return;
    }
    try {
      this.emitter.emitMessage(JSON.parse(body));
    } catch (error) {
      this.emitter.emitError(new McpTransportError(this.id, 'server responded with invalid JSON', { retryable: false, cause: error }));
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.emitter.onMessage(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.emitter.onError(handler);
  }

  onClose(handler: (reason: string) => void): void {
    this.emitter.onClose(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async readBody(response: Response): Promise<string> {
    const max = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE;
    const text = await response.text();
    if (text.length > max) {
      this.emitter.emitError(new McpTransportError(this.id, `response exceeded ${max} bytes`, { retryable: false }));
      return '';
    }
    return text;
  }

  /** Parse the SSE frames of a streamable-HTTP response. */
  private emitSse(body: string): void {
    for (const frame of body.split(/\n\n/)) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
      if (data.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(data);
        if (isRecord(parsed) && 'method' in parsed && !('id' in parsed)) {
          this.emitter.emitMessage(parsed);
          continue;
        }
        this.emitter.emitMessage(parsed);
      } catch {
        this.emitter.emitError(new McpTransportError(this.id, 'SSE frame was not JSON', { retryable: false }));
      }
    }
  }
}
