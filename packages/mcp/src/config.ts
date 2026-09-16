import { z } from 'zod';
import type { ToolPermissions } from '@kazi-ai/agentos-core';

const permissionShape = z
  .object({
    filesystem: z
      .object({ read: z.boolean().optional(), write: z.boolean().optional(), delete: z.boolean().optional(), roots: z.array(z.string()).optional() })
      .optional(),
    terminal: z
      .object({ execute: z.boolean().optional(), allowCommands: z.array(z.string()).optional(), denyCommands: z.array(z.string()).optional() })
      .optional(),
    network: z.object({ enabled: z.boolean().optional(), allowedHosts: z.array(z.string()).optional(), methods: z.array(z.string()).optional() }).optional(),
    git: z.object({ read: z.boolean().optional(), commit: z.boolean().optional(), push: z.boolean().optional() }).optional(),
    database: z.object({ read: z.boolean().optional(), write: z.boolean().optional(), connections: z.array(z.string()).optional() }).optional(),
  })
  .strict();

export const mcpServerConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'server ids are lowercase, e.g. "github"'),
    description: z.string().optional(),
    transport: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('stdio'),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).default({}),
      }),
      z.object({
        type: z.literal('http'),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).default({}),
        auth: z
          .object({
            header: z.string().min(1),
            scheme: z.string().optional(),
            secretRef: z.string().regex(/^secret:\/\//, 'use a secret:// reference, never a literal credential'),
          })
          .optional(),
      }),
    ]),
    /** Server handshake identity. */
    clientInfo: z.object({ name: z.string(), version: z.string() }).optional(),
    /** Per-RPC ceiling and handshake ceiling. */
    requestTimeoutMs: z.number().int().positive().default(30_000),
    /** Only these tools are exposed; empty means every discovered tool. */
    allowedTools: z.array(z.string()).default([]),
    /** Discovered tools matching these are never registered. */
    blockedTools: z.array(z.string()).default([]),
    /** Risk assigned to this server's tools, used by the policy engine. */
    risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
    /** Capabilities the run must grant before any of this server's tools may run. */
    permissions: permissionShape.default({}),
    /** Discovered tools are treated as non-idempotent unless listed here. */
    idempotentTools: z.array(z.string()).default([]),
    enabled: z.boolean().default(true),
  })
  .strict();

export type McpServerConfigInput = z.input<typeof mcpServerConfigSchema>;
export type McpServerConfig = z.output<typeof mcpServerConfigSchema>;

export interface McpConfigFile {
  servers: McpServerConfigInput[];
}

export const mcpConfigFileSchema = z.object({ servers: z.array(mcpServerConfigSchema).default([]) }).strict();

export function parseServerConfig(input: McpServerConfigInput): McpServerConfig {
  return mcpServerConfigSchema.parse(input);
}

export function parseServerConfigs(input: unknown): McpServerConfig[] {
  if (Array.isArray(input)) {
    return input.map((entry, index) => {
      const parsed = mcpServerConfigSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`Invalid MCP server config at index ${index}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
      }
      return parsed.data;
    });
  }
  const parsed = mcpConfigFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid MCP config: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  }
  return parsed.data.servers;
}

export function permissionsOf(config: McpServerConfig): ToolPermissions {
  return config.permissions as ToolPermissions;
}
