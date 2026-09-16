import { NullLogger, type AgentTool, type JsonValue, type Logger, type SecretResolver } from '@kazi-ai/agentos-core';
import type { SpanFactory } from '@kazi-ai/agentos-tracing';
import { McpClient, type DiscoveredServer } from './client.js';
import { parseServerConfig, type McpServerConfig, type McpServerConfigInput } from './config.js';
import { McpError, McpTransportError } from './errors.js';
import { mcpToolId } from './normalize.js';
import type { McpPromptDefinition, McpResourceContents, McpResourceDefinition, McpResourceTemplate, McpToolDefinition } from './protocol.js';
import { createMcpTool } from './tool.js';
import { HttpTransport } from './transports/http.js';
import { StdioTransport } from './transports/stdio.js';
import type { McpTransport } from './transports/types.js';

export interface McpManagerOptions {
  resolveSecret?(reference: string): Promise<string>;
  logger?: Logger;
  tracing?: { factory: SpanFactory; traceId: string; runId: string; parentSpanId?: string };
  /** Override transport creation (used by tests and embedded servers). */
  createTransport?(server: McpServerConfig): McpTransport | Promise<McpTransport>;
  /** Fail the whole discovery instead of isolating a broken server. */
  strict?: boolean;
}

export interface McpServerStatus {
  id: string;
  enabled: boolean;
  connected: boolean;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  failures: number;
  error?: { code: string; message: string };
}

interface ServerState {
  config: McpServerConfig;
  client?: McpClient;
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  resourceTemplates: McpResourceTemplate[];
  prompts: McpPromptDefinition[];
  error?: McpError;
  failures: number;
  discovered: boolean;
}

/**
 * Owns every configured MCP server: connection lifecycle, discovery, tool
 * normalization and lookup. One broken server never takes down the others
 * unless `strict` is set; its tools simply never appear.
 */
export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly logger: Logger;
  private closed = false;

  constructor(private readonly options: McpManagerOptions = {}) {
    this.logger = options.logger ?? new NullLogger();
  }

  addServer(input: McpServerConfigInput | McpServerConfig): McpServerStatus {
    const config = parseServerConfig(input);
    if (this.servers.has(config.id)) throw new McpTransportError(config.id, `server "${config.id}" is already configured`, { retryable: false });
    this.servers.set(config.id, { config, tools: [], resources: [], resourceTemplates: [], prompts: [], failures: 0, discovered: false });
    return this.statusOf(config.id) as McpServerStatus;
  }

  removeServer(id: string): boolean {
    const state = this.servers.get(id);
    if (!state) return false;
    void state.client?.close();
    this.servers.delete(id);
    return true;
  }

  serverIds(): string[] {
    return [...this.servers.keys()];
  }

  /** Connect to every enabled server and discover what it exposes. */
  async start(): Promise<McpServerStatus[]> {
    if (this.closed) throw new McpError('manager', 'MCP manager is closed', { retryable: false });
    const ids = this.serverIds();
    await Promise.all(
      ids.map(async (id) => {
        try {
          await this.connect(id);
        } catch (error) {
          if (this.options.strict === true) throw error;
        }
      }),
    );
    return this.status();
  }

  async connect(id: string): Promise<McpServerStatus> {
    const state = this.require(id);
    if (!state.config.enabled) return this.statusOf(id) as McpServerStatus;
    try {
      // Transport construction, authentication and the handshake all count as
      // "connecting": any of them failing must be classified and reported
      // instead of escaping as an unhandled error.
      const transport = await this.transportFor(state.config);
      const client = new McpClient({
        serverId: state.config.id,
        transport,
        requestTimeoutMs: state.config.requestTimeoutMs,
        logger: this.logger,
        ...(this.options.tracing === undefined
          ? {}
          : {
              tracing: {
                factory: this.options.tracing.factory,
                traceId: this.options.tracing.traceId,
                runId: this.options.tracing.runId,
                ...(this.options.tracing.parentSpanId === undefined ? {} : { parentSpanId: this.options.tracing.parentSpanId }),
              },
            }),
      });
      state.client = client;
      await client.connect();
      await this.discover(id);
      state.error = undefined;
      return this.statusOf(id) as McpServerStatus;
    } catch (error) {
      state.failures += 1;
      state.error = classifyConnectionError(id, error);
      state.discovered = false;
      state.tools = [];
      this.logger.warn('mcp server unavailable', { server: id, error: state.error.message });
      if (this.options.strict === true) throw state.error;
      return this.statusOf(id) as McpServerStatus;
    }
  }

  async discover(id: string): Promise<{ tools: McpToolDefinition[]; resources: McpResourceDefinition[]; prompts: McpPromptDefinition[] }> {
    const state = this.require(id);
    const client = state.client;
    if (!client) throw new McpError(id, 'server is not connected', { retryable: true });
    state.tools = await client.listTools();
    state.resources = await client.listResources();
    state.resourceTemplates = await client.listResourceTemplates();
    state.prompts = await client.listPrompts();
    state.discovered = true;
    this.logger.info('mcp server discovered', {
      server: id,
      tools: state.tools.length,
      resources: state.resources.length,
      prompts: state.prompts.length,
    });
    return { tools: state.tools, resources: state.resources, prompts: state.prompts };
  }

  /** Normalize every discovered tool into AgentOS tools. */
  tools(): AgentTool[] {
    const tools: AgentTool[] = [];
    for (const state of this.servers.values()) {
      if (!state.client || !state.discovered) continue;
      for (const definition of state.tools) {
        if (state.config.blockedTools.includes(definition.name)) continue;
        if (state.config.allowedTools.length > 0 && !state.config.allowedTools.includes(definition.name)) continue;
        tools.push(createMcpTool({ server: state.config, definition, client: state.client }));
      }
    }
    return tools.sort((left, right) => left.id.localeCompare(right.id));
  }

  toolIds(): string[] {
    return this.tools().map((tool) => tool.id);
  }

  /** Register every discovered tool into a registry, replacing stale entries. */
  registerInto(registry: { register(tool: AgentTool): void; unregister(toolId: string): void }): string[] {
    const registered: string[] = [];
    for (const tool of this.tools()) {
      registry.unregister(tool.id);
      registry.register(tool);
      registered.push(tool.id);
    }
    return registered;
  }

  async refresh(id?: string): Promise<McpServerStatus[]> {
    const ids = id === undefined ? this.serverIds() : [id];
    for (const serverId of ids) {
      const state = this.require(serverId);
      if (state.client) await this.discover(serverId);
    }
    return this.status();
  }

  /** Reconnect a server whose connection died, keeping the run alive. */
  async reconnect(id: string): Promise<McpServerStatus> {
    const state = this.require(id);
    await state.client?.close().catch(() => undefined);
    state.client = undefined;
    return await this.connect(id);
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<JsonValue> {
    const state = this.require(serverId);
    const client = state.client;
    if (!client) throw new McpError(serverId, 'server is not connected', { retryable: true });
    const result = await client.callTool(toolName, args);
    return (result.structuredContent ?? { content: result.content ?? [], isError: result.isError === true }) as JsonValue;
  }

  async listResources(serverId: string): Promise<McpResourceDefinition[]> {
    return this.require(serverId).resources;
  }

  async listResourceTemplates(serverId: string): Promise<McpResourceTemplate[]> {
    return this.require(serverId).resourceTemplates;
  }

  async readResource(serverId: string, uri: string): Promise<McpResourceContents[]> {
    const client = this.require(serverId).client;
    if (!client) throw new McpError(serverId, 'server is not connected', { retryable: true });
    return await client.readResource(uri);
  }

  async listPrompts(serverId: string): Promise<McpPromptDefinition[]> {
    return this.require(serverId).prompts;
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string> = {}): Promise<{ description?: string; messages: Array<{ role: string; content: unknown }> }> {
    const client = this.require(serverId).client;
    if (!client) throw new McpError(serverId, 'server is not connected', { retryable: true });
    const result = await client.getPrompt(name, args);
    return {
      ...(result.description === undefined ? {} : { description: result.description }),
      messages: result.messages.map((message) => ({ role: message.role, content: message.content })),
    };
  }

  status(): McpServerStatus[] {
    return this.serverIds().map((id) => this.statusOf(id) as McpServerStatus);
  }

  /** Health snapshot for `kazi-agent doctor`. */
  health(): { servers: number; connected: number; tools: number; failures: McpServerStatus[] } {
    const all = this.status();
    return {
      servers: all.length,
      connected: all.filter((server) => server.connected).length,
      tools: this.tools().length,
      failures: all.filter((server) => server.error !== undefined),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const state of this.servers.values()) {
      await state.client?.close().catch(() => undefined);
      state.client = undefined;
      state.discovered = false;
      state.tools = [];
    }
  }

  private statusOf(id: string): McpServerStatus | undefined {
    const state = this.servers.get(id);
    if (!state) return undefined;
    const server: DiscoveredServer | undefined = state.client?.server;
    return {
      id,
      enabled: state.config.enabled,
      connected: server !== undefined,
      toolCount: state.discovered ? this.toolsOf(state).length : 0,
      resourceCount: state.resources.length,
      promptCount: state.prompts.length,
      failures: state.failures,
      ...(server === undefined
        ? {}
        : {
            protocolVersion: server.protocolVersion,
            serverName: server.serverInfo?.name ?? state.config.id,
            serverVersion: server.serverInfo?.version ?? 'unknown',
          }),
      ...(state.error === undefined ? {} : { error: { code: state.error.code, message: state.error.message } }),
    };
  }

  private toolsOf(state: ServerState): McpToolDefinition[] {
    return state.tools.filter((definition) => {
      if (state.config.blockedTools.includes(definition.name)) return false;
      if (state.config.allowedTools.length > 0 && !state.config.allowedTools.includes(definition.name)) return false;
      return true;
    });
  }

  private require(id: string): ServerState {
    const state = this.servers.get(id);
    if (!state) throw new McpError(id, 'server is not configured', { retryable: false, code: 'mcp.unknown_server' });
    return state;
  }

  private async transportFor(config: McpServerConfig): Promise<McpTransport> {
    if (this.options.createTransport) return await this.options.createTransport(config);
    if (config.transport.type === 'stdio') {
      return new StdioTransport({
        id: config.id,
        command: config.transport.command,
        args: config.transport.args,
        env: config.transport.env,
        ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }),
        onStderr: (line) => this.logger.debug('mcp server stderr', { server: config.id, line }),
      });
    }
    const resolver: SecretResolver | undefined = this.secretResolver();
    return new HttpTransport({
      id: config.id,
      url: config.transport.url,
      headers: config.transport.headers,
      requestTimeoutMs: config.requestTimeoutMs,
      ...(config.transport.auth === undefined
        ? {}
        : {
            auth: {
              header: config.transport.auth.header,
              secretRef: config.transport.auth.secretRef,
              ...(config.transport.auth.scheme === undefined ? {} : { scheme: config.transport.auth.scheme }),
            },
          }),
      ...(resolver === undefined ? {} : { resolveSecret: (reference: string) => resolver.resolve(reference) }),
    });
  }

  private secretResolver(): SecretResolver | undefined {
    const resolve = this.options.resolveSecret;
    if (!resolve) return undefined;
    return { resolve, has: async (reference: string) => (await resolve(reference)) !== undefined };
  }
}

function classifyConnectionError(serverId: string, error: unknown): McpError {
  if (error instanceof McpError) return error;
  return new McpError(serverId, error instanceof Error ? error.message : 'connection failed', { retryable: true, cause: error });
}

/** Tool id an MCP server exposes for one of its tools. */
export function toolIdFor(serverId: string, toolName: string): string {
  return mcpToolId(serverId, toolName);
}
