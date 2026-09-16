import type { CircuitBreaker, CircuitBreakerOptions } from './contracts/recovery.js';

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Prevents repeatedly hammering a failing dependency. Shared by providers, MCP
 * servers, HTTP APIs and the database: anything that can be slow or down.
 */
export class DefaultCircuitBreaker implements CircuitBreaker {
  private currentState: State = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private halfOpenCalls = 0;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly openMs: number;
  private readonly halfOpenMaxCalls: number;

  constructor(
    readonly key: string,
    options: CircuitBreakerOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.openMs = options.openMs ?? 30_000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
  }

  state(): State {
    this.maybeTransition();
    return this.currentState;
  }

  private maybeTransition(): void {
    if (this.currentState === 'OPEN' && this.now() - this.openedAt >= this.openMs) {
      this.currentState = 'HALF_OPEN';
      this.successes = 0;
      this.halfOpenCalls = 0;
    }
  }

  isAllowed(): boolean {
    this.maybeTransition();
    if (this.currentState === 'OPEN') return false;
    if (this.currentState === 'HALF_OPEN') return this.halfOpenCalls < this.halfOpenMaxCalls;
    return true;
  }

  recordSuccess(): void {
    this.maybeTransition();
    if (this.currentState === 'HALF_OPEN') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) this.reset();
      return;
    }
    this.failures = 0;
  }

  recordFailure(): void {
    this.maybeTransition();
    this.failures += 1;
    if (this.currentState === 'HALF_OPEN' || this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.currentState = 'OPEN';
    this.openedAt = this.now();
    this.halfOpenCalls = 0;
  }

  private reset(): void {
    this.currentState = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
  }

  /** Claim one of the limited half-open probe slots. */
  claimProbe(): boolean {
    if (this.state() !== 'HALF_OPEN') return this.isAllowed();
    if (this.halfOpenCalls >= this.halfOpenMaxCalls) return false;
    this.halfOpenCalls += 1;
    return true;
  }

  snapshot(): { key: string; state: State; failures: number } {
    return { key: this.key, state: this.state(), failures: this.failures };
  }
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  get(key: string): CircuitBreaker {
    const existing = this.breakers.get(key);
    if (existing) return existing;
    const breaker = new DefaultCircuitBreaker(key, this.options);
    this.breakers.set(key, breaker);
    return breaker;
  }

  list(): CircuitBreaker[] {
    return [...this.breakers.values()];
  }

  reset(key?: string): void {
    if (key) this.breakers.delete(key);
    else this.breakers.clear();
  }
}

