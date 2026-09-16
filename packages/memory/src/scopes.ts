import type { MemoryScope } from '@kazi-ai/agentos-core';

export function organizationScope(organizationId: string): MemoryScope {
  return { organizationId };
}

export function projectScope(organizationId: string, projectId: string): MemoryScope {
  return { organizationId, projectId };
}

export function agentScope(organizationId: string, projectId: string, agentId: string): MemoryScope {
  return { organizationId, projectId, agentId };
}

export function runScope(organizationId: string, projectId: string, runId: string): MemoryScope {
  return { organizationId, projectId, runId };
}

export function scopeKey(scope: MemoryScope): string {
  return [scope.organizationId, scope.projectId ?? '*', scope.runId ?? '*', scope.agentId ?? '*'].join('/');
}

/** Narrower scopes are searched before broader ones, then deduplicated by id. */
export function scopeChain(run: MemoryScope): MemoryScope[] {
  const chain: MemoryScope[] = [run];
  if (run.agentId) {
    chain.push({ organizationId: run.organizationId, ...(run.projectId ? { projectId: run.projectId } : {}) });
  }
  chain.push({ organizationId: run.organizationId, ...(run.projectId ? { projectId: run.projectId } : {}) });
  chain.push({ organizationId: run.organizationId });
  return dedupe(chain);
}

function dedupe(scopes: MemoryScope[]): MemoryScope[] {
  const seen = new Set<string>();
  const out: MemoryScope[] = [];
  for (const scope of scopes) {
    const key = scopeKey(scope);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scope);
  }
  return out;
}

