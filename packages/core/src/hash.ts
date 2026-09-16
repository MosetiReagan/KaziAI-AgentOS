import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { stableStringify } from './json.js';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

export function shortHash(value: unknown, length = 12): string {
  return hashObject(value).slice(0, length);
}

export function uuid(): string {
  return randomUUID();
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Idempotency key for an action: same run + step + tool + normalized arguments
 * means the same action, and must never be executed twice.
 */
export function idempotencyKey(parts: {
  runId: string;
  step?: number | string;
  toolId: string;
  arguments?: unknown;
  attempt?: number;
}): string {
  const basis = {
    runId: parts.runId,
    step: parts.step ?? null,
    toolId: parts.toolId,
    arguments: parts.arguments ?? null,
    attempt: parts.attempt ?? 0,
  };
  return `idem_${hashObject(basis).slice(0, 32)}`;
}

