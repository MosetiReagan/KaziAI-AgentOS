import { redact, type JsonObject, type JsonValue } from '@kazi-ai/agentos-core';

/** Span names mandated by the runtime specification (§50). */
export const SPAN_NAMES = [
  'agent.run',
  'agent.plan',
  'agent.step',
  'agent.tool',
  'agent.model',
  'agent.verification',
  'agent.recovery',
  'agent.checkpoint',
  'agent.approval',
] as const;

export type SpanName = (typeof SPAN_NAMES)[number] | (string & {});

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status: SpanStatus;
  attributes: JsonObject;
  error?: { code: string; message: string };
}

export interface SpanRecorder {
  record(span: Span): void;
  spans(): Span[];
}

/** Keeps spans in memory; the runtime persists them through the event store. */
export class InMemorySpanRecorder implements SpanRecorder {
  private readonly items: Span[] = [];

  constructor(private readonly limit = 10_000) {}

  record(span: Span): void {
    this.items.push(span);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  spans(): Span[] {
    return [...this.items];
  }
}

/**
 * Attributes are redacted before they leave the process: telemetry must never
 * carry credentials (spec §50, §66).
 */
export function redactAttributes(attributes: Record<string, unknown>): JsonObject {
  return redact(attributes) as JsonObject;
}

export interface SpanOptions {
  traceId: string;
  runId: string;
  agentId?: string;
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
}

export interface ActiveSpan {
  readonly span: Span;
  setAttribute(key: string, value: JsonValue): void;
  setAttributes(attributes: Record<string, unknown>): void;
  setStatus(status: SpanStatus, error?: { code: string; message: string }): void;
  end(): Span;
}

/** Minimal span factory, independent of any specific tracing backend. */
export class SpanFactory {
  private counter = 0;

  constructor(
    private readonly recorder: SpanRecorder,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(name: SpanName, options: SpanOptions): ActiveSpan {
    this.counter += 1;
    const span: Span = {
      spanId: `${options.traceId}-${this.counter.toString(36)}`,
      traceId: options.traceId,
      ...(options.parentSpanId ? { parentSpanId: options.parentSpanId } : {}),
      name,
      startedAt: this.now(),
      status: 'unset',
      attributes: {
        'run.id': options.runId,
        ...(options.agentId ? { 'agent.id': options.agentId } : {}),
        ...redactAttributes(options.attributes ?? {}),
      },
    };
    let finished = false;
    const end = (): Span => {
      if (finished) return span;
      finished = true;
      const finishedAt = this.now();
      span.finishedAt = finishedAt;
      span.durationMs = Math.max(0, finishedAt - span.startedAt);
      if (span.status === 'unset') span.status = 'ok';
      this.recorder.record(span);
      return span;
    };
    return {
      span,
      setAttribute: (key, value) => {
        span.attributes[key] = value;
      },
      setAttributes: (attributes) => {
        Object.assign(span.attributes, redactAttributes(attributes));
      },
      setStatus: (status, error) => {
        span.status = status;
        if (error) span.error = error;
      },
      end,
    };
  }

  /** Convenience wrapper for a whole operation. */
  async withSpan<T>(
    name: SpanName,
    options: SpanOptions,
    fn: (span: ActiveSpan) => Promise<T>,
  ): Promise<T> {
    const active = this.start(name, options);
    try {
      const value = await fn(active);
      active.end();
      return value;
    } catch (error) {
      active.setStatus('error', {
        code: (error as { code?: string }).code ?? 'error',
        message: (error as Error).message,
      });
      active.end();
      throw error;
    }
  }
}
