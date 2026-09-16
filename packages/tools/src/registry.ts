import { ToolNotFoundError, type AgentTool, type JsonObject, type ToolDefinition } from '@kazi-ai/agentos-core';
import { schemaToJsonSchema } from './define-tool.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = AgentTool<any, any>;

/** Registry contract from the runtime specification. */
export interface ToolRegistry {
  register(tool: AnyTool): void;
  unregister(toolId: string): void;
  get(toolId: string): AnyTool | undefined;
  list(): AnyTool[];
  resolve(ids: string[]): AnyTool[];
}

const TOOL_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(tools: AnyTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyTool): void {
    if (!TOOL_ID_PATTERN.test(tool.id)) {
      throw new Error(
        `Invalid tool id "${tool.id}": use lowercase namespaced ids such as filesystem.read or mcp.github.create_issue`,
      );
    }
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }
    this.tools.set(tool.id, tool);
  }

  /** Replace an existing tool regardless of current registration state. */
  override(tool: AnyTool): void {
    this.tools.set(tool.id, tool);
  }

  unregister(toolId: string): void {
    this.tools.delete(toolId);
  }

  get(toolId: string): AnyTool | undefined {
    return this.tools.get(toolId);
  }

  require(toolId: string): AnyTool {
    const tool = this.tools.get(toolId);
    if (!tool) throw new ToolNotFoundError(toolId);
    return tool;
  }

  list(): AnyTool[] {
    return [...this.tools.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  ids(): string[] {
    return this.list().map((tool) => tool.id);
  }

  /**
   * Resolve a set of ids, supporting namespace wildcards such as
   * `filesystem.*` or an explicit `*` for every registered tool.
   */
  resolve(ids: string[]): AnyTool[] {
    const resolved = new Map<string, AnyTool>();
    for (const id of ids) {
      if (id === '*') {
        for (const tool of this.list()) resolved.set(tool.id, tool);
        continue;
      }
      if (id.endsWith('.*')) {
        const prefix = id.slice(0, -2);
        const matches = this.list().filter(
          (tool) => tool.id === prefix || tool.id.startsWith(`${prefix}.`) || tool.id.startsWith(`${prefix}_`),
        );
        for (const tool of matches) resolved.set(tool.id, tool);
        continue;
      }
      const tool = this.tools.get(id);
      if (tool) resolved.set(tool.id, tool);
    }
    return [...resolved.values()];
  }

  /** Tool definitions in provider wire format. */
  toDefinitions(ids?: string[]): ToolDefinition[] {
    const tools = ids === undefined ? this.list() : this.resolve(ids);
    return tools.map((tool) => ({
      name: tool.id,
      description: tool.description,
      parameters: schemaToJsonSchema(tool.inputSchema),
    }));
  }

  describe(): Array<{ id: string; description: string; kind: string; risk: string; timeoutMs?: number }> {
    return this.list().map((tool) => ({
      id: tool.id,
      description: tool.description,
      kind: tool.kind ?? 'builtin',
      risk: tool.risk ?? 'MEDIUM',
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
    }));
  }

  permissionsOf(toolId: string): JsonObject {
    const tool = this.tools.get(toolId);
    if (!tool) return {};
    return JSON.parse(JSON.stringify(tool.permissions ?? {})) as JsonObject;
  }
}
