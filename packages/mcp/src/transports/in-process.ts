import { TransportEmitter, type McpTransport } from './types.js';

export type MessageHandler = (message: unknown, reply: (message: unknown) => void) => void | Promise<void>;

export interface InProcessTransportOptions {
  id: string;
  /** Receives every message the client sends and may reply synchronously or later. */
  handler: MessageHandler;
}

/**
 * A transport backed by a function instead of a socket. Real servers use
 * stdio or HTTP; this exists so tests, embedded servers and the CLI's `mcp
 * serve` mode can exercise the exact same client code path.
 */
export class InProcessTransport implements McpTransport {
  readonly kind = 'in-process' as const;
  private readonly emitter = new TransportEmitter();
  private closed = false;

  constructor(private readonly options: InProcessTransportOptions) {}

  get id(): string {
    return this.options.id;
  }

  async start(): Promise<void> {
    /* nothing to connect to */
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) return;
    const reply = (response: unknown): void => {
      if (!this.closed) queueMicrotask(() => this.emitter.emitMessage(response));
    };
    await this.options.handler(message, reply);
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
}
