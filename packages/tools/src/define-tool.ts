import type { JsonObject, JsonValue } from '@kazi-ai/agentos-core';
import { z } from 'zod';

export interface ZodSchemaLike {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { message: string; issues?: unknown } };
  toJsonSchema?(): JsonObject;
}

/**
 * Convert a Zod schema into JSON Schema for provider tool definitions.
 * Zod v4 exposes this natively; the fallback keeps third-party validators working.
 */
export function schemaToJsonSchema(schema: ZodSchemaLike): JsonObject {
  if (typeof schema.toJsonSchema === 'function') {
    return schema.toJsonSchema();
  }
  const zodSchema = schema as unknown as z.ZodType;
  if (typeof (zodSchema as unknown as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    return (zodSchema as unknown as { toJSONSchema: () => JsonObject }).toJSONSchema();
  }
  return { type: 'object', additionalProperties: true };
}

export function jsonValueOf(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

