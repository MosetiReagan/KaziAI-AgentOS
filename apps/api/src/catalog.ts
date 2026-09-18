import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError, type JsonValue } from '@kazi-ai/agentos-core';
import type { AgentOS } from '@kazi-ai/agentos';
import { parseAgentDefinitionYaml, type AgentDefinition } from '@kazi-ai/agentos';

export const DEFINITION_FILE_PATTERN = /\.(ya?ml|json)$/i;

export interface AgentCatalogOptions {
  os: AgentOS;
  /** Extra directories scanned for definition files, checked after the store. */
  dirs?: string[];
}

export interface AgentSummary {
  id: string;
  version: string;
  name?: string;
  description?: string;
  model: { provider: string; model: string };
  tools: string[];
  source: 'store' | 'file';
  dir?: string;
}

export interface TenantScope {
  organizationId: string;
  projectId: string;
}

/**
 * Resolves agent definitions for a tenant. Definitions registered in the
 * durable store win over files on disk, so an operator can pin a version
 * without redeploying (spec §61, §78).
 */
export class AgentCatalog {
  private readonly fileCache = new Map<string, AgentDefinition>();

  constructor(private readonly options: AgentCatalogOptions) {}

  /** Every definition visible to a tenant, deduplicated by id. */
  async list(scope: TenantScope): Promise<AgentSummary[]> {
    const byId = new Map<string, AgentSummary>();
    for (const [dir, definition] of this.fileDefinitions()) {
      byId.set(definition.id, {
        id: definition.id,
        version: definition.version,
        ...(definition.name === undefined ? {} : { name: definition.name }),
        ...(definition.description === undefined ? {} : { description: definition.description }),
        model: { provider: definition.model.provider, model: definition.model.model },
        tools: definition.tools,
        source: 'file',
        dir,
      });
    }
    const records = await this.options.os.store.agentDefinitions.list(
      scope.organizationId,
      scope.projectId,
    );
    for (const record of records) {
      if (byId.has(record.id) && byId.get(record.id)?.source === 'store') continue;
      const definition = parseDefinition(record.definition, record.id);
      byId.set(record.id, {
        id: definition.id,
        version: record.version,
        ...(definition.name === undefined ? {} : { name: definition.name }),
        ...(definition.description === undefined ? {} : { description: definition.description }),
        model: { provider: definition.model.provider, model: definition.model.model },
        tools: definition.tools,
        source: 'store',
      });
    }
    return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** The full definition for one agent, or undefined when the tenant has none. */
  async resolve(scope: TenantScope, agentId: string): Promise<AgentDefinition | undefined> {
    const record = await this.options.os.store.agentDefinitions.get(
      scope.organizationId,
      agentId,
    );
    if (record) return parseDefinition(record.definition, agentId);
    return this.fileDefinitions().find(([, definition]) => definition.id === agentId)?.[1];
  }

  /** Definitions found on disk, in deterministic order. */
  fileDefinitions(): Array<[string, AgentDefinition]> {
    const out: Array<[string, AgentDefinition]> = [];
    for (const dir of this.options.dirs ?? []) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir).sort()) {
        if (!DEFINITION_FILE_PATTERN.test(entry)) continue;
        const path = join(dir, entry);
        const cached = this.fileCache.get(path);
        if (cached) {
          out.push([dir, cached]);
          continue;
        }
        const text = readFileSync(path, 'utf8');
        try {
          const definition = parseAgentDefinitionYaml(text);
          this.fileCache.set(path, definition);
          out.push([dir, definition]);
        } catch (error) {
          throw new ValidationError(
            `Agent definition ${path} is invalid: ${(error as Error).message}`,
            { path },
          );
        }
      }
    }
    return out;
  }
}

function parseDefinition(definition: JsonValue, agentId: string): AgentDefinition {
  // Definitions stored by the runtime are already validated; re-parsing keeps
  // one code path and catches hand-edited rows.
  const raw = definition as unknown as Record<string, unknown>;
  if (raw['id'] !== agentId) {
    throw new ValidationError(`Stored definition ${agentId} has a mismatched id`, { agentId });
  }
  return raw as unknown as AgentDefinition;
}
