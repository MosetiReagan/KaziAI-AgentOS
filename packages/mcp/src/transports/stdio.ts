import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { McpTransportError } from '../errors.js';
import { TransportEmitter, type McpTransport } from './types.js';

export interface StdioTransportOptions {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Maximum size of a single inbound frame; oversized servers are refused. */
  maxFrameBytes?: number;
  /** Lines the server writes to stderr are diagnostics, never protocol. */
  onStderr?(line: string): void;
}

const DEFAULT_MAX_FRAME = 8 * 1024 * 1024;

/**
 * Newline-delimited JSON over a child process' stdio — the transport MCP
 * defines for locally installed servers.
 */
export class StdioTransport implements McpTransport {
  readonly kind = 'stdio' as const;
  private readonly emitter = new TransportEmitter();
  private child?: ChildProcessWithoutNullStreams;
  private buffer = '';
  private closed = false;
  private started = false;
  private droppedOversizedFrame = false;

  constructor(private readonly options: StdioTransportOptions) {}

  get id(): string {
    return this.options.id;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim().length > 0) this.options.onStderr?.(line);
      }
    });

    child.on('error', (error) => {
      this.emitter.emitError(new McpTransportError(this.id, `failed to start "${this.options.command}": ${error.message}`, { cause: error }));
    });
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.emitter.emitClose(reason);
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        reject(new McpTransportError(this.id, `failed to spawn "${this.options.command}"`, { cause: error, retryable: false }));
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  async send(message: unknown): Promise<void> {
    if (this.closed || !this.child) throw new McpTransportError(this.id, 'stdio transport is not running', { retryable: false });
    const payload = `${JSON.stringify(message)}\n`;
    const accepted = this.child.stdin.write(payload);
    if (!accepted) {
      await new Promise<void>((resolve) => this.child?.stdin.once('drain', () => resolve()));
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
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const max = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME;
    if (this.buffer.length > max) {
      this.buffer = '';
      if (!this.droppedOversizedFrame) {
        this.droppedOversizedFrame = true;
        this.emitter.emitError(new McpTransportError(this.id, `dropped a frame larger than ${max} bytes`, { retryable: false }));
      }
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.emitLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private emitLine(line: string): void {
    try {
      this.emitter.emitMessage(JSON.parse(line));
    } catch (error) {
      this.emitter.emitError(new McpTransportError(this.id, 'server wrote a line that is not JSON', { retryable: false, cause: error }));
    }
  }
}
