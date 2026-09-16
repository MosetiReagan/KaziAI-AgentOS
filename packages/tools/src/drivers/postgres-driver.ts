import type { DatabaseConnection, DatabaseDriver, QueryOutcome } from '../tools/database.js';

interface PgClientLike {
  connect(): Promise<void>;
  query(config: { text: string; values: unknown[]; rowMode?: 'array' }): Promise<{ rows: unknown[]; rowCount: number | null; fields?: Array<{ name: string }> }>;
  end(): Promise<void>;
}

/**
 * Postgres driver used by the database tool. Statements run with a local
 * statement timeout and, when read-only, inside a `READ ONLY` transaction so a
 * misclassified query cannot mutate data.
 */
export class PostgresDatabaseDriver implements DatabaseDriver {
  async open(connectionString: string): Promise<DatabaseConnection> {
    const { Client } = (await import('pg')) as unknown as { Client: new (config: { connectionString: string }) => PgClientLike };
    const client = new Client({ connectionString });
    await client.connect();
    return {
      async query(sql: string, params: unknown[], options): Promise<QueryOutcome> {
        await client.query({ text: `SET statement_timeout = ${Math.floor(options.timeoutMs)}`, values: [] });
        if (options.readOnly) await client.query({ text: 'BEGIN READ ONLY', values: [] });
        try {
          const result = await client.query({ text: sql, values: params });
          const rows = (result.rows as Array<Record<string, unknown>>).slice(0, options.maxRows);
          return {
            rows,
            rowCount: result.rowCount ?? rows.length,
            fields: (result.fields ?? []).map((field) => field.name),
          };
        } finally {
          if (options.readOnly) await client.query({ text: 'ROLLBACK', values: [] });
        }
      },
      async close(): Promise<void> {
        await client.end();
      },
    };
  }
}

