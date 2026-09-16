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
 * Streamable-HTTP transport: one POST per message, with either a JSON body or
 * an SSE stream as the answer. The server may hand back a session id on the
 * initialize response, which must be echoed on every later request.
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
    if (!this.options.auth) return;
    const resolver = this.options.resolveSecret;
    if (!resolver) {
      throw new McpAuthError(this.id, `server requires ${this.options.auth.secretRef} but no secret resolver is configured`);
    }
    let secret: string;
    try {
      secret = await resolver(this.options.auth.secretRef);
    } catch {
      throw new McpAuthError(this.id, `could not resolve ${this.options.auth.secretRef}`);
    }
    const value = this.options.auth.scheme ? `${this.options.auth.scheme} ${secret}` : secret;
    this.headers[this.options.auth.header] = value;
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) throw new McpTransportError(this.id, 'http transport is closed', { retryable: false });
    if (!isRequest(message)) {
      // Notifications are fire-and-forget: a compliant server answers 202 with
      // no body, and one that never answers must not stall the run.
      void this.post(message, { awaitResponse: false }).catch((error: unknown) => {
        this.emitter.emitError(new McpTransportError(this.id, `notification failed: ${describe(error)}`, { cause: error }));
      });
      return;
    }
    await this.post(message, { awaitResponse: true });
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

  private async post(message: unknown, options: { awaitResponse: boolean }): Promise<void> {
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
      clearTimeout(timer);
      throw new McpTransportError(this.id, `POST ${this.options.url} failed: ${describe(error)}`, { cause: error });
    }

    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    const unauthorized = response.status === 401 || response.status === 403;

    if (!options.awaitResponse) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      if (unauthorized) {
        this.emitter.emitError(new McpAuthError(this.id, `server rejected the configured credentials (HTTP ${response.status})`));
      }
      return;
    }

    if (unauthorized) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      throw new McpAuthError(this.id, `server rejected the configured credentials (HTTP ${response.status})`);
    }
    if (response.status === 202 || response.status === 204) {
      clearTimeout(timer);
      return;
    }
    if (!response.ok) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      throw new McpTransportError(this.id, `server responded HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    try {
      if (contentType.includes('text/event-stream') && response.body) {
        await this.readStream(response.body, timeoutMs, () => controller.abort());
        return;
      }
      const body = await this.readBody(response);
      if (body.length === 0) return;
      this.emitter.emitMessage(JSON.parse(body));
    } catch (error) {
      if (error instanceof McpTransportError || error instanceof McpAuthError) throw error;
      throw new McpTransportError(this.id, `could not read the response: ${describe(error)}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A streamable-HTTP server may hold the connection open while it sends
   * server-initiated messages. Frames are read as they arrive and reading stops
   * as soon as this request's own response has been delivered, so a long-lived
   * stream never leaves the run waiting for a socket to close.
   */
  private async readStream(body: ReadableStream<Uint8Array>, timeoutMs: number, abort: () => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const deadline = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
    }, timeoutMs);
    deadline.unref?.();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const message = parseSseFrame(frame);
          if (message !== undefined) {
            this.emitter.emitMessage(message);
            if (hasResponseId(message)) {
              await reader.cancel().catch(() => undefined);
              return;
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
      const trailing = parseSseFrame(buffer);
      if (trailing !== undefined) this.emitter.emitMessage(trailing);
    } catch (error) {
      if (!this.closed) {
        this.emitter.emitError(new McpTransportError(this.id, `stream failed: ${describe(error)}`, { cause: error }));
      }
    } finally {
      clearTimeout(deadline);
      abort();
    }
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
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRequest(message: unknown): boolean {
  return isRecord(message) && message['id'] !== undefined && message['id'] !== null;
}

function hasResponseId(message: unknown): boolean {
  return isRecord(message) && message['id'] !== undefined && message['id'] !== null && !('method' in message);
}

/** `data:` lines of one SSE frame, joined per the SSE spec. */
function parseSseFrame(frame: string): unknown {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  if (data.length === 0) return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}
