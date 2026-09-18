import { describe, expect, it } from 'vitest';
import { MIN_TRACKED_SECRET_LENGTH, REDACTED, SecretRedactor } from '../src/index.js';

const TOKEN = 'ghp_example0123456789abcdefghijklmnop';

describe('SecretRedactor', () => {
  it('removes a resolved value from a raw string', () => {
    const redactor = new SecretRedactor();
    redactor.remember(TOKEN);
    expect(redactor.scrub(`token=${TOKEN}`)).toBe(`token=${REDACTED}`);
  });

  it('removes it from nested structures without disturbing their shape', () => {
    const redactor = new SecretRedactor();
    redactor.remember(TOKEN);
    const scrubbed = redactor.scrubDeep({
      stdout: `export TOKEN=${TOKEN}\n`,
      nested: [{ header: `Authorization: Bearer ${TOKEN}` }],
      count: 3,
      flag: true,
      nothing: null,
    }) as Record<string, unknown>;
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(scrubbed['count']).toBe(3);
    expect(scrubbed['flag']).toBe(true);
    expect(scrubbed['nothing']).toBeNull();
  });

  it('still catches credentials it was never told about', () => {
    const redactor = new SecretRedactor();
    expect(redactor.scrub(`key=${TOKEN}`)).toBe(`key=${REDACTED}`);
    expect(redactor.scrub('nothing to see')).toBe('nothing to see');
  });

  it('ignores values too short to redact safely', () => {
    const redactor = new SecretRedactor();
    redactor.remember('abc');
    expect(redactor.trackedCount).toBe(0);
    expect(redactor.scrub('abc def abc')).toBe('abc def abc');
    redactor.remember('abcd'.repeat(MIN_TRACKED_SECRET_LENGTH / 4 + 1));
    expect(redactor.trackedCount).toBe(1);
  });

  it('counts distinct values once and never exposes them', () => {
    const redactor = new SecretRedactor();
    redactor.remember(TOKEN);
    redactor.remember(TOKEN);
    redactor.remember('another-secret-value');
    expect(redactor.trackedCount).toBe(2);
    expect(JSON.stringify(redactor)).not.toContain(TOKEN);
  });

  it('survives a cyclic payload', () => {
    const redactor = new SecretRedactor();
    redactor.remember(TOKEN);
    const payload: Record<string, unknown> = { token: TOKEN };
    payload['self'] = payload;
    expect(() => redactor.scrubDeep(payload)).not.toThrow();
  });
});
