import { AgentError, type JsonObject } from '@kazi-ai/agentos-core';

/** Transport, handshake or protocol failure while talking to an MCP server. */
export class McpError extends AgentError {
  constructor(
    readonly serverId: string,
    message: string,
    options: { code?: string; retryable?: boolean; details?: JsonObject; cause?: unknown } = {},
  ) {
    super({
      code: options.code ?? 'mcp.error',
      message: `[mcp:${serverId}] ${message}`,
      category: 'tool',
      retryable: options.retryable ?? false,
      idempotency: 'idempotent',
      details: { serverId, ...(options.details ?? {}) },
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = 'McpError';
  }
}

export class McpTransportError extends McpError {
  constructor(serverId: string, message: string, options: { retryable?: boolean; details?: JsonObject; cause?: unknown } = {}) {
    super(serverId, message, { code: 'mcp.transport_error', retryable: options.retryable ?? true, ...options });
    this.name = 'McpTransportError';
  }
}

export class McpTimeoutError extends McpError {
  constructor(serverId: string, method: string, timeoutMs: number) {
    super(serverId, `${method} timed out after ${timeoutMs}ms`, {
      code: 'mcp.timeout',
      retryable: true,
      details: { method, timeoutMs },
    });
    this.name = 'McpTimeoutError';
  }
}

export class McpProtocolError extends McpError {
  constructor(serverId: string, message: string, details: JsonObject = {}) {
    super(serverId, message, { code: 'mcp.protocol_error', retryable: false, details });
    this.name = 'McpProtocolError';
  }
}

export class McpToolError extends McpError {
  constructor(serverId: string, toolName: string, message: string, details: JsonObject = {}) {
    super(serverId, `tool ${toolName} failed: ${message}`, {
      code: 'mcp.tool_error',
      retryable: false,
      details: { tool: toolName, ...details },
    });
    this.name = 'McpToolError';
  }
}

export class McpAuthError extends McpError {
  constructor(serverId: string, message: string) {
    super(serverId, message, { code: 'mcp.auth_error', retryable: false });
    this.name = 'McpAuthError';
  }
}

/** Raised when a server exposes a tool the run is not allowed to use. */
export class McpToolNotAllowedError extends McpError {
  constructor(serverId: string, toolName: string, reason: string) {
    super(serverId, `tool ${toolName} is not allowed: ${reason}`, {
      code: 'mcp.tool_not_allowed',
      retryable: false,
      details: { tool: toolName },
    });
    this.name = 'McpToolNotAllowedError';
  }
}
