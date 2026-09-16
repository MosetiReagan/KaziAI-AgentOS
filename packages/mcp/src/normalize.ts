import { truncateJson, type JsonObject, type JsonValue, type ToolPermissions } from '@kazi-ai/agentos-core';
import type { McpContentBlock, McpToolDefinition } from './protocol.js';

export const MCP_TOOL_PREFIX = 'mcp';

/** `github/create_issue` → `mcp.github.create_issue`, matching the tool-id grammar. */
export function mcpToolId(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}.${sanitizeSegment(serverId)}.${sanitizeSegment(toolName)}`;
}

export function sanitizeSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/[._-]{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return sanitized.length > 0 ? sanitized : 'unnamed';
}

/**
 * MCP servers may report a tool as destructive, read-only or idempotent. Those
 * hints decide whether the runtime is willing to replay the call after a crash,
 * so they are mapped explicitly instead of being guessed.
 */
export function idempotencyFor(definition: McpToolDefinition, idempotentTools: string[]): 'idempotent' | 'retry-safe' | 'non-idempotent' {
  if (idempotentTools.includes(definition.name)) return 'idempotent';
  if (definition.annotations?.idempotentHint === true) return 'idempotent';
  if (definition.annotations?.readOnlyHint === true) return 'idempotent';
  if (definition.annotations?.destructiveHint === false) return 'retry-safe';
  return 'non-idempotent';
}

export function riskFor(definition: McpToolDefinition, fallback: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (definition.annotations?.destructiveHint === true) return 'HIGH';
  if (definition.annotations?.readOnlyHint === true && fallback === 'HIGH') return 'MEDIUM';
  return fallback;
}

const MAX_TEXT_BYTES = 32 * 1024;

export interface NormalizedToolOutput {
  output: JsonValue;
  metadata: JsonObject;
  text: string;
  truncated: boolean;
}

/**
 * Flatten an MCP tool result into a JSON payload the runtime can persist,
 * summarize and hand to a model. Binary blobs are represented by size and
 * content type: an agent must ask for the artifact, not receive megabytes of
 * base64 through its context window.
 */
export function normalizeToolResult(result: { content?: McpContentBlock[]; structuredContent?: JsonValue; isError?: boolean }): NormalizedToolOutput {
  const blocks: JsonValue[] = [];
  const texts: string[] = [];
  let binaryBytes = 0;

  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      blocks.push({ type: 'text', text: truncate(block.text) });
      continue;
    }
    if (block.type === 'image' || block.type === 'audio') {
      const bytes = typeof block.data === 'string' ? Buffer.byteLength(block.data, 'base64') : 0;
      binaryBytes += bytes;
      blocks.push({ type: block.type, mimeType: block.mimeType ?? 'application/octet-stream', bytes });
      continue;
    }
    if (block.type === 'resource') {
      const resource = (block.resource ?? {}) as JsonObject;
      const text = typeof resource['text'] === 'string' ? resource['text'] : undefined;
      if (text !== undefined) texts.push(text);
      blocks.push({
        type: 'resource',
        uri: typeof resource['uri'] === 'string' ? resource['uri'] : (block.uri ?? ''),
        ...(typeof resource['mimeType'] === 'string' ? { mimeType: resource['mimeType'] } : {}),
        ...(text !== undefined ? { text: truncate(text) } : {}),
        ...(typeof resource['blob'] === 'string' ? { bytes: Buffer.byteLength(resource['blob'], 'base64') } : {}),
      });
      continue;
    }
    if (block.type === 'resource_link') {
      blocks.push({ type: 'resource_link', uri: String(block['uri'] ?? '') });
      continue;
    }
    blocks.push({ type: block.type } as JsonObject);
  }

  const structured = result.structuredContent;
  const raw: JsonValue = {
    content: blocks,
    ...(structured === undefined ? {} : { structured }),
  };
  const bounded = truncateJson(raw, MAX_TEXT_BYTES);
  return {
    output: bounded.value,
    metadata: {
      contentBlocks: blocks.length,
      ...(binaryBytes > 0 ? { binaryBytes } : {}),
      ...(result.isError === true ? { isError: true } : {}),
    },
    text: truncate(texts.join('\n\n')),
    truncated: bounded.truncated,
  };
}

function truncate(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return text;
  return `${text.slice(0, MAX_TEXT_BYTES)}… [truncated]`;
}

/**
 * A server's tools may only run when the run grants every capability the server
 * declared it needs. The check is repeated here because MCP tools can also be
 * invoked directly (CLI, SDK) without the executor in front of them.
 */
export function unmetPermissions(required: ToolPermissions, granted: ToolPermissions): string[] {
  const missing: string[] = [];
  for (const [category, values] of Object.entries(required)) {
    const grantedCategory = (granted as Record<string, Record<string, unknown> | undefined>)[category];
    for (const [capability, value] of Object.entries(values as Record<string, unknown>)) {
      if (value !== true) continue;
      if (grantedCategory?.[capability] !== true) missing.push(`${category}.${capability}`);
    }
  }
  return missing;
}

export function toolDescription(definition: McpToolDefinition, serverId: string): string {
  const base = definition.description ?? definition.title ?? definition.name;
  return `[mcp:${serverId}] ${base}`;
}
