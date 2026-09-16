/** Injectable time source so runtime behaviour is reproducible in tests. */
export interface Clock {
  now(): number;
  /** Monotonic milliseconds; never moves backwards. */
  monotonic(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  monotonic(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Deterministic clock for tests; time only moves when explicitly advanced. */
export class FixedClock implements Clock {
  private current: number;
  private readonly timers: Array<{ at: number; resolve: () => void }> = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  monotonic(): number {
    return this.current;
  }

  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.timers.filter((timer) => timer.at <= this.current);
    for (const timer of due) {
      this.timers.splice(this.timers.indexOf(timer), 1);
      timer.resolve();
    }
    await Promise.resolve();
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + ms, resolve });
    });
  }
}

