const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bbearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

const SENSITIVE_KEY = /(authorization|api[-_]?key|apikey|password|passwd|secret|token|cookie|session|credential|private[-_]?key)/i;

export const REDACTED = '[redacted]';

/** Remove values that look like credentials from an arbitrary string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Deep redaction for structured payloads. Keys that look sensitive are replaced
 * wholesale; string values are pattern-scrubbed.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 10) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

export function containsSecretLike(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

