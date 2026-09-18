import { redactString, REDACTED } from './redact.js';

/**
 * The shortest value worth tracking. Redacting a very short string would
 * replace unrelated content everywhere, so a secret below this length is not
 * registered — and `SecretRedactor.remember` says so rather than pretending.
 */
export const MIN_TRACKED_SECRET_LENGTH = 8;

/**
 * Knows the secret *values* this process has resolved, so that anything it
 * writes down can have them removed first (spec §66).
 *
 * Pattern matching catches credentials that look like credentials; this catches
 * the credentials the runtime was actually handed, whatever they look like. Both
 * are needed: a webhook signing secret or a database password is not shaped like
 * an API key and only the second kind of check finds it.
 */
export interface Redactor {
  /** Register a value that must never be persisted. Short values are ignored. */
  remember(value: string): void;
  /** Remove every known secret value, and anything secret-shaped, from a string. */
  scrub(input: string): string;
  /** The same, structurally. Unknown shapes are returned unchanged. */
  scrubDeep<T>(value: T): T;
  /** How many distinct values are tracked. Never the values themselves. */
  readonly trackedCount: number;
}

export class SecretRedactor implements Redactor {
  /**
   * A true private field, not a TypeScript `private`: the values must not
   * appear if the redactor itself is ever serialised into a log line.
   */
  #values: string[] = [];

  remember(value: string): void {
    if (typeof value !== 'string') return;
    if (value.length < MIN_TRACKED_SECRET_LENGTH) return;
    if (!this.#values.includes(value)) this.#values.push(value);
  }

  get trackedCount(): number {
    return this.#values.length;
  }

  scrub(input: string): string {
    if (typeof input !== 'string' || input.length === 0) return input;
    let out = input;
    for (const value of this.#values) out = out.split(value).join(REDACTED);
    return redactString(out);
  }

  scrubDeep<T>(value: T): T {
    return scrubDeepWith(value, this) as T;
  }
}

/** A redactor that knows nothing: the behaviour of a runtime with no secrets. */
export const NOOP_REDACTOR: Redactor = {
  remember(): void {},
  scrub: (input: string) => input,
  scrubDeep: <T>(value: T) => value,
  trackedCount: 0,
};

function scrubDeepWith(value: unknown, redactor: Redactor, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === 'string') return redactor.scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubDeepWith(item, redactor, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redactor.scrub(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubDeepWith(item, redactor, depth + 1);
  }
  return out;
}
