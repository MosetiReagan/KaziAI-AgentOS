import type { Span, SpanRecorder } from './spans.js';

interface OtelSpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(endTime?: number): void;
  recordException?(exception: unknown): void;
}

interface OtelTracerLike {
  startSpan(name: string, options?: { startTime?: number; attributes?: Record<string, string | number | boolean> }): OtelSpanLike;
}

interface OtelApiLike {
  trace: { getTracer(name: string, version?: string): OtelTracerLike };
  SpanStatusCode: { OK: number; ERROR: number };
}

/**
 * Export spans through the OpenTelemetry API when a tracer provider is
 * registered, and stay a no-op otherwise. AgentOS never requires a collector to
 * run: durable traces come from the event store, OTel is for integration.
 */
export class OtelSpanRecorder implements SpanRecorder {
  private readonly items: Span[] = [];

  constructor(
    private readonly api: OtelApiLike,
    private readonly tracer = api.trace.getTracer('@kazi-ai/agentos'),
  ) {}

  record(span: Span): void {
    this.items.push(span);
    const otelSpan = this.tracer.startSpan(span.name, {
      startTime: span.startedAt,
      attributes: flatten(span.attributes),
    });
    if (span.error) {
      otelSpan.setStatus({ code: this.api.SpanStatusCode.ERROR, message: span.error.message });
      otelSpan.recordException?.(span.error);
    } else {
      otelSpan.setStatus({ code: this.api.SpanStatusCode.OK });
    }
    otelSpan.end(span.finishedAt ?? span.startedAt);
  }

  spans(): Span[] {
    return [...this.items];
  }
}

/** Attach the recorder to the globally registered provider, if there is one. */
export async function attachOpenTelemetry(): Promise<OtelSpanRecorder | undefined> {
  try {
    const api = (await import('@opentelemetry/api')) as unknown as OtelApiLike;
    return new OtelSpanRecorder(api);
  } catch {
    return undefined;
  }
}

function flatten(attributes: Record<string, unknown>): Record<string, string | number | boolean> {
  const flat: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      flat[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      flat[key] = value.join(',');
    }
  }
  return flat;
}
