import { describe, expect, it } from 'vitest';
import {
  AgentError,
  DefaultCircuitBreaker,
  toAgentError,
  ProviderError,
  ToolTimeoutError,
  ValidationError,
  newRunId,
  type Checkpoint,
  type RecoveryContext,
} from '@kazi-ai/agentos-core';
import {
  DEFAULT_RECOVERY_POLICIES,
  DefaultRecoveryEngine,
  FailureClassifier,
  RetryEngine,
  parseRecoveryPolicies,
} from '../src/index.js';

/** Run `fn` and return the (agent) error it threw, asserting that it threw. */
async function captureError(fn: () => Promise<unknown>): Promise<AgentError> {
  try {
    await fn();
  } catch (error) {
    return toAgentError(error);
  }
  throw new Error('expected the operation to fail');
}

function timeoutError(): ToolTimeoutError {
  return new ToolTimeoutError('terminal.exec', 5_000);
}

function contextFor(
  error: AgentError,
  overrides: Partial<RecoveryContext> = {},
  classifier = new FailureClassifier(),
): RecoveryContext {
  return {
    runId: newRunId(),
    attempt: 1,
    error,
    classification: classifier.classify(error),
    actionCommitted: false,
    ...overrides,
  };
}

describe('FailureClassifier', () => {
  const classifier = new FailureClassifier();

  it('maps known error codes onto recovery failure kinds', () => {
    expect(classifier.classify(timeoutError()).kind).toBe('tool_timeout');
    expect(classifier.classify(new ValidationError('bad arguments')).kind).toBe('invalid_arguments');
    expect(classifier.classify(new ProviderError('openai-compatible', 'timed out', { code: 'provider.timeout' })).kind).toBe('provider_unavailable');
    expect(classifier.classify(new ProviderError('openai-compatible', 'bad key', { code: 'provider.authentication' })).kind).toBe('authentication_failure');
    expect(classifier.classify(new AgentError({ code: 'budget.exceeded', message: 'over', category: 'budget' })).kind).toBe('budget_exceeded');
    expect(classifier.classify(new AgentError({ code: 'verification.failed', message: 'tests failed', category: 'validation' })).kind).toBe('verification_failed');
  });

  it('never assumes an unknown error is retryable', () => {
    const classification = classifier.classify(new Error('mystery'));
    expect(classification.kind).toBe('unknown');
    expect(classification.retryable).toBe(false);
    expect(classification.idempotency).toBe('unknown');
  });

  it('carries retryability and idempotency from the error itself', () => {
    const classification = classifier.classify(timeoutError());
    expect(classification.retryable).toBe(true);
    expect(classification.idempotency).toBe('unknown');
    expect(classification.category).toBe('tool');
  });
});

describe('parseRecoveryPolicies', () => {
  it('parses the documented YAML shape', () => {
    const policies = parseRecoveryPolicies({
      recovery: {
        tool_timeout: { strategy: 'retry', max_attempts: 3 },
        authentication_failure: 'ask_human',
        environment_failure: { strategy: 'restore_checkpoint', base_delay_ms: 100, max_delay_ms: 500 },
      },
    });
    expect(policies['tool_timeout']).toEqual({ kind: 'tool_timeout', strategy: 'retry', maxAttempts: 3 });
    expect(policies['authentication_failure']?.strategy).toBe('ask_human');
    expect(policies['environment_failure']?.baseDelayMs).toBe(100);
    expect(policies['environment_failure']?.maxDelayMs).toBe(500);
  });

  it('rejects malformed entries instead of crashing at runtime', () => {
    expect(() => parseRecoveryPolicies({ recovery: { tool_timeout: { strategy: 'retry', max_attempts: -1 } } })).toThrow(
      /non-negative integer/,
    );
    expect(() => parseRecoveryPolicies({ recovery: { tool_timeout: { strategy: 'retry', max_attempts: 'many' } } })).toThrow(
      /non-negative integer/,
    );
    expect(() => parseRecoveryPolicies({ recovery: { tool_timeout: 42 } })).toThrow(/must be a strategy name or a mapping/);
    expect(() => parseRecoveryPolicies({ recovery: { tool_timeout: { max_attempts: 3 } } })).toThrow(/Unknown recovery strategy/);
  });

  it('rejects unknown strategies instead of silently disabling recovery', () => {
    expect(() => parseRecoveryPolicies({ recovery: { tool_timeout: { strategy: 'pray' as never } } })).toThrow(
      /Unknown recovery strategy/,
    );
  });
});

describe('RetryEngine', () => {
  it('retries retryable failures with bounded exponential backoff', async () => {
    const retry = new RetryEngine({ baseDelayMs: 1, maxDelayMs: 4, jitterRatio: 0 });
    let calls = 0;
    const result = await retry.run({
      idempotency: 'idempotent',
      maxAttempts: 4,
      operation: async () => {
        calls += 1;
        if (calls < 3) throw timeoutError();
        return 'ok';
      },
    });

    expect(result.value).toBe('ok');
    expect(result.attempts).toBe(3);
    // 1ms then 2ms of deterministic backoff.
    expect(result.totalDelayMs).toBe(3);
  });

  it('stops immediately on a non-retryable failure', async () => {
    const retry = new RetryEngine({ jitterRatio: 0 });
    let calls = 0;
    await expect(
      retry.run({
        idempotency: 'idempotent',
        maxAttempts: 5,
        operation: async () => {
          calls += 1;
          throw new ValidationError('bad input');
        },
      }),
    ).rejects.toThrow(/bad input/);
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts and surfaces the last error', async () => {
    const retry = new RetryEngine({ baseDelayMs: 1, jitterRatio: 0 });
    let calls = 0;
    const thrown = await captureError(() =>
      retry.run({
        idempotency: 'idempotent',
        maxAttempts: 3,
        operation: async () => {
          calls += 1;
          throw timeoutError();
        },
      }),
    );
    expect(calls).toBe(3);
    expect(thrown.code).toBe('tool.timeout');
  });

  it('refuses to repeat a non-idempotent operation that already executed', async () => {
    const retry = new RetryEngine({ baseDelayMs: 1, jitterRatio: 0 });
    let calls = 0;
    const error = await captureError(() =>
      retry.run({
        idempotency: 'non-idempotent',
        maxAttempts: 3,
        alreadyExecuted: async () => true,
        operation: async () => {
          calls += 1;
          throw new ProviderError('openai-compatible', 'boom', {
            code: 'provider.timeout',
            retryable: true,
            idempotency: 'non-idempotent',
          });
        },
      }),
    );

    expect(calls).toBe(1);
    expect(error.code).toBe('recovery.retry_unsafe');
  });

  it('retries a non-idempotent operation only once the caller proved it never ran', async () => {
    const retry = new RetryEngine({ baseDelayMs: 1, jitterRatio: 0 });
    let calls = 0;
    const result = await retry.run({
      idempotency: 'non-idempotent',
      maxAttempts: 3,
      alreadyExecuted: async () => false,
      operation: async () => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError('openai-compatible', 'boom', {
            code: 'provider.timeout',
            retryable: true,
            idempotency: 'non-idempotent',
          });
        }
        return 'recovered';
      },
    });
    expect(result.value).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('honours an abort signal between attempts', async () => {
    const retry = new RetryEngine({ baseDelayMs: 5_000, jitterRatio: 0 });
    const controller = new AbortController();
    const pending = retry.run({
      idempotency: 'idempotent',
      maxAttempts: 3,
      signal: controller.signal,
      operation: async () => {
        controller.abort();
        throw timeoutError();
      },
    });
    await expect(pending).rejects.toThrow(/aborted|cancel/i);
  });
});

describe('DefaultRecoveryEngine', () => {
  it('classifies and applies the default tool-timeout policy', async () => {
    const engine = new DefaultRecoveryEngine({ awaitBackoff: false });
    const context = contextFor(timeoutError());
    const decision = await engine.decide(context);

    expect(decision.strategy).toBe('retry_with_backoff');
    expect(decision.delayMs).toBeGreaterThan(0);
    expect(decision.terminal).toBeUndefined();

    const result = await engine.execute(decision, context);
    expect(result.applied).toBe(true);
    expect(result.detail?.['awaited']).toBe(false);
  });

  it.each([
    ['budget.exceeded', 'budget', 'budget_exceeded'],
    ['policy.denied', 'policy', 'policy_denied'],
    ['run.cancelled', 'state', 'cancelled'],
  ])('terminates on terminal failure %s', async (code, category, kind) => {
    const engine = new DefaultRecoveryEngine();
    const error = new AgentError({ code, message: code, category: category as never });
    const context = contextFor(error);
    expect(context.classification.kind).toBe(kind);

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('terminate');
    expect(decision.terminal).toBe(true);
  });

  it('asks a human when authentication fails', async () => {
    const requests: string[] = [];
    const engine = new DefaultRecoveryEngine({
      requestHuman: async (input) => {
        requests.push(input.reason);
        return { approvalId: 'apr_1' };
      },
    });
    const error = new ProviderError('openai-compatible', 'invalid key', {
      code: 'provider.authentication',
      retryable: false,
    });
    const context = contextFor(error);

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('ask_human');

    const result = await engine.execute(decision, context);
    expect(result.applied).toBe(true);
    expect(result.detail?.['approvalId']).toBe('apr_1');
    expect(requests).toHaveLength(1);
  });

  it('restores the latest checkpoint when the environment breaks', async () => {
    const checkpoint = { id: 'cp_1', sequence: 4, stateVersion: 9 } as unknown as Checkpoint;
    const engine = new DefaultRecoveryEngine({
      checkpoints: {
        get: async () => undefined,
        latest: async () => checkpoint,
      },
    });
    const error = new AgentError({ code: 'environment.error', message: 'container gone', category: 'environment' });
    const context = contextFor(error);

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('restore_checkpoint');

    const result = await engine.execute(decision, context);
    expect(result.applied).toBe(true);
    expect(result.detail?.['checkpointId']).toBe('cp_1');
    expect(result.detail?.['sequence']).toBe(4);
  });

  it('fails over to the fallback provider and records which one took over', async () => {
    const switched: string[] = [];
    const engine = new DefaultRecoveryEngine({
      failover: async () => ({ provider: 'ollama', model: 'llama-local' }),
      switchProvider: async ({ to }) => {
        switched.push(`${to.provider}/${to.model}`);
        return to;
      },
    });
    const error = new ProviderError('openai-compatible', 'upstream down', {
      code: 'provider.unavailable',
      retryable: true,
    });
    const context = contextFor(error, { metadata: { provider: { provider: 'openai-compatible', model: 'primary' } } });

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('switch_provider');
    expect(decision.provider).toEqual({ provider: 'ollama', model: 'llama-local' });

    const result = await engine.execute(decision, context);
    expect(result.applied).toBe(true);
    expect(switched).toEqual(['ollama/llama-local']);
  });

  it('falls back to a bounded retry when no fallback provider exists', async () => {
    const engine = new DefaultRecoveryEngine({ awaitBackoff: false });
    const error = new ProviderError('openai-compatible', 'upstream down', {
      code: 'provider.unavailable',
      retryable: true,
    });
    const decision = await engine.decide(contextFor(error));
    expect(decision.strategy).toBe('retry_with_backoff');
  });

  it('never retries a non-idempotent action whose journal intent never committed', async () => {
    const engine = new DefaultRecoveryEngine();
    const error = new ProviderError('openai-compatible', 'stream died', {
      code: 'provider.timeout',
      retryable: true,
      idempotency: 'non-idempotent',
    });
    const context = contextFor(error, { metadata: { journalPending: true } });

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('ask_human');
    expect(decision.reason).toContain('uncommitted');
  });

  it('skips a non-idempotent action that already committed', async () => {
    const engine = new DefaultRecoveryEngine();
    const error = new ProviderError('openai-compatible', 'late failure', {
      code: 'provider.timeout',
      retryable: true,
      idempotency: 'non-idempotent',
    });
    const context = contextFor(error, { actionCommitted: true });

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('skip_step');
  });

  it('stops retrying when the dependency circuit breaker is open', async () => {
    const breaker = new DefaultCircuitBreaker('tool:terminal.exec', { failureThreshold: 1 });
    breaker.recordFailure();
    const engine = new DefaultRecoveryEngine({
      circuitBreakers: { get: () => breaker },
    });
    const context = contextFor(timeoutError(), {
      attempt: 2,
      toolId: 'terminal.exec',
      metadata: { dependency: 'tool:terminal.exec' },
    });

    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('ask_human');
    expect(decision.reason).toContain('circuit breaker');
  });

  it('terminates once the configured attempts are exhausted', async () => {
    const engine = new DefaultRecoveryEngine({
      policies: { tool_timeout: { kind: 'tool_timeout', strategy: 'retry', maxAttempts: 2 } },
    });
    const context = contextFor(timeoutError(), { attempt: 2 });
    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('terminate');
    expect(decision.reason).toContain('exhausted');
  });

  it('re-plans when verification fails instead of giving up', async () => {
    const engine = new DefaultRecoveryEngine();
    const context = contextFor(
      new AgentError({ code: 'verification.failed', message: 'tests still failing', category: 'validation' }),
    );
    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('replan');
  });

  it('re-plans when the model produced invalid arguments', async () => {
    const engine = new DefaultRecoveryEngine();
    const context = contextFor(new ValidationError('step 3 has no tool'));
    const decision = await engine.decide(context);
    expect(decision.strategy).toBe('replan');
    expect((await engine.execute(decision, context)).applied).toBe(true);
  });

  it('reports honestly when it cannot apply a strategy', async () => {
    const engine = new DefaultRecoveryEngine();
    const context = contextFor(new AgentError({ code: 'environment.error', message: 'gone', category: 'environment' }));
    const result = await engine.execute({ strategy: 'restore_checkpoint', reason: 'no store' }, context);
    expect(result.applied).toBe(false);
    expect(result.detail?.['reason']).toContain('no checkpoint store');
  });

  it('exposes the default policy table for inspection', () => {
    const engine = new DefaultRecoveryEngine();
    expect(engine.policyFor('tool_timeout')).toEqual(DEFAULT_RECOVERY_POLICIES['tool_timeout']);
    expect(engine.policyFor('does_not_exist').strategy).toBe('replan');
  });

  it('uses run-specific policy overrides', async () => {
    const engine = new DefaultRecoveryEngine({
      policies: { tool_timeout: { kind: 'tool_timeout', strategy: 'skip_step', maxAttempts: 3 } },
    });
    const decision = await engine.decide(contextFor(timeoutError()));
    expect(decision.strategy).toBe('skip_step');
  });

  it('is deterministic about backoff when jitter is disabled', async () => {
    const engine = new DefaultRecoveryEngine({ retry: new RetryEngine({ baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0 }) });
    const first = await engine.decide(contextFor(timeoutError(), { attempt: 1 }));
    const second = await engine.decide(contextFor(timeoutError(), { attempt: 1 }));
    // The recovery policy's own base delay wins over the retry engine default:
    // 500ms base at attempt 2 is a 1000ms ceiling, and jitter is off.
    expect(first.delayMs).toBe(1_000);
    expect(second.delayMs).toBe(1_000);
  });
});
