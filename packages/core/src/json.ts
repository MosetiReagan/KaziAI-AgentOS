export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Deterministic serialization: object keys are sorted so structurally equal
 * payloads always hash identically. This is what makes idempotency keys trustworthy.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return canonicalize(Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), v])));
  }
  if (value instanceof Set) return canonicalize([...value.values()]);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = canonicalize(record[key]);
  }
  return out;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return '[max-depth]';
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value as JsonValue;
  if (type === 'number') return Number.isFinite(value as number) ? (value as number) : null;
  if (type === 'bigint') return String(value);
  if (type === 'function' || type === 'symbol') return null;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (type === 'object') {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** Truncate any JSON-serializable value to a bounded serialized size. */
export function truncateJson(value: unknown, maxBytes: number): { value: JsonValue; truncated: boolean } {
  const json = toJsonValue(value);
  const serialized = JSON.stringify(json);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return { value: json, truncated: false };

  if (typeof json === 'string') {
    const sliced = Buffer.from(json, 'utf8').subarray(0, Math.max(0, maxBytes - 64)).toString('utf8');
    return { value: `${sliced}… [truncated, ${Buffer.byteLength(serialized, 'utf8')} bytes total]`, truncated: true };
  }

  if (Array.isArray(json)) {
    const out: JsonValue[] = [];
    let size = 2;
    for (const item of json) {
      const itemSize = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (size + itemSize > maxBytes) break;
      out.push(item);
      size += itemSize;
    }
    out.push('[truncated]');
    return { value: out, truncated: true };
  }

  const placeholder = `[truncated payload, ${Buffer.byteLength(serialized, 'utf8')} bytes]`;
  return { value: placeholder.slice(0, Math.max(1, maxBytes)), truncated: true };
}

export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const existing = out[key];
    const bothObjects =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing);
    out[key] = bothObjects
      ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return out as T;
}

