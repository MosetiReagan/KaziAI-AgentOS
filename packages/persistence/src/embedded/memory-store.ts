import { newMemoryId, type MemoryEntry, type MemoryQuery, type MemoryScope, type MemoryStore } from '@kazi-ai/agentos-core';
import { JsonlLog } from './jsonl.js';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'for', 'on', 'with', 'as', 'by', 'at', 'be', 'this', 'that',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function scopeMatches(entry: MemoryScope, query: MemoryScope): boolean {
  if (entry.organizationId !== query.organizationId) return false;
  if (query.projectId && entry.projectId !== query.projectId) return false;
  if (query.runId && entry.runId !== query.runId) return false;
  if (query.agentId && entry.agentId !== query.agentId) return false;
  return true;
}

/**
 * Keyword-scored memory store. Deliberately not a vector store: the interface
 * allows one to be added later without changing callers.
 */
export class EmbeddedMemoryStore implements MemoryStore {
  private readonly log: JsonlLog<MemoryEntry>;

  constructor(dir?: string) {
    this.log = new JsonlLog<MemoryEntry>({ name: 'memory', ...(dir ? { dir } : {}) });
  }

  async write(entry: MemoryEntry): Promise<void> {
    this.log.put(entry);
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.log.get(id);
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const now = Date.now();
    const includeExpired = query.includeExpired ?? false;
    const limit = query.limit ?? 20;
    const terms = query.text ? tokenize(query.text) : [];

    const candidates = this.log.filter((entry) => {
      if (!scopeMatches(entry.scope, query.scope)) return false;
      if (!includeExpired && entry.expiresAt !== undefined && entry.expiresAt <= now) return false;
      if (query.types && query.types.length > 0 && !query.types.includes(entry.type)) return false;
      if (query.minImportance !== undefined && entry.importance < query.minImportance) return false;
      if (query.tags && query.tags.length > 0) {
        const tags = entry.tags ?? [];
        if (!query.tags.some((tag) => tags.includes(tag))) return false;
      }
      return true;
    });

    const scored = candidates.map((entry) => {
      const haystack = `${entry.content} ${entry.tags?.join(' ') ?? ''}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
        if (entry.content.toLowerCase().startsWith(term)) score += 0.5;
      }
      if (terms.length > 0) score = score / terms.length;
      const ageDays = (now - entry.createdAt) / 86_400_000;
      const recency = 1 / (1 + ageDays);
      return { entry, score, relevance: score * 0.6 + entry.importance * 0.3 + recency * 0.1 };
    });

    const orderBy = query.orderBy ?? (query.text ? 'relevance' : 'recent');
    scored.sort((left, right) => {
      if (orderBy === 'importance') return right.entry.importance - left.entry.importance;
      if (orderBy === 'recent') return right.entry.createdAt - left.entry.createdAt;
      if (right.relevance !== left.relevance) return right.relevance - left.relevance;
      return right.entry.createdAt - left.entry.createdAt;
    });

    const results = scored.slice(0, limit).map(({ entry }) => ({
      ...entry,
      accessCount: (entry.accessCount ?? 0) + 1,
      lastAccessedAt: now,
    }));
    for (const entry of results) this.log.put(entry);
    return results;
  }

  async delete(id: string): Promise<void> {
    this.log.delete(id);
  }

  async clear(scope: MemoryScope): Promise<number> {
    const victims = this.log.filter((entry) => scopeMatches(entry.scope, scope));
    for (const entry of victims) this.log.delete(entry.id);
    return victims.length;
  }

  async prune(now = Date.now()): Promise<number> {
    const expired = this.log.filter((entry) => entry.expiresAt !== undefined && entry.expiresAt <= now);
    for (const entry of expired) this.log.delete(entry.id);
    return expired.length;
  }

  size(): number {
    return this.log.size;
  }
}

export function makeMemoryEntry(input: {
  type: MemoryEntry['type'];
  scope: MemoryScope;
  content: string;
  source: string;
  importance?: number;
  confidence?: number;
  trust?: string;
  ttlMs?: number;
  tags?: string[];
  value?: MemoryEntry['value'];
  now?: number;
}): MemoryEntry {
  const now = input.now ?? Date.now();
  return {
    id: newMemoryId(now),
    type: input.type,
    scope: input.scope,
    content: input.content,
    ...(input.value === undefined ? {} : { value: input.value }),
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    source: input.source,
    trust: input.trust ?? 'untrusted-tool',
    createdAt: now,
    ...(input.ttlMs === undefined ? {} : { expiresAt: now + input.ttlMs }),
    ...(input.tags ? { tags: input.tags } : {}),
  };
}

