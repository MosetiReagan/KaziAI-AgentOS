import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVENT_TYPES } from '@kazi-ai/agentos-core';
import type { WebhookSubscriptionRecord } from '@kazi-ai/agentos-persistence';
import { parse } from '../schemas.js';
import { param, requireRole } from '../http.js';
import { notFound } from '../errors.js';

const createSchema = z.object({
  url: z.string().url(),
  /** Event types to deliver; omit or leave empty to receive every event. */
  events: z.array(z.string()).optional(),
  description: z.string().optional(),
  /** Bring your own secret; otherwise one is generated and returned once. */
  secret: z.string().min(16).optional(),
});

const listSchema = z.object({
  includeInactive: z.coerce.boolean().optional(),
});

/**
 * Webhook subscriptions (spec §98). Admin-only, tenant-scoped, and the signing
 * secret is returned exactly once - a subscription you cannot sign for is not
 * useful, but neither is a secret that keeps being echoed back.
 */
export function registerWebhookRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/webhooks', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'admin', 'manage webhooks');
    const query = parse(listSchema, request.query, 'query');
    const items = await context.store.webhooks.list({
      organizationId: principal.organizationId,
      ...(principal.projectId ? { projectId: principal.projectId } : {}),
      ...(query.includeInactive ? {} : { active: true }),
    });
    return { items: items.map(publicSubscription) };
  });

  app.post('/api/webhooks', async (request, reply) => {
    const principal = await context.principal(request);
    requireRole(principal, 'admin', 'manage webhooks');
    const body = parse(createSchema, request.body, 'webhook');
    const unknown = (body.events ?? []).filter(
      (event) => event !== 'webhook.test' && !(EVENT_TYPES as readonly string[]).includes(event),
    );
    if (unknown.length > 0) {
      throw notFound(`Unknown event types: ${unknown.join(', ')}`);
    }
    const secret = body.secret ?? randomBytes(24).toString('hex');
    const now = context.now();
    const subscription: WebhookSubscriptionRecord = {
      id: `wh_${randomBytes(9).toString('hex')}`,
      organizationId: principal.organizationId,
      projectId: principal.projectId ?? context.projectId,
      url: body.url,
      events: body.events ?? [],
      secret,
      active: true,
      ...(body.description === undefined ? {} : { description: body.description }),
      createdAt: now,
      updatedAt: now,
    };
    await context.store.webhooks.save(subscription);
    reply.code(201);
    return {
      subscription: publicSubscription(subscription),
      secret,
      notice: 'Store this secret now; it is used to sign deliveries and is not shown again.',
    };
  });

  app.delete('/api/webhooks/:id', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'admin', 'manage webhooks');
    const existing = await load(context, principal.organizationId, param(request, 'id'));
    await context.store.webhooks.save({ ...existing, active: false, updatedAt: context.now() });
    return { subscription: publicSubscription({ ...existing, active: false }) };
  });

  app.get('/api/webhooks/:id/deliveries', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'viewer', 'read webhook deliveries');
    const existing = await load(context, principal.organizationId, param(request, 'id'));
    return { items: await context.store.webhooks.listDeliveries(existing.id, { limit: 100 }) };
  });

  app.post('/api/webhooks/:id/test', async (request) => {
    const principal = await context.principal(request);
    requireRole(principal, 'operator', 'test webhooks');
    const existing = await load(context, principal.organizationId, param(request, 'id'));
    if (!context.webhooks) {
      throw notFound('Webhook delivery is not enabled in this deployment');
    }
    const outcome = await context.webhooks.test(existing);
    return { outcome };
  });
}

async function load(
  context: { store: { webhooks: { get(id: string): Promise<WebhookSubscriptionRecord | undefined> } } },
  organizationId: string,
  id: string,
): Promise<WebhookSubscriptionRecord> {
  const subscription = await context.store.webhooks.get(id);
  if (!subscription || subscription.organizationId !== organizationId) {
    throw notFound(`Webhook ${id} not found`);
  }
  return subscription;
}

/** Never echo the signing secret back from a read endpoint. */
function publicSubscription(subscription: WebhookSubscriptionRecord): Record<string, unknown> {
  const { secret: _secret, ...rest } = subscription;
  void _secret;
  return rest;
}
