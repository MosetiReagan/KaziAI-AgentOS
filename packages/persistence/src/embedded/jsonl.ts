import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface JsonlLogOptions {
  /** Directory for durable storage. When omitted the log is memory-only. */
  dir?: string;
  name: string;
}

/**
 * Append-only JSONL log with an in-memory index. When a directory is supplied
 * every append is flushed to disk, which is what makes worker crashes
 * survivable: a restarted process rebuilds state from the log.
 */
export class JsonlLog<T extends { id: string }> {
  private readonly records = new Map<string, T>();
  private readonly order: string[] = [];
  private readonly path: string | undefined;
  private readonly rewritePath: string | undefined;

  constructor(options: JsonlLogOptions) {
    if (options.dir) {
      const dir = join(options.dir, 'collections');
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, `${options.name}.jsonl`);
      this.rewritePath = `${this.path}.rewrite`;
      this.load();
    }
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as T;
        if (!this.records.has(record.id)) this.order.push(record.id);
        this.records.set(record.id, record);
      } catch {
        // A torn final line from a crash mid-append is expected; skip it.
      }
    }
  }

  put(record: T): void {
    if (!this.records.has(record.id)) this.order.push(record.id);
    this.records.set(record.id, record);
    this.append(record);
  }

  private append(record: T): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  get(id: string): T | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  delete(id: string): void {
    if (!this.records.delete(id)) return;
    const index = this.order.indexOf(id);
    if (index >= 0) this.order.splice(index, 1);
    this.compact();
  }

  all(): T[] {
    const out: T[] = [];
    for (const id of this.order) {
      const record = this.records.get(id);
      if (record) out.push(record);
    }
    return out;
  }

  filter(predicate: (record: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  find(predicate: (record: T) => boolean): T | undefined {
    for (const id of this.order) {
      const record = this.records.get(id);
      if (record && predicate(record)) return record;
    }
    return undefined;
  }

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    this.order.length = 0;
    if (this.path) this.compact();
  }

  /** Rewrite the log from the in-memory index, dropping superseded records. */
  compact(): void {
    if (!this.path || !this.rewritePath) return;
    const body = this.all()
      .map((record) => `${JSON.stringify(record)}\n`)
      .join('');
    writeFileSync(this.rewritePath, body, 'utf8');
    renameSync(this.rewritePath, this.path);
  }
}

/** An append-only log where every line is a distinct fact (events, journal). */
export class JsonlAppendLog<T> {
  private readonly items: T[] = [];
  private readonly path: string | undefined;

  constructor(options: JsonlLogOptions) {
    if (options.dir) {
      const dir = join(options.dir, 'logs');
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, `${options.name}.jsonl`);
      this.load();
    }
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    const raw = readFileSync(this.path, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.items.push(JSON.parse(trimmed) as T);
      } catch {
        // Ignore a torn tail line left by a crash.
      }
    }
  }

  append(item: T): void {
    this.items.push(item);
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(item)}\n`, 'utf8');
  }

  all(): T[] {
    return [...this.items];
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.items.filter(predicate);
  }

  get length(): number {
    return this.items.length;
  }

  truncate(keep: number): void {
    this.items.splice(0, Math.max(0, this.items.length - keep));
  }
}

