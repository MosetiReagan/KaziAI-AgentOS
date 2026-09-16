import { McpError, McpProtocolError, McpTimeoutError, McpTransportError } from './errors.js';
import type { McpTransport } from './transports/types.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcSuccess | JsonRpcFailure;

/** JSON-RPC error codes defined by the protocol. */
export const JSONRPC_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  if (candidate.jsonrpc !== '2.0') return false;
  return 'result' in candidate || 'error' in candidate;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { jsonrpc?: unknown; id?: unknown; method?: unknown };
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string' && candidate.id === undefined;
}

export interface PendingCall {
  method: string;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface JsonRpcClientOptions {
  serverId: string;
  transport: McpTransport;
  /** Per-request ceiling. A server that never answers must not wedge a run. */
  requestTimeoutMs?: number;
  onNotification?(notification: JsonRpcNotification): void;
  /**
   * Answer a server-initiated request (sampling, roots, elicitation). The
   * returned value is sent back as the result; returning `undefined` declines
   * the request so a server is never left waiting for an answer that will not
   * come.
   */
  onServerRequest?(request: { id: string | number; method: string; params?: unknown }): Promise<unknown> | unknown;
  onTransportError?(error: Error): void;
}

/**
 * Minimal, correlation-safe JSON-RPC 2.0 client.
 *
 * Every request carries an id, every call has its own timeout, and an
 * out-of-order or unmatched response is dropped with a protocol error rather
 * than being handed to the wrong waiter.
 */
export class JsonRpcClient {
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: JsonRpcClientOptions) {
    options.transport.onMessage((message) => this.handleMessage(message));
    options.transport.onError((error) => {
      options.onTransportError?.(error);
      this.failAll(error);
    });
    options.transport.onClose((reason) => this.failAll(new McpTransportError(options.serverId, `transport closed: ${reason}`)));
  }

  get serverId(): string {
    return this.options.serverId;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) throw new McpTransportError(this.options.serverId, 'client is closed', { retryable: false });
    const id = String(this.nextId++);
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(this.options.serverId, method, timeoutMs));
      }, timeoutMs);
      // Node keeps the event loop alive for pending timers; the transport owns
      // the real lifetime of the connection, so unref the watchdog.
      timer.unref?.();
      this.pending.set(id, {
        method,
        startedAt: Date.now(),
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.send(message).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        // A classified failure (auth, timeout, protocol) keeps its code: only
        // genuinely unclassified send errors become transport errors.
        if (error instanceof McpError) {
          reject(error);
          return;
        }
        reject(
          error instanceof Error
            ? new McpTransportError(this.options.serverId, `failed to send ${method}: ${error.message}`, { cause: error })
            : new McpTransportError(this.options.serverId, `failed to send ${method}`),
        );
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    await this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Reply to a server-initiated request (e.g. sampling or roots). */
  async respond(id: string | number, result: unknown): Promise<void> {
    await this.send({ jsonrpc: '2.0', id, result });
  }

  async respondError(id: string | number, code: number, message: string): Promise<void> {
    await this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /** Reject every in-flight call; used on close and on transport failure. */
  failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new McpTransportError(this.options.serverId, 'client closed', { retryable: false }));
    await this.options.transport.close();
  }

  private async send(message: JsonRpcMessage | JsonRpcRequest | JsonRpcNotification): Promise<void> {
    await this.options.transport.send(message);
  }

  private answerServerRequest(request: { id: string | number; method: string; params?: unknown }): void {
    const handler = this.options.onServerRequest;
    if (!handler) {
      void this.respondError(request.id, JSONRPC_CODES.methodNotFound, `unsupported request: ${request.method}`).catch(() => undefined);
      return;
    }
    void Promise.resolve()
      .then(() => handler(request))
      .then(async (result) => {
        if (result === undefined) {
          await this.respondError(request.id, JSONRPC_CODES.methodNotFound, `unsupported request: ${request.method}`);
          return;
        }
        await this.respond(request.id, result);
      })
      .catch(() => {
        void this.respondError(request.id, JSONRPC_CODES.internalError, `failed to handle ${request.method}`).catch(() => undefined);
      });
  }

  private handleMessage(message: unknown): void {
    if (isJsonRpcNotification(message)) {
      this.options.onNotification?.(message);
      return;
    }
    if (typeof message === 'object' && message !== null) {
      const candidate = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
      // A server-initiated request must be answered, otherwise the server may
      // block waiting for us.
      if (candidate.method !== undefined && candidate.id !== undefined) {
        this.answerServerRequest({
          id: candidate.id as string | number,
          method: String(candidate.method),
          params: (message as { params?: unknown }).params,
        });
        return;
      }
    }
    if (!isJsonRpcMessage(message)) {
      this.options.onTransportError?.(new McpProtocolError(this.options.serverId, 'received a malformed JSON-RPC message'));
      return;
    }
    if (message.id === null || message.id === undefined) {
      this.options.onTransportError?.(new McpProtocolError(this.options.serverId, 'response carried no id'));
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (!pending) {
      // Late responses (e.g. a call that already timed out) are dropped; they
      // must never satisfy a different caller.
      return;
    }
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if ('error' in message) {
      pending.reject(
        new McpProtocolError(this.options.serverId, `${pending.method} failed: ${message.error.message}`, {
          rpcCode: message.error.code,
        }),
      );
      return;
    }
    pending.resolve(message.result);
  }
}
