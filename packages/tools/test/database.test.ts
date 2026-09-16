import { describe, expect, it } from 'vitest';
import { createDatabaseQueryTool, createTestToolContext, type DatabaseConnection, type DatabaseDriver } from '../src/index.js';

function fakeDriver(): { driver: DatabaseDriver; queries: Array<{ sql: string; readOnly: boolean; params: unknown[] }> } {
  const queries: Array<{ sql: string; readOnly: boolean; params: unknown[] }> = [];
  const driver: DatabaseDriver = {
    open: async (): Promise<DatabaseConnection> => ({
      query: async (sql, params, options) => {
        queries.push({ sql, readOnly: options.readOnly, params });
        return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2, fields: ['id'] };
      },
      close: async () => {},
    }),
  };
  return { driver, queries };
}

describe('database tool', () => {
  it('requires an explicitly authorized connection name', async () => {
    const context = await createTestToolContext({
      permissions: { database: { read: true, connections: ['analytics'] } },
      secrets: { 'db/analytics': 'postgresql://localhost/analytics' },
    });
    const { driver } = fakeDriver();
    const tool = createDatabaseQueryTool({ driver });
    await expect(tool.execute({ connection: 'production', sql: 'select 1' }, context)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
  });

  it('runs a read-only query inside a read-only transaction', async () => {
    const context = await createTestToolContext({
      permissions: { database: { read: true, connections: ['analytics'] } },
      secrets: { 'db/analytics': 'postgresql://localhost/analytics' },
    });
    const { driver, queries } = fakeDriver();
    const tool = createDatabaseQueryTool({ driver });
    const result = await tool.execute({ connection: 'analytics', sql: 'select * from events', params: [] }, context);
    expect(result.success).toBe(true);
    expect(queries[0]).toMatchObject({ readOnly: true });
    expect(result.output).toMatchObject({ row_count: 2, fields: ['id'] });
  });

  it('refuses a mutating statement in read-only mode', async () => {
    const context = await createTestToolContext({
      permissions: { database: { read: true, connections: ['analytics'] } },
      secrets: { 'db/analytics': 'postgresql://localhost/analytics' },
    });
    const { driver } = fakeDriver();
    const tool = createDatabaseQueryTool({ driver });
    await expect(
      tool.execute({ connection: 'analytics', sql: 'delete from events where id = 1' }, context),
    ).rejects.toMatchObject({ code: 'tool.invalid_input' });
  });

  it('requires write permission for mutating statements', async () => {
    const readOnlyRun = await createTestToolContext({
      permissions: { database: { read: true, connections: ['app'] } },
      secrets: { 'db/app': 'postgresql://localhost/app' },
    });
    const { driver } = fakeDriver();
    const tool = createDatabaseQueryTool({ driver });
    await expect(
      tool.execute({ connection: 'app', sql: 'update t set a = 1', readonly: false }, readOnlyRun),
    ).rejects.toMatchObject({ code: 'tool.permission_denied' });

    const writableRun = await createTestToolContext({
      permissions: { database: { read: true, write: true, connections: ['app'] } },
      secrets: { 'db/app': 'postgresql://localhost/app' },
    });
    const result = await tool.execute({ connection: 'app', sql: 'update t set a = 1', readonly: false }, writableRun);
    expect(result.success).toBe(true);
  });
});

