import { AgentError, toAgentError } from './errors.js';
import { SystemClock, type Clock } from './clock.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Full jitter is on by default; disable for deterministic tests. */
  jitter?: boolean;
  clock?: Clock;
  signal?: AbortSignal;
  shouldRetry?: (error: AgentError, attempt: number) => boolean;
  onRetry?: (error: AgentError, attempt: number, delayMs: number) => void;
  random?: () => number;
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
}

/**
 * Exponential backoff with jitter. Never retries blindly: the caller opts in
 * via error classification through `shouldRetry`.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const clock = options.clock ?? new SystemClock();
  const base = options.baseDelayMs ?? 200;
  const max = options.maxDelayMs ?? 30_000;
  const random = options.random ?? Math.random;
  let lastError: AgentError | undefined;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw toAgentError(options.signal.reason, 'operation.aborted');
    }
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = toAgentError(error);
      const allowed = options.shouldRetry
        ? options.shouldRetry(lastError, attempt)
        : lastError.retryable;
      if (!allowed || attempt === options.maxAttempts) break;
      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = options.jitter === false ? ceiling : Math.floor(random() * ceiling);
      options.onRetry?.(lastError, attempt, delay);
      if (delay > 0) await clock.sleep(delay, options.signal);
    }
  }
  throw (
    lastError ?? new AgentError({ code: 'retry.exhausted', message: 'Retry failed', category: 'internal' })
  );
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface TimeoutOptions {
  timeoutMs: number;
  onTimeout?: () => void;
  message?: string;
  external?: AbortSignal;
}

/** Bound an operation by wall-clock time; the callee cooperates via the signal. */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, options: TimeoutOptions): Promise<T> {
  const controller = new AbortController();
  const abortFromExternal = (): void => controller.abort(options.external?.reason);
  if (options.external) {
    if (options.external.aborted) abortFromExternal();
    else options.external.addEventListener('abort', abortFromExternal, { once: true });
  }
  const timer = setTimeout(() => {
    options.onTimeout?.();
    controller.abort(
      new AgentError({
        code: 'timeout',
        message: options.message ?? `Operation exceeded ${options.timeoutMs}ms`,
        category: 'resource',
        retryable: true,
        idempotency: 'unknown',
      }),
    );
  }, options.timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    if (options.external) options.external.removeEventListener('abort', abortFromExternal);
  }
}

/** Run promises with bounded concurrency, preserving input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new SystemClock().sleep(ms, signal);
}

/** Merge multiple abort signals into one. */
export function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

