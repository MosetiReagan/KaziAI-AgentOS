import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload(): void;
}

/**
 * Load data, keep the last successful value while reloading, and ignore a
 * response that arrives after the component lost interest.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const current = (generation.current += 1);
    let cancelled = false;
    setLoading(true);
    loaderRef
      .current()
      .then((value) => {
        if (cancelled || generation.current !== current) return;
        setData(value);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (cancelled || generation.current !== current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (cancelled || generation.current !== current) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, reload };
}

/** A clock that ticks only while it is needed, for elapsed-time readouts. */
export function useTicker(active: boolean, intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
