import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryEventBus,
  InMemoryLockManager,
  captureLogger,
  canonicalize,
  createEvent,
  hashObject,
  idempotencyKey,
  isUlid,
  mapConcurrent,
  newRunId,
  redact,
  redactString,
  retry,
  toAgentError,
  truncateJson,
} from '../src/index.js';

describe('identifiers', () => {
  it('generates prefixed, sortable ULIDs', () => {
    const first = newRunId(1_700_000_000_000);
    const second = newRunId(1_700_000_000_000);
    expect(first.startsWith('run_')).toBe(true);
    expect(isUlid(first.slice(4))).toBe(true);
    expect(second > first).toBe(true);
  });
});

describe('deterministic hashing', () => {
  it('is insensitive to key order', () => {
    expect(hashObject({ a: 1, b: [2, { c: 3 }] })).toBe(hashObject({ b: [2, { c: 3 }], a: 1 }));
  });

  it('derives stable idempotency keys', () => {
    const key = idempotencyKey({ runId: 'run_1', step: 2, toolId: 'filesystem.read', arguments: { path: 'a.ts' } });
    const same = idempotencyKey({ runId: 'run_1', step: 2, toolId: 'filesystem.read', arguments: { path: 'a.ts' } });
    const different = idempotencyKey({ runId: 'run_1', step: 3, toolId: 'filesystem.read', arguments: { path: 'a.ts' } });
    expect(key).toBe(same);
    expect(key).not.toBe(different);
  });

  it('canonicalizes nested structures', () => {
    expect(canonicalize({ z: new Date(0), a: new Set([1]) })).toEqual({ a: [1], z: '1970-01-01T00:00:00.000Z' });
  });
});

describe('redaction', () => {
  it('scrubs credentials from strings', () => {
    expect(redactString('token=sk-abcdefghijklmnop')).toContain('[redacted]');
    expect(redactString('ghp_ABCDEFGHIJKLMNOPQRSTUVWX')).toBe('[redacted]');
    expect(redactString('nothing sensitive')).toBe('nothing sensitive');
  });

  it('redacts sensitive keys deeply without mutating the input', () => {
    const input = { authorization: 'Bearer x', nested: { apiKey: 'k', keep: 'ok' } };
    const output = redact(input) as typeof input;
    expect(output.authorization).toBe('[redacted]');
    expect(output.nested).toMatchObject({ apiKey: '[redacted]', keep: 'ok' });
    expect(input.authorization).toBe('Bearer x');
  });
});

describe('truncation', () => {
  it('bounds large payloads and reports truncation', () => {
    const big = 'x'.repeat(5_000);
    const result = truncateJson({ big }, 512);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.value), 'utf8')).toBeLessThan(1_024);
  });

  it('leaves small payloads untouched', () => {
    const result = truncateJson({ small: true }, 512);
    expect(result).toEqual({ value: { small: true }, truncated: false });
  });
});

describe('retry with classification', () => {
  it('retries retryable errors and reports the attempt count', async () => {
    const clock = new FixedClock();
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error('boom'), {});
        return 'ok';
      },
      {
        maxAttempts: 5,
        clock,
        baseDelayMs: 0,
        jitter: false,
        shouldRetry: () => true,
      },
    );
    expect(result).toEqual({ value: 'ok', attempts: 3 });
  });

  it('applies exponential backoff with jitter and reports each delay', async () => {
    const clock = new FixedClock();
    const delays: number[] = [];
    const retryPromise = retry(
      async (attempt) => {
        if (attempt < 4) throw Object.assign(new Error('flaky'), {});
        return 'done';
      },
      {
        maxAttempts: 5,
        baseDelayMs: 100,
        clock,
        random: () => 1,
        shouldRetry: () => true,
        onRetry: (_error, _attempt, delayMs) => delays.push(delayMs),
      },
    );
    for (const step of [100, 200, 400]) {
      await Promise.resolve();
      await clock.advance(step);
    }
    await expect(retryPromise).resolves.toEqual({ value: 'done', attempts: 4 });
    expect(delays).toEqual([100, 200, 400]);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      retry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error('nope'), {});
        },
        { maxAttempts: 4, shouldRetry: () => false },
      ),
    ).rejects.toBeTruthy();
    expect(attempts).toBe(1);
  });
});

describe('mapConcurrent', () => {
  it('preserves ordering while bounding concurrency', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('event bus', () => {
  it('filters events by run and type and supports replay', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event.type), { runId: 'run_a' });
    await bus.publish(createEvent({ type: 'run.created', runId: 'run_a', organizationId: 'org', projectId: 'prj', sequence: 1 }));
    await bus.publish(createEvent({ type: 'run.created', runId: 'run_b', organizationId: 'org', projectId: 'prj', sequence: 1 }));
    expect(seen).toEqual(['run.created']);
    unsubscribe();
    await bus.publish(createEvent({ type: 'run.started', runId: 'run_a', organizationId: 'org', projectId: 'prj', sequence: 2 }));
    expect(seen).toHaveLength(1);
    expect(bus.replay({ runId: 'run_a' })).toHaveLength(2);
  });
});

describe('lock manager', () => {
  it('serializes critical sections and releases on failure', async () => {
    const locks = new InMemoryLockManager();
    const order: string[] = [];
    const first = locks.withLock('run_1', async () => {
      order.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a-end');
    });
    const second = locks.withLock('run_1', async () => {
      order.push('b-start');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    expect(locks.size()).toBe(0);
  });

  it('refuses non-blocking acquisition of a held lock', async () => {
    const locks = new InMemoryLockManager();
    await locks.acquire('key', { wait: false });
    await expect(locks.acquire('key', { wait: false })).rejects.toMatchObject({ code: 'concurrency.conflict' });
  });
});

describe('logger', () => {
  it('emits structured records and never leaks secrets', () => {
    const capture = captureLogger();
    capture.logger.info('calling provider', { apiKey: 'sk-abcdefghijklmnop', runId: 'run_1' });
    expect(capture.records[0]).toMatchObject({ level: 'info', msg: 'calling provider', apiKey: '[redacted]' });
  });
});

describe('error normalization', () => {
  it('never loses the classification of an AgentError', () => {
    const error = toAgentError(new Error('boom'));
    expect(error.category).toBe('internal');
    expect(error.code).toBe('internal.error');
    expect(toAgentError(error)).toBe(error);
  });
});
