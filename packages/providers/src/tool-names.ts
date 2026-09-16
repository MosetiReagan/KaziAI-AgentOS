/**
 * Provider wire formats restrict tool names (OpenAI: `^[a-zA-Z0-9_-]{1,64}$`),
 * but AgentOS uses dotted namespaces such as `filesystem.read` and
 * `mcp.github.create_issue`. Names are encoded on the way out and decoded on
 * the way in so the agent always speaks AgentOS tool ids.
 */
const DOT = '.';
const SEPARATOR = '__';

export function encodeToolName(toolId: string): string {
  return toolId.split(DOT).join(SEPARATOR);
}

export function decodeToolName(wireName: string): string {
  return wireName.split(SEPARATOR).join(DOT);
}

export function encodeToolNames<T extends { name: string }>(tools: T[]): T[] {
  return tools.map((tool) => ({ ...tool, name: encodeToolName(tool.name) }));
}

