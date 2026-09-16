import { NotFoundError, sha256, type JsonObject } from '@kazi-ai/agentos-core';

/** A prompt either lives inline in the definition or in the prompt registry. */
export type PromptSource = string | { registry: string; version?: string };

export interface PromptReference {
  registry: string;
  version?: string;
}

export interface ResolvedPrompt {
  id: string;
  version: string;
  hash: string;
  text: string;
}

export interface PromptRegistryClient {
  resolve(reference: PromptReference): Promise<ResolvedPrompt>;
}

export interface PromptRecord {
  id: string;
  version: string;
  text: string;
  createdAt?: number;
  metadata?: JsonObject;
}

/**
 * Resolves `kazi://` prompt references. The runtime records the resolved id,
 * version and hash in the run metadata so a run can always be traced back to
 * the exact prompt text that produced it (spec §61).
 */
export interface PromptResolver {
  resolve(source: PromptSource): Promise<ResolvedPrompt>;
}

export class InMemoryPromptRegistry implements PromptResolver, PromptRegistryClient {
  private readonly prompts = new Map<string, PromptRecord>();

  constructor(records: PromptRecord[] = []) {
    for (const record of records) this.register(record);
  }

  register(record: PromptRecord): void {
    this.prompts.set(`${record.id}@${record.version}`, record);
  }

  versions(id: string): string[] {
    return [...this.prompts.values()]
      .filter((record) => record.id === id)
      .map((record) => record.version)
      .sort(compareVersions);
  }

  async resolve(source: PromptSource): Promise<ResolvedPrompt> {
    if (typeof source === 'string') {
      return { id: 'inline', version: '0.0.0', hash: sha256(source), text: source };
    }
    const ref: PromptReference = { registry: source.registry, ...(source.version ? { version: source.version } : {}) };
    return this.resolveReference(ref);
  }

  async resolveReference(reference: PromptReference): Promise<ResolvedPrompt> {
    const id = normalizePromptId(reference.registry);
    const version = reference.version ?? this.versions(id).at(-1);
    if (!version) throw new NotFoundError('prompt', reference.registry);
    const record = this.prompts.get(`${id}@${version}`);
    if (!record) throw new NotFoundError('prompt', `${reference.registry}@${version}`);
    return { id: record.id, version: record.version, hash: sha256(record.text), text: record.text };
  }
}

/** `kazi://agents/coding/system` → `agents/coding/system`. */
export function normalizePromptId(registry: string): string {
  return registry.replace(/^kazi:\/\//, '').replace(/\/$/, '');
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.localeCompare(right);
}
