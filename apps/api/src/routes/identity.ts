import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiKey } from '@kazi-ai/agentos-core';
import { parse } from '../schemas.js';
import { param, requireRole } from '../http.js';
import { notFound } from '../errors.js';
import type { ApiContext } from '../types.js';

const createKeySchema = z.object({
  name: z.string().min(1),
  role: z.enum(['admin', 'operator', 'developer', 'viewer']),
  projectId: z.string().min(1).optional(),
  /** Epoch milliseconds. */
  expiresAt: z.number().int().positive().optional(),
});

const listKeysSchema = z.object({
  includeRevoked: z.coerce.boolean().optional(),
});

/** Tenants, callers and API keys (spec §64, §65). */
export function registerIdentityRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/whoami', async (request) => {
    const principal = await context.principal(request);
    return {
      principal,
      organizationId: principal.organizationId,
      projectId: principal.projectId ?? context.projectId,
    };
  });

  app.get('/api/identity', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'viewer', 'read identity');
    const organization = await context.store.identity.organizations.get(principal.organizationId);
    const projectId = principal.projectId ?? context.projectId;
    const project = await context.store.identity.projects.get(projectId);
    return {
      organization: organization ?? null,
      project: project ?? null,
      principal: { id: principal.id, kind: principal.kind, role: principal.role },
    };
  });

  app.get('/api/keys', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'admin', 'list API keys');
    const query = parse(listKeysSchema, request.query, 'query');
    const keys = await context.store.identity.apiKeys.list(principal.organizationId);
    const visible = query.includeRevoked ? keys : keys.filter((key) => key.revokedAt === undefined);
    return { items: visible.map(publicKey) };
  });

  app.post('/api/keys', async (request, reply) => {
    const principal = await context.principal(request);
    requireRole(principal, 'admin', 'create API keys');
    const body = parse(createKeySchema, request.body, 'API key');
    const projectId = body.projectId ?? principal.projectId ?? context.projectId;
    const { key, record } = await context.auth.create({
      organizationId: principal.organizationId,
      ...(projectId ? { projectId } : {}),
      name: body.name,
      role: body.role,
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
    });
    reply.code(201);
    // The plaintext is returned once and never stored (spec §66).
    return { key, apiKey: publicKey(record), notice: 'Store this key now; it is not shown again.' };
  });

  app.delete('/api/keys/:id', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'admin', 'revoke API keys');
    const keyId = param(request, 'id');
    const existing = await context.store.identity.apiKeys.get(keyId);
    if (!existing || existing.organizationId !== principal.organizationId) {
      throw notFound(`API key ${keyId} not found`);
    }
    const revoked = await context.auth.revoke(keyId, principal.organizationId);
    return { apiKey: publicKey(revoked) };
  });
}

/** Never return a hash, and never return a prefix that could be replayed. */
function publicKey(key: ApiKey): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    role: key.role,
    organizationId: key.organizationId,
    ...(key.projectId ? { projectId: key.projectId } : {}),
    createdAt: key.createdAt,
    ...(key.lastUsedAt === undefined ? {} : { lastUsedAt: key.lastUsedAt }),
    ...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
    ...(key.revokedAt === undefined ? {} : { revokedAt: key.revokedAt }),
  };
}

export type { ApiContext };
