import type { Logger } from '@kazi-ai/agentos-core';
import { NullLogger } from '@kazi-ai/agentos-core';
import type { SpanFactory } from '@kazi-ai/agentos-tracing';
import { McpAuthError, McpProtocolError } from './errors.js';
import { JsonRpcClient, type JsonRpcNotification } from './jsonrpc.js';
import {
  DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type InitializeResult,
  type McpCallToolResult,
  type McpGetPromptResult,
  type McpPromptDefinition,
  type McpResourceContents,
  type McpResourceDefinition,
  type McpResourceTemplate,
  type McpToolDefinition,
  type ServerCapabilities,
} from './protocol.js';
import type { McpTransport } from './transports/types.js';

export interface McpClientOptions {
  serverId: string;
  transport: McpTransport;
  clientInfo?: { name: string; version: string };
  requestTimeoutMs?: number;
  logger?: Logger;
  /** Optional span sink so MCP traffic shows up in the run trace. */
  tracing?: { factory: SpanFactory; traceId: string; runId: string; parentSpanId?: string; attributes?: Record<string, unknown> };
  onNotification?(notification: JsonRpcNotification): void;
  /** Answer server-initiated requests. Returning undefined declines politely. */
  onServerRequest?(request: { method: string; params?: unknown }): Promise<unknown> | unknown;
}

export interface DiscoveredServer {
  protocolVersion: string;
  serverInfo: InitializeResult['serverInfo'];
  capabilities: ServerCapabilities;
  instructions?: string;
}

/**
 * A live connection to one MCP server: handshake, capability negotiation, tool
 * and resource discovery, invocation, and prompt retrieval.
 */
export class McpClient {
  private readonly rpc: JsonRpcClient;
  private readonly logger: Logger;
  private initialized?: InitializeResult;

  constructor(private readonly options: McpClientOptions) {
    this.logger = options.logger ?? new NullLogger();
    this.rpc = new JsonRpcClient({
      serverId: options.serverId,
      transport: options.transport,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      onNotification: (notification) => {
        this.logger.debug('mcp notification', { server: options.serverId, method: notification.method });
        options.onNotification?.(notification);
      },
      onServerRequest: (request) => {
        void this.answer(request);
      },
    });
  }

  get serverId(): string {
    return this.options.serverId;
  }

  get server(): DiscoveredServer | undefined {
    if (!this.initialized) return undefined;
    return {
      protocolVersion: this.initialized.protocolVersion,
      serverInfo: this.initialized.serverInfo,
      capabilities: this.initialized.capabilities,
      ...(this.initialized.instructions === undefined ? {} : { instructions: this.initialized.instructions }),
    };
  }

  get capabilities(): ServerCapabilities {
    return this.initialized?.capabilities ?? {};
  }

  async connect(): Promise<DiscoveredServer> {
    if (this.initialized) return this.server as DiscoveredServer;
    await this.trace('mcp.connect', async () => {
      await this.options.transport.start();
      const result = await this.rpc.request<InitializeResult>(
        'initialize',
        {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          capabilities: { roots: { listChanged: true } },
          clientInfo: this.options.clientInfo ?? { name: 'kazi-ai-agentos', version: '0.1.0' },
        },
        { timeoutMs: this.options.requestTimeoutMs ?? 30_000 },
      );
      if (typeof result !== 'object' || result === null || typeof result.protocolVersion !== 'string') {
        throw new McpProtocolError(this.serverId, 'initialize returned an unexpected payload');
      }
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number])) {
        this.logger.warn('mcp server negotiated an unknown protocol version', {
          server: this.serverId,
          protocolVersion: result.protocolVersion,
        });
      }
      this.initialized = result;
      await this.rpc.notify('notifications/initialized');
      this.logger.info('mcp server ready', {
        server: this.serverId,
        protocolVersion: result.protocolVersion,
        serverName: result.serverInfo?.name,
      });
    });
    return this.server as DiscoveredServer;
  }

  async ping(): Promise<boolean> {
    await this.rpc.request('ping');
    return true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.initialized?.capabilities.tools) return [];
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc.request<{ tools?: McpToolDefinition[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : undefined);
      for (const tool of page.tools ?? []) {
        if (typeof tool?.name !== 'string') continue;
        tools.push({
          ...tool,
          inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as McpToolDefinition['inputSchema'],
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, options: { timeoutMs?: number } = {}): Promise<McpCallToolResult> {
    const result = await this.rpc.request<McpCallToolResult>('tools/call', { name, arguments: args }, options);
    if (typeof result !== 'object' || result === null) {
      throw new McpProtocolError(this.serverId, `tools/call ${name} returned a non-object result`);
    }
    return result;
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    if (!this.initialized?.capabilities.resources) return [];
    const page = await this.rpc.request<{ resources?: McpResourceDefinition[] }>('resources/list');
    return page.resources ?? [];
  }

  async listResourceTemplates(): Promise<McpResourceTemplate[]> {
    if (!this.initialized?.capabilities.resources) return [];
    const page = await this.rpc.request<{ resourceTemplates?: McpResourceTemplate[] }>('resources/templates/list');
    return page.resourceTemplates ?? [];
  }

  async readResource(uri: string): Promise<McpResourceContents[]> {
    const page = await this.rpc.request<{ contents?: McpResourceContents[] }>('resources/read', { uri });
    return page.contents ?? [];
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    if (!this.initialized?.capabilities.prompts) return [];
    const page = await this.rpc.request<{ prompts?: McpPromptDefinition[] }>('prompts/list');
    return page.prompts ?? [];
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpGetPromptResult> {
    const result = await this.rpc.request<McpGetPromptResult>('prompts/get', { name, arguments: args });
    if (typeof result !== 'object' || result === null || !Array.isArray(result.messages)) {
      throw new McpProtocolError(this.serverId, `prompts/get ${name} returned an unexpected payload`);
    }
    return result;
  }

  /** Announce a workspace root so path-scoped servers know where the run lives. */
  async notifyRootsChanged(roots: Array<{ uri: string; name: string }>): Promise<void> {
    await this.rpc.notify('notifications/roots/list_changed', { roots });
  }

  /** Record a log line emitted by the server. */
  async setLogLevel(level: 'debug' | 'info' | 'warning' | 'error'): Promise<void> {
    await this.rpc.request('logging/setLevel', { level });
  }

  async close(): Promise<void> {
    await this.rpc.close();
  }

  private async answer(request: { id: string | number; method: string; params?: unknown }): Promise<void> {
    try {
      const result = (await this.options.onServerRequest?.({ method: request.method, params: request.params })) ?? {};
      await this.rpc.respond(request.id, result);
    } catch (error) {
      this.logger.warn('declined mcp server request', { server: this.serverId, method: request.method });
      await this.rpc.respondError(request.id, -32601, `unsupported request: ${request.method}`).catch(() => undefined);
      void error;
    }
  }

  private async trace<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const tracing = this.options.tracing;
    if (!tracing) return await fn();
    const span = tracing.factory.start(name, {
      traceId: tracing.traceId,
      runId: tracing.runId,
      ...(tracing.parentSpanId === undefined ? {} : { parentSpanId: tracing.parentSpanId }),
      attributes: { 'mcp.server': this.serverId, ...(tracing.attributes ?? {}) },
    });
    try {
      const value = await fn();
      span.setStatus('ok');
      return value;
    } catch (error) {
      span.setStatus('error', {
        code: error instanceof Error ? error.name : 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  }
}

/** Raised when a caller asks for a capability the server did not advertise. */
export function assertCapability(client: McpClient, capability: keyof ServerCapabilities): void {
  const capabilities = client.capabilities;
  if (!capabilities[capability]) {
    throw new McpAuthError(client.serverId, `server does not advertise the "${capability}" capability`);
  }
}
