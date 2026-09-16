/**
 * A byte-level channel to one MCP server. Transports are deliberately dumb:
 * framing and correlation live in the JSON-RPC client so stdio, HTTP and
 * in-process servers behave identically.
 */
export interface McpTransport {
  readonly id: string;
  readonly kind: 'stdio' | 'http' | 'in-process';
  /** Bring the channel up. Must be idempotent. */
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): Promise<void>;
}

/** Shared bookkeeping so every transport reports events the same way. */
export class TransportEmitter {
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly errorHandlers: Array<(error: Error) => void> = [];
  private readonly closeHandlers: Array<(reason: string) => void> = [];

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) handler(message);
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) handler(error);
  }

  emitClose(reason: string): void {
    for (const handler of this.closeHandlers) handler(reason);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
