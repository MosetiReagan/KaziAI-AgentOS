/**
 * A real SQLite database, a real transient outage, and the read-only tool the
 * agent uses to talk to it (spec §73, §95).
 *
 * Nothing here simulates a failure. "The maintenance job is running" is a second
 * connection holding `BEGIN EXCLUSIVE`, and the error the agent sees is SQLite's
 * own `database is locked`. The retry that follows genuinely re-runs the action
 * against the same file.
 *
 * Why a custom tool instead of the built-in `database.query`? Because the
 * built-in is a general SQL runner and declares itself HIGH risk, which is the
 * right call for it: policy then sends every call to a human. This example wants
 * to show recovery, not approval, so it ships the narrower tool an organisation
 * would ship anyway - one that runs exactly one read and cannot express a write.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { ToolExecutionError, toolResult } from '@kazi-ai/agentos-core';
import { canUseDatabase, defineTool, jsonValueOf } from '@kazi-ai/agentos-tools';
import { z } from 'zod';

export const CONNECTION = 'shop';
export const THRESHOLD_CENTS = 10_000;

/** A small shop ledger the analyst agent has been pointed at. */
export const ORDERS: Array<[string, number]> = [
  ['ada', 12_000],
  ['grace', 25_000],
  ['linus', 5_000],
  ['barbara', 18_000],
  ['katherine', 9_000],
  ['alan', 30_000],
];

/** Create the database and fill it. Re-running this resets it. */
export function seedDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('drop table if exists orders');
    db.exec('create table orders(id integer primary key, customer text not null, amount_cents integer not null)');
    const insert = db.prepare('insert into orders(customer, amount_cents) values (?, ?)');
    for (const [customer, amount] of ORDERS) insert.run(customer, amount);
  } finally {
    db.close();
  }
}

export interface MaintenanceJob {
  /** Finish the maintenance transaction. Safe to call more than once. */
  end(): void;
  readonly ended: boolean;
}

/**
 * Hold a write lock on the database from a second connection, the way a
 * migration or a backup would. While this is held, a reader that arrives gets
 * `database is locked`.
 */
export function startMaintenanceJob(path: string): MaintenanceJob {
  const db = new DatabaseSync(path);
  db.exec('BEGIN EXCLUSIVE');
  let ended = false;
  return {
    get ended() {
      return ended;
    },
    end() {
      if (ended) return;
      ended = true;
      try {
        db.exec('COMMIT');
      } finally {
        db.close();
      }
    },
  };
}

export interface LedgerToolOptions {
  /**
   * Called the first time a read fails because the database is locked. The
   * example uses it to end the maintenance job: a fixed sleep would make this
   * demo a coin flip, because the runtime's backoff is jittered (spec §37).
   */
  onLocked?: () => void;
}

/**
 * `ledger.orders_over` - one read, no way to express a write.
 *
 * It is read-only by construction (there is no SQL parameter), which is what
 * makes its declared LOW risk honest rather than a convenient label, and it
 * still asks the run's permissions for the connection before touching anything.
 */
const ledgerInput = z.object({
  threshold_cents: z.number().int().nonnegative().default(THRESHOLD_CENTS),
});

type LedgerInput = z.infer<typeof ledgerInput>;

export function createLedgerTool(options: LedgerToolOptions = {}) {
  let reportedLock = false;
  return defineTool<LedgerInput>({
    id: 'ledger.orders_over',
    description:
      'Total value and count of orders above a threshold in the shop ledger. Read-only.',
    risk: 'LOW',
    permissions: { database: { read: true, connections: [CONNECTION] } },
    idempotency: 'idempotent',
    input: ledgerInput,
    async execute(input, context) {
      const permission = canUseDatabase(context.permissions, 'read');
      const allowed = context.permissions.database?.connections ?? [];
      if (!permission.allowed || !allowed.includes(CONNECTION)) {
        throw new ToolExecutionError('ledger.orders_over', permission.reason ?? 'ledger access denied', {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency: 'idempotent',
        });
      }
      const path = await context.secrets.resolve(`db/${CONNECTION}`);
      const database = new DatabaseSync(path);
      try {
        const rows = database
          .prepare(
            'select sum(amount_cents) as total_cents, count(*) as order_count from orders where amount_cents > ?',
          )
          .all(input.threshold_cents satisfies number as SQLInputValue);
        return toolResult({
          success: true,
          output: jsonValueOf(rows[0] ?? { total_cents: 0, order_count: 0 }),
          idempotency: 'idempotent',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'ledger read failed';
        const locked = message.includes('database is locked');
        if (!reportedLock && locked) {
          reportedLock = true;
          options.onLocked?.();
        }
        // `defineTool` wraps a plain Error as a non-retryable `tool.custom_failed`,
        // and the recovery engine refuses to retry a non-retryable failure. A
        // locked database is the textbook transient error, so the tool says so
        // itself (spec §37).
        throw new ToolExecutionError('ledger.orders_over', message, {
          code: locked ? 'tool.database_locked' : 'tool.database_error',
          retryable: locked,
          idempotency: 'idempotent',
          cause: error,
        });
      } finally {
        database.close();
      }
    },
  });
}
