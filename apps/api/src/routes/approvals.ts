import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JsonValue } from '@kazi-ai/agentos-core';
import { parse, approvalDecisionSchema } from '../schemas.js';
import { dispatchRun, param } from '../http.js';
import { badRequest, notFound } from '../errors.js';
import type { ApiContext } from '../types.js';

const listApprovalsSchema = z.object({
  runId: z.string().optional(),
  status: z.enum(['pending', 'granted', 'denied', 'modified', 'expired', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * Human approval gates (spec §23, §54). The decision is persisted before the
 * run is told about it, and the run is only resumed after that write.
 */
export function registerApprovalRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/approvals', async (request) => {
    const principal = await context.principal(request);
    const query = parse(listApprovalsSchema, request.query, 'query');
    const items = await context.store.approvals.list({
      organizationId: principal.organizationId,
      ...(query.runId ? { runId: query.runId } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    return { items: items.filter((approval) => approval.organizationId === principal.organizationId).slice(0, query.limit ?? 100) };
  });

  app.get('/api/approvals/:id', async (request) => {
    const principal = await context.principal(request);
    const approval = await context.store.approvals.get(param(request, 'id'));
    if (!approval || approval.organizationId !== principal.organizationId) {
      throw notFound(`Approval ${param(request, 'id')} not found`);
    }
    return { approval };
  });

  app.post('/api/approvals/:id/approve', async (request) => {
    return decide(context, request, 'approve');
  });

  app.post('/api/approvals/:id/deny', async (request) => {
    return decide(context, request, 'deny');
  });

  app.post('/api/approvals/:id/modify', async (request) => {
    return decide(context, request, 'modify');
  });
}

async function decide(
  context: ApiContext,
  request: FastifyRequest,
  decision: 'approve' | 'deny' | 'modify',
): Promise<{ approval: unknown; runId: string }> {
  const principal = await context.principal(request);
  const approvalId = param(request, 'id');
  const existing = await context.store.approvals.get(approvalId);
  if (!existing || existing.organizationId !== principal.organizationId) {
    throw notFound(`Approval ${approvalId} not found`);
  }
  const body = parse(approvalDecisionSchema, request.body ?? {}, 'approval decision');
  if (decision === 'modify' && body.modifiedArguments === undefined) {
    throw badRequest('A modified approval needs modifiedArguments');
  }
  const approval = await context.os.runtime.decideApproval({
    approvalId,
    decision,
    decidedBy: body.decidedBy ?? principal.id,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
    ...(body.modifiedArguments === undefined
      ? {}
      : { modifiedArguments: body.modifiedArguments as JsonValue }),
  });
  // The run waited in WAITING; the decision unblocks exactly that action, so it
  // is dispatched again rather than restarted.
  const run = await context.store.runs.get(approval.runId);
  if (run) await dispatchRun(context, run, 'start');
  return { approval, runId: approval.runId };
}
