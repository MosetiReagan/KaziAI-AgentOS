import {
  AgentError,
  ToolExecutionError,
  ToolInputError,
  toolResult,
  type AgentTool,
  type ToolContext,
  type ToolResult,
} from '@kazi-ai/agentos-core';
import type { McpClient } from './client.js';
import type { McpServerConfig } from './config.js';
import { McpError, McpToolNotAllowedError } from './errors.js';
import { validateAgainstSchema, type ValidationIssue } from './json-schema.js';
import { idempotencyFor, mcpToolId, normalizeToolResult, riskFor, toolDescription, unmetPermissions } from './normalize.js';
import type { McpCallToolResult, McpToolDefinition } from './protocol.js';

/** Extra wall-clock the tool allows itself on top of the server's own ceiling. */
const TIMEOUT_SLACK_MS = 5_000;

export interface McpToolOptions {
  server: McpServerConfig;
  definition: McpToolDefinition;
  client: McpClient;
  /** Called for every invocation, so the manager can account for MCP usage. */
  onInvocation?(event: { toolId: string; toolName: string; durationMs: number; ok: boolean }): void;
}

/**
 * Adapts one MCP tool into the AgentOS tool model. Agents never see the MCP
 * wire protocol: an MCP tool behaves exactly like a builtin, except that policy
 * sees `mcp.<server>.<tool>` and the server's declared permissions apply.
 */
export function createMcpTool(options: McpToolOptions): AgentTool {
  const { server, definition, client } = options;
  const id = mcpToolId(server.id, definition.name);
  const idempotency = idempotencyFor(definition, server.idempotentTools);
  const timeoutMs = server.requestTimeoutMs + TIMEOUT_SLACK_MS;

  return {
    id,
    description: toolDescription(definition, server.id),
    kind: 'mcp',
    risk: riskFor(definition, server.risk),
    timeoutMs,
    permissions: server.permissions,
    defaultIdempotency: idempotency,
    inputSchema: {
      parse(input: unknown): unknown {
        const result = validateAgainstSchema(definition.inputSchema, input);
        if (!result.valid) throw new ToolInputError(id, describeIssues(result.issues));
        return result.value;
      },
      safeParse(input: unknown) {
        const result = validateAgainstSchema(definition.inputSchema, input);
        if (result.valid) return { success: true, data: result.value };
        return { success: false, error: { message: describeIssues(result.issues), issues: result.issues } };
      },
      toJsonSchema() {
        return definition.inputSchema;
      },
    },
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      assertAllowed(server, definition.name);
      const missing = unmetPermissions(server.permissions, context.permissions);
      if (missing.length > 0) {
        throw new ToolExecutionError(id, `This run does not grant ${missing.join(', ')}`, {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency,
          details: { tool: definition.name, missing },
        });
      }

      const validation = validateAgainstSchema(definition.inputSchema, input);
      if (!validation.valid) throw new ToolInputError(id, describeIssues(validation.issues));
      const args = (validation.value ?? {}) as Record<string, unknown>;
      const started = Date.now();

      try {
        const raw = await callWithAbort(client, definition.name, args, context, server.requestTimeoutMs);
        const normalized = normalizeToolResult(raw);
        const ok = raw.isError !== true;
        options.onInvocation?.({ toolId: id, toolName: definition.name, durationMs: Date.now() - started, ok });
        if (!ok) {
          return toolResult({
            success: false,
            output: normalized.output,
            metadata: { ...normalized.metadata, text: normalized.text },
            idempotency,
            durationMs: Date.now() - started,
            error: {
              code: 'mcp.tool_reported_error',
              // The server's message is untrusted content: it is carried as
              // data for the model to read, never as instructions we follow.
              message: normalized.text.length > 0 ? normalized.text : `${definition.name} reported an error`,
              category: 'tool',
              retryable: false,
              idempotency,
              details: { server: server.id, tool: definition.name },
            },
          });
        }
        return toolResult({
          success: true,
          output: normalized.output,
          metadata: {
            ...normalized.metadata,
            text: normalized.text,
            server: server.id,
            tool: definition.name,
            ...(normalized.truncated ? { truncated: true } : {}),
          },
          idempotency,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        options.onInvocation?.({ toolId: id, toolName: definition.name, durationMs: Date.now() - started, ok: false });
        throw toToolError(error, id, idempotency);
      }
    },
  };
}

function assertAllowed(server: McpServerConfig, toolName: string): void {
  if (server.blockedTools.includes(toolName)) {
    throw new McpToolNotAllowedError(server.id, toolName, 'the server config blocks it');
  }
  if (server.allowedTools.length > 0 && !server.allowedTools.includes(toolName)) {
    throw new McpToolNotAllowedError(server.id, toolName, 'it is not in the server allow list');
  }
}

/**
 * MCP calls cannot be cancelled on the wire, so the tool races the response
 * against the run's abort signal: a cancelled run must not hang on a server
 * that keeps working in the background.
 */
async function callWithAbort(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
  requestTimeoutMs: number,
): Promise<McpCallToolResult> {
  const call = client.callTool(name, args, { timeoutMs: requestTimeoutMs });
  if (context.signal.aborted) {
    void call.catch(() => undefined);
    throw new AgentError({
      code: 'tool.aborted',
      message: 'The run was cancelled before the MCP tool was invoked',
      category: 'tool',
      retryable: true,
      idempotency: 'unknown',
    });
  }
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(
        new AgentError({
          code: 'tool.aborted',
          message: 'The run was cancelled while the MCP tool was running',
          category: 'tool',
          retryable: true,
          idempotency: 'unknown',
        }),
      );
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    void call.finally(() => context.signal.removeEventListener('abort', onAbort)).catch(() => undefined);
  });
  return await Promise.race([call, aborted]);
}

function toToolError(error: unknown, toolId: string, idempotency: AgentTool['defaultIdempotency']): AgentError {
  if (error instanceof AgentError) {
    // Keep the classified MCP error (timeout, transport, protocol, auth).
    return new ToolExecutionError(toolId, error.message, {
      code: error.code,
      retryable: error.retryable,
      idempotency: idempotency ?? 'unknown',
      details: { ...error.details },
      cause: error,
    });
  }
  if (error instanceof McpError) {
    return new ToolExecutionError(toolId, error.message, {
      code: error.code,
      retryable: error.retryable,
      idempotency: idempotency ?? 'unknown',
    });
  }
  return new ToolExecutionError(toolId, error instanceof Error ? error.message : 'MCP tool call failed', {
    code: 'mcp.call_failed',
    retryable: true,
    idempotency: idempotency ?? 'unknown',
    cause: error,
  });
}

function describeIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path} ${issue.message}`).join('; ');
}
