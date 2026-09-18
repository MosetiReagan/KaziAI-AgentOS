import type { AgentEvent } from '../api/types.js';
import { readSseStream, type SseMessage } from './sse.js';

export interface RunStreamHandlers {
  onEvent?: (event: AgentEvent) => void;
  onEnd?: (message: SseMessage) => void;
  onError?: (error: Error) => void;
}

export interface RunStreamOptions extends RunStreamHandlers {
  runId: string;
  /** Where the API lives; empty string means the same origin (the gateway). */
  baseUrl?: string;
  token?: string | null;
  /** Replay from this sequence, then follow live events. */
  afterSequence?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Follow a run over server-sent events. The stream is durable on the server
 * side, so a reconnect with `afterSequence` loses nothing.
 */
export async function followRun(options: RunStreamOptions): Promise<void> {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const query = options.afterSequence === undefined ? '' : `?afterSequence=${options.afterSequence}`;
  const url = `${base}/api/runs/${encodeURIComponent(options.runId)}/events/stream${query}`;
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`The event stream answered ${response.status}`);
    }
    await readSseStream(
      response.body,
      (message) => {
        if (message.event === 'stream.end') {
          options.onEnd?.(message);
          return;
        }
        if (message.event === undefined || message.event === 'message') return;
        try {
          options.onEvent?.(JSON.parse(message.data) as AgentEvent);
        } catch {
          // A frame we cannot parse is not worth tearing the stream down for.
        }
      },
      options.signal ? { signal: options.signal } : {},
    );
  } catch (error) {
    if (options.signal?.aborted) return;
    options.onError?.(error as Error);
  }
}
