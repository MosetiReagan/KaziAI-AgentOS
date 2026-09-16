import { describe, expect, it } from 'vitest';
import { DefaultCircuitBreaker } from '../src/index.js';

describe('circuit breaker', () => {
  it('opens after the failure threshold and rejects calls', () => {
    const breaker = new DefaultCircuitBreaker('provider:openai', { failureThreshold: 3, openMs: 1_000 }, () => 0);
    expect(breaker.state()).toBe('CLOSED');
    for (let index = 0; index < 3; index += 1) breaker.recordFailure();
    expect(breaker.state()).toBe('OPEN');
    expect(breaker.isAllowed()).toBe(false);
  });

  it('half-opens after the cool-down and closes after enough successes', () => {
    let now = 0;
    const breaker = new DefaultCircuitBreaker('mcp:github', { failureThreshold: 2, openMs: 100, successThreshold: 2 }, () => now);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isAllowed()).toBe(false);
    now = 150;
    expect(breaker.state()).toBe('HALF_OPEN');
    expect(breaker.claimProbe()).toBe(true);
    breaker.recordSuccess();
    expect(breaker.state()).toBe('HALF_OPEN');
    breaker.recordSuccess();
    expect(breaker.state()).toBe('CLOSED');
    expect(breaker.isAllowed()).toBe(true);
  });

  it('re-opens immediately when a half-open probe fails', () => {
    let now = 0;
    const breaker = new DefaultCircuitBreaker('http', { failureThreshold: 1, openMs: 10 }, () => now);
    breaker.recordFailure();
    now = 20;
    expect(breaker.state()).toBe('HALF_OPEN');
    breaker.recordFailure();
    expect(breaker.state()).toBe('OPEN');
    expect(breaker.isAllowed()).toBe(false);
  });

  it('resets failure counts after a success in the closed state', () => {
    const breaker = new DefaultCircuitBreaker('db', { failureThreshold: 3 }, () => 0);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.state()).toBe('CLOSED');
  });
});

