import {
  AgentError,
  SystemClock,
  toAgentError,
  type Clock,
  type FailureClassification,
} from '@kazi-ai/agentos-core';
import { FailureClassifier } from './classify.js';

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Full jitter by default. Set to 0 for deterministic tests. */
  jitterRatio?: number;
  random?: () => number;
}

export interface RetryEngineOptions extends BackoffOptions {
  classifier?: FailureClassifier;
  clock?: Clock;
}

export interface RetryRunOptions<T> {
  operation(attempt: number): Promise<T>;
  /** Class of the operation, used to decide whether a retry is safe at all. */
  idempotency: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /**
   * Called before re-running a non-idempotent operation. Returning `true` means
   * the work already happened, so the runtime must not repeat it.
   */
  alreadyExecuted?(): Promise<boolean>;
  onRetry?(input: { attempt: number; error: AgentError; classification: FailureClassification; delayMs: number }): void | Promise<void>;
  /** Overrides classification for retry eligibility (e.g. per-run policy). */
  shouldRetry?(classification: FailureClassification, attempt: number): boolean;
}

export interface RetryRunResult<T> {
  value: T;
  attempts: number;
  totalDelayMs: number;
  classifications: FailureClassification[];
}

/**
 * Exponential backoff with jitter, plus the two rules that make retries safe:
 * only classified-retryable failures are retried, and non-idempotent work is
 * verified as "not yet applied" before it is re-attempted (spec §32, §37).
 */
export class RetryEngine {
  private readonly classifier: FailureClassifier;
  private readonly clock: Clock;
  private readonly defaults: Required<Omit<BackoffOptions, 'random'>>;
  private readonly random: () => number;

  constructor(options: RetryEngineOptions = {}) {
    this.classifier = options.classifier ?? new FailureClassifier();
    this.clock = options.clock ?? new SystemClock();
    this.random = options.random ?? Math.random;
    this.defaults = {
      baseDelayMs: options.baseDelayMs ?? 250,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      jitterRatio: options.jitterRatio ?? 1,
    };
  }

  classify(error: AgentError | Error): FailureClassification {
    return this.classifier.classify(error);
  }

  /** Capped exponential backoff, optionally reduced by jitter. */
  delayFor(
    attempt: number,
    options: { baseDelayMs?: number; maxDelayMs?: number; jitterRatio?: number } = {},
  ): number {
    const base = options.baseDelayMs ?? this.defaults.baseDelayMs;
    const max = options.maxDelayMs ?? this.defaults.maxDelayMs;
    const jitterRatio = options.jitterRatio ?? this.defaults.jitterRatio;
    const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
    if (jitterRatio <= 0) return ceiling;
    const floor = ceiling * (1 - jitterRatio);
    return Math.round(floor + this.random() * (ceiling - floor));
  }

  async run<T>(options: RetryRunOptions<T>): Promise<RetryRunResult<T>> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const classifications: FailureClassification[] = [];
    let totalDelayMs = 0;
    let lastError: AgentError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) throw toAgentError(options.signal.reason, 'operation.aborted');
      try {
        const value = await options.operation(attempt);
        return { value, attempts: attempt, totalDelayMs, classifications };
      } catch (error) {
        const agentError = toAgentError(error);
        lastError = agentError;
        const classification = this.classifier.classify(agentError);
        classifications.push(classification);

        const eligible = options.shouldRetry
          ? options.shouldRetry(classification, attempt)
          : classification.retryable && !classification.terminal;
        if (!eligible || attempt === maxAttempts) break;

        await this.assertSafeToRepeat(options, classification, attempt);

        const delayMs = this.delayFor(attempt, {
          ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
          ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
        });
        totalDelayMs += delayMs;
        await options.onRetry?.({ attempt, error: agentError, classification, delayMs });
        if (delayMs > 0) await this.clock.sleep(delayMs, options.signal);
      }
    }
    throw lastError ?? new AgentError({ code: 'retry.exhausted', message: 'Retry failed', category: 'internal' });
  }

  /**
   * Re-running work that is not idempotent can duplicate side effects. Before
   * the second attempt we ask the caller (which consults the action journal)
   * whether the work already landed.
   */
  private async assertSafeToRepeat<T>(
    options: RetryRunOptions<T>,
    classification: FailureClassification,
    attempt: number,
  ): Promise<void> {
    const unsafe = classification.idempotency === 'non-idempotent' || options.idempotency === 'non-idempotent';
    if (!unsafe) return;
    if (options.alreadyExecuted) {
      const executed = await options.alreadyExecuted();
      if (!executed) return;
      throw new AgentError({
        code: 'recovery.retry_unsafe',
        message: 'Refusing to retry a non-idempotent operation that already executed',
        category: 'state',
        retryable: false,
        idempotency: 'non-idempotent',
        details: { attempt, kind: classification.kind },
      });
    }
    throw new AgentError({
      code: 'recovery.retry_unsafe',
      message: 'Refusing to retry a non-idempotent operation without a way to verify whether it ran',
      category: 'state',
      retryable: false,
      idempotency: 'non-idempotent',
      details: { attempt, kind: classification.kind },
    });
  }
}
