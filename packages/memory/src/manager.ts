import {
  newMemoryId,
  toJsonValue,
  type JsonValue,
  type Logger,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryScope,
  type MemoryStore,
  type MemoryType,
} from '@kazi-ai/agentos-core';
import { scopeChain } from './scopes.js';

export interface MemoryManagerOptions {
  store: MemoryStore;
  logger?: Logger;
  /** Memory off means writes are dropped, not buffered. */
  enabled?: boolean;
  defaultTtlMs?: number;
  /** Entries larger than this are truncated instead of rejected. */
  maxEntryBytes?: number;
  now?: () => number;
}

export interface RememberInput {
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  value?: JsonValue;
  importance?: number;
  confidence?: number;
  source: string;
  trust?: string;
  ttlMs?: number;
  tags?: string[];
}

/**
 * Memory is deliberately conservative: nothing is persisted unless someone
 * explicitly asks, everything carries provenance and confidence, and TTLs stop
 * unbounded accumulation (spec §28).
 */
export class MemoryManager {
  constructor(private readonly options: MemoryManagerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get enabled(): boolean {
    return this.options.enabled ?? true;
  }

  async remember(input: RememberInput): Promise<MemoryEntry | undefined> {
    if (!this.enabled) return undefined;
    const now = this.now();
    const maxBytes = this.options.maxEntryBytes ?? 16_384;
    const encoded = Buffer.from(input.content, 'utf8');
    const content =
      encoded.byteLength > maxBytes ? `${encoded.subarray(0, maxBytes).toString('utf8')}…[truncated]` : input.content;
    const ttl = input.ttlMs ?? this.options.defaultTtlMs;
    const entry: MemoryEntry = {
      id: newMemoryId(now),
      type: input.type,
      scope: input.scope,
      content,
      ...(input.value === undefined ? {} : { value: toJsonValue(input.value) }),
      importance: clamp(input.importance ?? 0.5),
      confidence: clamp(input.confidence ?? 0.8),
      source: input.source,
      trust: input.trust ?? 'untrusted-tool',
      createdAt: now,
      ...(ttl === undefined ? {} : { expiresAt: now + ttl }),
      ...(input.tags ? { tags: input.tags } : {}),
    };
    if (await this.isDuplicate(entry)) return undefined;
    await this.options.store.write(entry);
    return entry;
  }

  private async isDuplicate(entry: MemoryEntry): Promise<boolean> {
    const existing = await this.options.store.search({ scope: entry.scope, limit: 25, orderBy: 'recent' });
    return existing.some((candidate) => candidate.type === entry.type && candidate.content === entry.content);
  }

  async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.options.store.search(query);
  }

  /**
   * Search progressively broader scopes until enough results are found, so a run
   * benefits from project knowledge without ever crossing tenants.
   */
  async recallScoped(query: MemoryQuery & { fallbackToBroaderScopes?: boolean }): Promise<MemoryEntry[]> {
    const limit = query.limit ?? 10;
    if (query.fallbackToBroaderScopes === false) return this.recall({ ...query, limit });
    const seen = new Set<string>();
    const out: MemoryEntry[] = [];
    for (const scope of scopeChain(query.scope)) {
      const results = await this.recall({ ...query, scope, limit: limit - out.length });
      for (const entry of results) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        out.push(entry);
      }
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  async forget(id: string): Promise<void> {
    await this.options.store.delete(id);
  }

  async clearScope(scope: MemoryScope): Promise<number> {
    return this.options.store.clear(scope);
  }

  async pruneExpired(): Promise<number> {
    return this.options.store.prune(this.now());
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

