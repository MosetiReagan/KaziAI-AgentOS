import type { JsonObject, JsonValue } from '../json.js';

export type MemoryType = 'working' | 'episodic' | 'semantic' | 'task';

export interface MemoryScope {
  organizationId: string;
  projectId?: string;
  runId?: string;
  agentId?: string;
}

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  content: string;
  /** Structured payload for retrieval and rendering. */
  value?: JsonValue;
  importance: number;
  confidence: number;
  source: string;
  /** Provenance: whether this content may be treated as instructions. */
  trust: string;
  createdAt: number;
  expiresAt?: number;
  lastAccessedAt?: number;
  accessCount?: number;
  tags?: string[];
  metadata?: JsonObject;
}

export interface MemoryQuery {
  scope: MemoryScope;
  text?: string;
  types?: MemoryType[];
  tags?: string[];
  minImportance?: number;
  limit?: number;
  /** Include entries whose TTL elapsed. Defaults to false. */
  includeExpired?: boolean;
  orderBy?: 'recent' | 'importance' | 'relevance';
}

export interface MemoryStore {
  write(entry: MemoryEntry): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry | undefined>;
  delete(id: string): Promise<void>;
  clear(scope: MemoryScope): Promise<number>;
  /** Remove expired entries; returns the number removed. */
  prune(now?: number): Promise<number>;
}

export interface MemoryWriteInput {
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
  metadata?: JsonObject;
}

export interface Retriever {
  retrieve(query: MemoryQuery): Promise<MemoryEntry[]>;
}

