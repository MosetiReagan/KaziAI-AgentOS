import { type AgentError, toAgentError } from './errors.js';

export type Result<T, E = AgentError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}

/** Convert a possibly-rejecting call into a Result, preserving AgentError classification. */
export async function attempt<T>(fn: () => Promise<T> | T): Promise<Result<T, AgentError>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(toAgentError(error));
  }
}

export async function collect<T>(items: Iterable<T>, fn: (item: T) => Promise<void>): Promise<void> {
  for (const item of items) await fn(item);
}

