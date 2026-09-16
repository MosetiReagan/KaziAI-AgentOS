import { randomUUID } from 'node:crypto';
import { ConcurrencyError } from './errors.js';

export interface LockHandle {
  key: string;
  token: string;
  expiresAt: number;
}

export interface LockManager {
  acquire(key: string, options?: { ttlMs?: number; wait?: boolean; signal?: AbortSignal }): Promise<LockHandle>;
  release(handle: LockHandle): Promise<void>;
  extend(handle: LockHandle, ttlMs: number): Promise<boolean>;
  withLock<T>(key: string, fn: () => Promise<T>, options?: { ttlMs?: number; signal?: AbortSignal }): Promise<T>;
}

interface Entry {
  token: string;
  expiresAt: number;
}

/**
 * In-process lock manager. Correct for a single node and for tests; the
 * Postgres/Redis drivers provide the distributed implementation.
 */
export class InMemoryLockManager implements LockManager {
  private readonly entries = new Map<string, Entry>();
  private readonly waiting = new Map<string, Array<() => void>>();

  constructor(private readonly defaultTtlMs = 60_000) {}

  private purge(key: string): void {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) this.entries.delete(key);
  }

  async acquire(
    key: string,
    options: { ttlMs?: number; wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<LockHandle> {
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    for (;;) {
      this.purge(key);
      if (!this.entries.has(key)) {
        const handle: LockHandle = { key, token: randomUUID(), expiresAt: Date.now() + ttlMs };
        this.entries.set(key, { token: handle.token, expiresAt: handle.expiresAt });
        return handle;
      }
      if (options.wait === false) throw new ConcurrencyError(`Lock already held: ${key}`, { key });
      if (options.signal?.aborted) throw new ConcurrencyError(`Lock acquisition aborted: ${key}`, { key });
      await new Promise<void>((resolve) => {
        const list = this.waiting.get(key) ?? [];
        list.push(resolve);
        this.waiting.set(key, list);
        setTimeout(() => {
          const current = this.waiting.get(key) ?? [];
          const index = current.indexOf(resolve);
          if (index >= 0) {
            current.splice(index, 1);
            resolve();
          }
        }, 25);
      });
    }
  }

  async release(handle: LockHandle): Promise<void> {
    const entry = this.entries.get(handle.key);
    if (entry && entry.token === handle.token) this.entries.delete(handle.key);
    const list = this.waiting.get(handle.key);
    if (list && list.length > 0) {
      const next = list.shift();
      next?.();
    }
  }

  async extend(handle: LockHandle, ttlMs: number): Promise<boolean> {
    const entry = this.entries.get(handle.key);
    if (!entry || entry.token !== handle.token) return false;
    entry.expiresAt = Date.now() + ttlMs;
    handle.expiresAt = entry.expiresAt;
    return true;
  }

  async withLock<T>(key: string, fn: () => Promise<T>, options: { ttlMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const handle = await this.acquire(key, options);
    try {
      return await fn();
    } finally {
      await this.release(handle);
    }
  }

  /** Test helper: number of currently held locks. */
  size(): number {
    return this.entries.size;
  }
}

