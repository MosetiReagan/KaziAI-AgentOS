import { z } from 'zod';
import {
  ToolExecutionError,
  ToolInputError,
  toAgentError,
  toolResult,
  truncateJson,
  type AgentTool,
  type JsonValue,
  type ToolContext,
} from '@kazi-ai/agentos-core';
import { canUseDatabase } from '../permissions.js';

export interface QueryOutcome {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  fields: string[];
}

export interface DatabaseConnection {
  /** Execute SQL, optionally inside a read-only transaction. */
  query(sql: string, params: unknown[], options: { readOnly: boolean; timeoutMs: number; maxRows: number }): Promise<QueryOutcome>;
  close(): Promise<void>;
}

export interface DatabaseDriver {
  /** Open a connection using a name resolved by the secret provider. */
  open(connectionString: string): Promise<DatabaseConnection>;
}

const databaseInput = z.object({
  connection: z.string().min(1).describe('Named connection from the run permissions, e.g. "analytics"'),
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).default([]),
  readonly: z.boolean().default(true),
  max_rows: z.number().int().positive().max(10_000).default(200),
  timeout_ms: z.number().int().positive().max(120_000).default(15_000),
});

export interface DatabaseToolOptions {
  driver?: DatabaseDriver;
}

/**
 * Query tool with no ability to invent a connection: the agent may only name a
 * connection that the run's permissions already allow, and the connection
 * string itself is fetched from the secret provider.
 */
export function createDatabaseQueryTool(options: DatabaseToolOptions = {}): AgentTool {
  return {
    id: 'database.query',
    description:
      'Run a parameterized SQL query against a named, pre-authorized database connection. Read-only unless the run permits writes.',
    kind: 'database',
    risk: 'HIGH',
    timeoutMs: 120_000,
    inputSchema: databaseInput,
    permissions: { database: { read: true, write: false } },
    async execute(input: unknown, context: ToolContext) {
      const args = databaseInput.parse(input);
      const allowedConnections = context.permissions.database?.connections ?? [];
      if (allowedConnections.length === 0 || !allowedConnections.includes(args.connection)) {
        throw new ToolExecutionError('database.query', `Connection "${args.connection}" is not authorized for this run`, {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency: 'idempotent',
          details: { connection: args.connection, allowed: allowedConnections },
        });
      }
      const permission = canUseDatabase(context.permissions, args.readonly ? 'read' : 'write');
      if (!permission.allowed) {
        throw new ToolExecutionError('database.query', permission.reason ?? 'database access denied', {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency: 'idempotent',
        });
      }
      if (!/^\s*(select|with|show|explain|table|values)\b/i.test(args.sql) && args.readonly) {
        throw new ToolInputError('database.query', 'Statement is not a read-only query; pass readonly=false with write permission');
      }

      const driver = options.driver ?? (await defaultDriver());
      const connectionString = await context.secrets.resolve(`db/${args.connection}`);
      const connection = await driver.open(connectionString);
      try {
        const outcome = await connection.query(args.sql, args.params, {
          readOnly: args.readonly,
          timeoutMs: args.timeout_ms,
          maxRows: args.max_rows,
        });
        const rows = outcome.rows.slice(0, args.max_rows);
        const { value, truncated } = truncateJson(rows, 256 * 1024);
        return toolResult({
          success: true,
          output: {
            connection: args.connection,
            row_count: outcome.rowCount,
            fields: outcome.fields,
            rows: value,
            truncated: truncated || outcome.rows.length > rows.length,
          } as JsonValue,
          idempotency: args.readonly ? 'idempotent' : 'unknown',
        });
      } catch (error) {
        const agentError = toAgentError(error);
        throw new ToolExecutionError('database.query', agentError.message, {
          code: agentError.code === 'internal.error' ? 'tool.database_error' : agentError.code,
          retryable: true,
          idempotency: args.readonly ? 'idempotent' : 'unknown',
          cause: error,
        });
      } finally {
        await connection.close();
      }
    },
  };
}

async function defaultDriver(): Promise<DatabaseDriver> {
  const { PostgresDatabaseDriver } = await import('../drivers/postgres-driver.js');
  return new PostgresDatabaseDriver();
}

export function createDatabaseTools(options: DatabaseToolOptions = {}): AgentTool[] {
  return [createDatabaseQueryTool(options)];
}

