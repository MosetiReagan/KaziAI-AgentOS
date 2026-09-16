import type { JsonObject, JsonValue } from '../json.js';
import type { ActionStatus } from './action.js';

/** One append-only entry per attempted action. */
export interface JournalEntry {
  id: string;
  runId: string;
  sequence: number;
  actionId: string;
  idempotencyKey: string;
  toolId: string;
  /** Normalized arguments captured at intent time, used for post-crash forensics. */
  arguments?: JsonValue;
  idempotency?: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  argumentsHash: string;
  status: ActionStatus;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  result?: JsonValue;
  error?: JsonObject;
  policyDecision?: JsonObject;
  stepId?: string;
}

export type JournalPhase = 'intent' | 'commit' | 'abort';

export interface ActionJournal {
  /** Record intent before executing so a crash leaves evidence of the attempt. */
  recordIntent(entry: Omit<JournalEntry, 'sequence'>): Promise<JournalEntry>;
  /** Record the committed outcome. Idempotent by idempotencyKey. */
  recordCommit(entry: {
    runId: string;
    idempotencyKey: string;
    status: ActionStatus;
    result?: JsonValue;
    error?: JsonObject;
    finishedAt: number;
  }): Promise<JournalEntry>;
  findByKey(runId: string, idempotencyKey: string): Promise<JournalEntry | undefined>;
  list(runId: string): Promise<JournalEntry[]>;
  /** Entries whose intent was recorded but never committed. */
  pending(runId: string): Promise<JournalEntry[]>;
  lastCommitted(runId: string): Promise<JournalEntry | undefined>;
}
