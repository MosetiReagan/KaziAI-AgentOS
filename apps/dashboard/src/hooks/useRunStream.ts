import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import type { AgentEvent } from '../api/types.js';
import { isTerminalRunState } from '../lib/state.js';

export interface RunStreamState {
  events: AgentEvent[];
  connected: boolean;
  ended: boolean;
  error: Error | undefined;
  lastSequence: number;
  refresh(): void;
}

const REPLAY_LIMIT = 500;

/**
 * Follow one run: load what already happened from durable storage, then follow
 * the live stream from the last sequence seen. A disconnect is not a loss —
 * reconnecting replays from the sequence, which is why `afterSequence` exists.
 */
export function useRunStream(client: ApiClient, runId: string | undefined): RunStreamState {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const seen = useRef(new Set<string>());

  const append = useCallback((incoming: AgentEvent[]) => {
    setEvents((current) => {
      let next = current;
      for (const event of incoming) {
        if (seen.current.has(event.id)) continue;
        seen.current.add(event.id);
        if (next === current) next = [...current];
        next.push(event);
      }
      if (next === current) return current;
      return next.sort((left, right) => left.sequence - right.sequence);
    });
  }, []);

  useEffect(() => {
    if (runId === undefined) return;
    seen.current = new Set();
    setEvents([]);
    setError(undefined);
    setEnded(false);
    setConnected(false);

    const controller = new AbortController();
    let disposed = false;

    void (async () => {
      const page = await client.listEvents(runId, { limit: REPLAY_LIMIT });
      if (disposed) return;
      append(page.items);
      setConnected(true);

      const run = await client.getRun(runId);
      if (disposed) return;
      const last = page.items.at(-1)?.sequence ?? 0;
      if (isTerminalRunState(run.run.status)) {
        setEnded(true);
        return;
      }
      await client.follow(runId, {
        afterSequence: last,
        signal: controller.signal,
        onEvent: (event) => append([event]),
        onEnd: () => {
          if (!disposed) setEnded(true);
        },
        onError: (cause) => {
          if (!disposed) setError(cause);
        },
      });
    })().catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause : new Error(String(cause)));
    });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [client, runId, nonce, append]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  const lastSequence = events.length === 0 ? 0 : (events[events.length - 1]?.sequence ?? 0);
  return { events, connected, ended, error, lastSequence, refresh };
}
