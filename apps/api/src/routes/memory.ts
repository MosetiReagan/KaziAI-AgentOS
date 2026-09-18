import type { FastifyInstance } from 'fastify';
import type { MemoryEntry, MemoryType } from '@kazi-ai/agentos-core';
import { parse, searchMemorySchema } from '../schemas.js';
import { param, requireRole } from '../http.js';
import { notFound } from '../errors.js';
import type { ApiContext } from '../types.js';

/**
 * Memory inspection (spec §29, §52). Memory is scoped data with provenance, so
 * an operator can see exactly what an agent remembered, how confident it was
 * and when it expires — and can forget a single entry without clearing a run.
 */
export function registerMemoryRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/memory', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'viewer', 'read memory');
    const query = parse(searchMemorySchema, request.query, 'query');
    const projectId = principal.projectId ?? context.projectId;
    const scope = {
      organizationId: principal.organizationId,
      ...(projectId ? { projectId } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
    };
    const limit = query.limit ?? 100;
    const items = await context.store.memory.search({
      scope,
      ...(query.text ? { text: query.text } : {}),
      ...(query.type ? { types: [query.type as MemoryType] } : {}),
      ...(query.tags ? { tags: split(query.tags) } : {}),
      ...(query.minImportance === undefined ? {} : { minImportance: query.minImportance }),
      ...(query.includeExpired === undefined ? {} : { includeExpired: query.includeExpired }),
      ...(query.orderBy ? { orderBy: query.orderBy } : {}),
      limit: limit + 1,
    });
    const hasMore = items.length > limit;
    const visible = hasMore ? items.slice(0, limit) : items;
    return {
      items: visible,
      scope,
      total: visible.length,
      hasMore,
      summary: summarize(visible),
    };
  });

  app.delete('/api/memory/:id', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'operator', 'delete memory');
    const id = param(request, 'id');
    const entry = await context.store.memory.get(id);
    // Another tenant's memory must not be distinguishable from a missing id.
    if (!entry || entry.scope.organizationId !== principal.organizationId) {
      throw notFound(`Memory entry ${id} not found`);
    }
    if (principal.projectId && entry.scope.projectId !== principal.projectId) {
      throw notFound(`Memory entry ${id} not found`);
    }
    await context.store.memory.delete(id);
    return { deleted: true, id };
  });

  app.post('/api/memory/prune', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'operator', 'prune memory');
    const removed = await context.store.memory.prune(context.now());
    return { removed, prunedAt: context.now() };
  });
}

function split(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function summarize(items: MemoryEntry[]): {
  byType: Record<string, number>;
  expired: number;
  averageImportance: number;
} {
  const byType: Record<string, number> = {};
  let expired = 0;
  let importance = 0;
  const now = Date.now();
  for (const entry of items) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) expired += 1;
    importance += entry.importance;
  }
  return {
    byType,
    expired,
    averageImportance: items.length === 0 ? 0 : Number((importance / items.length).toFixed(3)),
  };
}

export type { ApiContext };
