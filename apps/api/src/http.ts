import type { FastifyRequest } from 'fastify';
import type { AgentRun, Principal } from '@kazi-ai/agentos-core';
import type { DispatchAction } from './dispatcher.js';
import { conflict, forbidden, notFound } from './errors.js';
import type { ApiContext } from './types.js';

/** A path parameter that must exist; Fastify routing already guarantees it. */
export function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  if (!value) throw notFound(`Missing ${name}`);
  return value;
}

export interface RequestedScope {
  organizationId?: string;
  projectId?: string;
}

/**
 * The tenant a request acts on. A principal may only ever act inside its own
 * organization (spec §65); an explicit organization on the request has to
 * match, and only an admin may name a different project of the same tenant.
 */
export async function scopeFor(
  context: ApiContext,
  request: FastifyRequest,
  requested: RequestedScope = {},
): Promise<{ organizationId: string; projectId: string; principal: Principal }> {
  const principal = await context.principal(request);
  const organizationId = requested.organizationId ?? principal.organizationId;
  if (requested.organizationId && requested.organizationId !== principal.organizationId) {
    throw forbidden('A principal may only act inside its own organization', {
      organizationId: requested.organizationId,
    });
  }
  const projectId = requested.projectId ?? principal.projectId ?? context.projectId;
  return { organizationId, projectId, principal };
}

/** Load a run, hiding the existence of other tenants' runs behind a 404. */
export async function loadRun(
  context: ApiContext,
  request: FastifyRequest,
  runId: string,
): Promise<{ run: AgentRun; principal: Principal }> {
  const principal = await context.principal(request);
  const run = await context.store.runs.get(runId);
  if (!run || run.organizationId !== principal.organizationId) {
    throw notFound(`Run ${runId} not found`);
  }
  return { run, principal };
}

/** Decide whether a principal may read a project's data. */
export function assertProjectAccess(principal: Principal, projectId: string): void {
  if (principal.projectId && principal.projectId !== projectId) {
    throw forbidden('This principal is scoped to another project', { projectId });
  }
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * Reject a lifecycle command the run cannot accept, at the edge. The runtime
 * re-checks and remains the authority; this exists so the HTTP contract is
 * deterministic instead of depending on how the executor is wired.
 */
export function assertActionable(run: AgentRun, action: DispatchAction): void {
  if (action === 'retry') {
    if (!['FAILED', 'TIMED_OUT', 'PAUSED'].includes(run.status)) {
      throw conflict(`Run ${run.id} cannot be retried from ${run.status}`, { status: run.status });
    }
    return;
  }
  if (TERMINAL_STATUSES.has(run.status)) {
    throw conflict(`Run ${run.id} already finished with status ${run.status}`, {
      status: run.status,
    });
  }
  if (action === 'start' && run.status === 'PAUSED') {
    throw conflict(`Run ${run.id} is paused; resume it instead`, { status: run.status });
  }
}

/** Hand a run to whatever executes it: inline, or a queue the worker drains. */
export async function dispatchRun(
  context: ApiContext,
  run: AgentRun,
  action: DispatchAction,
): Promise<void> {
  assertActionable(run, action);
  await context.dispatcher.dispatch({
    runId: run.id,
    organizationId: run.organizationId,
    projectId: run.projectId,
    action,
  });
}
