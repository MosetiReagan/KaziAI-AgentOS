import type {
  AgentTool,
  IdempotencyClass,
  InputSchema,
  JsonObject,
  JsonValue,
  RiskLevel,
  ToolContext,
  ToolPermissions,
  ToolResult,
  ToolSandboxRequirements,
} from '@kazi-ai/agentos-core';
import { AgentError, ToolExecutionError, ToolInputError, toolResult } from '@kazi-ai/agentos-core';
import { z } from 'zod';

export interface ZodSchemaLike {
  parse(input: unknown): unknown;
  safeParse(
    input: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { message: string; issues?: unknown } };
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

const TOOL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface DefineToolOptions<Input> {
  /** Namespaced, lowercase id such as `weather.get` or `mcp.github.create_issue`. */
  id: string;
  description: string;
  input: ZodSchemaLike;
  kind?: AgentTool['kind'];
  risk?: RiskLevel;
  /** Capabilities this tool needs; the run's grant is still authoritative. */
  permissions?: ToolPermissions;
  timeoutMs?: number;
  sandbox?: ToolSandboxRequirements;
  /** How safe it is to repeat this tool's work after a crash. */
  idempotency?: IdempotencyClass;
  execute(
    input: Input,
    context: ToolContext,
  ): Promise<ToolResult | JsonValue> | ToolResult | JsonValue;
}

/**
 * Define a custom tool (spec §73).
 *
 * Authors return either a plain JSON value or a full `ToolResult`; errors are
 * classified instead of being swallowed, and the declared risk/idempotency flow
 * into the policy engine and the recovery engine.
 */
export function defineTool<Input>(options: DefineToolOptions<Input>): AgentTool<Input> {
  if (!TOOL_ID_PATTERN.test(options.id)) {
    throw new Error(
      `Invalid tool id "${options.id}": use lowercase namespaced ids such as weather.get or mcp.github.create_issue`,
    );
  }
  const idempotency = options.idempotency ?? 'unknown';
  const inputSchema: InputSchema = {
    parse: (input: unknown) => options.input.parse(input),
    safeParse: (input: unknown) => options.input.safeParse(input),
    toJsonSchema: () => schemaToJsonSchema(options.input),
  };

  return {
    id: options.id,
    description: options.description,
    kind: options.kind ?? 'custom',
    inputSchema,
    defaultIdempotency: idempotency,
    ...(options.risk === undefined ? {} : { risk: options.risk }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    async execute(input: Input, context: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ToolInputError(options.id, `Invalid arguments: ${parsed.error.message}`, {
          issues: parsed.error.issues as JsonValue,
        });
      }
      const started = Date.now();
      try {
        const value = await options.execute(parsed.data as Input, context);
        const result = isToolResult(value)
          ? { ...value, idempotency: value.idempotency ?? idempotency }
          : toolResult({ success: true, output: jsonValueOf(value), idempotency });
        return { durationMs: Date.now() - started, ...result };
      } catch (error) {
        if (error instanceof AgentError) throw error;
        throw new ToolExecutionError(
          options.id,
          error instanceof Error ? error.message : 'Custom tool failed',
          {
            code: 'tool.custom_failed',
            retryable: false,
            idempotency,
            cause: error,
          },
        );
      }
    },
  };
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { success?: unknown }).success === 'boolean' &&
    'output' in value
  );
}
