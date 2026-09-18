import type { FastifyInstance } from 'fastify';
import type { AgentRun, JsonObject, RunLimits, ToolPermissions } from '@kazi-ai/agentos-core';
import { parse, createRunSchema, forkRunSchema, listEventsSchema, listRunsSchema, replayRunSchema } from '../schemas.js';
import { assertActionable, assertProjectAccess, dispatchRun, loadRun, param, scopeFor } from '../http.js';
import { notFound } from '../errors.js';
import type { ApiContext } from '../types.js';

/**
 * Run lifecycle routes (spec §63). Every handler reloads the run from durable
 * storage, so a client can reconnect at any point and see the truth.
 */
export function registerRunRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/runs', async (request) => {
    const principal = await context.principal(request);
    const query = parse(listRunsSchema, request.query, 'query');
    const projectId = principal.projectId ?? context.projectId;
    assertProjectAccess(principal, projectId);
    const page = await context.store.runs.list({
      organizationId: principal.organizationId,
      projectId,
      ...(query.status ? { status: query.status.split(',').map((value) => value.trim()) } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.parentRunId ? { parentRunId: query.parentRunId } : {}),
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      orderBy: query.orderBy ?? 'createdAt',
      direction: query.direction ?? 'desc',
    });
    return page;
  });

  app.post('/api/runs', async (request, reply) => {
    const body = parse(createRunSchema, request.body, 'run');
    const scope = await scopeFor(context, request, body);
    const definition = await context.catalog.resolve(scope, body.agentId);
    if (!definition) {
      throw notFound(`Agent ${body.agentId} is not defined for ${scope.organizationId}`);
    }
    const agent = context.os.agent({
      ...definition,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
    });
    const run = await agent.createRun({
      goal: body.goal,
      ...(body.limits ? { limits: body.limits as RunLimits } : {}),
      ...(body.permissions ? { permissions: body.permissions as ToolPermissions } : {}),
      ...(body.labels ? { labels: body.labels } : {}),
      ...(body.metadata ? { metadata: body.metadata as JsonObject } : {}),
      ...(body.parentRunId ? { parentRunId: body.parentRunId } : {}),
    });
    if (body.start !== false) await dispatchRun(context, run, 'start');
    reply.code(201);
    return { run: await reload(context, run.id) };
  });

  app.get('/api/runs/:id', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { run };
  });

  app.get('/api/runs/:id/state', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { state: await context.os.runtime.getState(run.id) };
  });

  app.get('/api/runs/:id/result', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { result: await context.os.runtime.result(run.id) };
  });

  app.get('/api/runs/:id/trace', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { trace: await context.os.runtime.getTrace(run.id) };
  });

  app.get('/api/runs/:id/events', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    const query = parse(listEventsSchema, request.query, 'query');
    const limit = query.limit ?? 200;
    const events = await context.store.events.list(run.id, {
      ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence }),
      limit: limit + 1,
    });
    const hasMore = events.length > limit;
    return {
      items: hasMore ? events.slice(0, limit) : events,
      total: events.length,
      hasMore,
    };
  });

  app.get('/api/runs/:id/steps', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.steps.list(run.id) };
  });

  app.get('/api/runs/:id/checkpoints', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.checkpoints.list(run.id) };
  });

  app.get('/api/runs/:id/artifacts', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.artifacts.list(run.id) };
  });

  app.get('/api/runs/:id/failures', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.failures.list(run.id) };
  });

  app.get('/api/runs/:id/recoveries', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.recoveries.list(run.id) };
  });

  app.get('/api/runs/:id/journal', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.actions.list(run.id) };
  });

  app.get('/api/runs/:id/decisions', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    return { items: await context.store.policyDecisions.list(run.id) };
  });

  app.post('/api/runs/:id/start', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    assertActionable(run, 'start');
    await dispatchRun(context, run, 'start');
    return { run: await reload(context, run.id) };
  });

  app.post('/api/runs/:id/resume', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    assertActionable(run, 'resume');
    await dispatchRun(context, run, 'resume');
    return { run: await reload(context, run.id) };
  });

  app.post('/api/runs/:id/retry', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    assertActionable(run, 'retry');
    await dispatchRun(context, run, 'retry');
    return { run: await reload(context, run.id) };
  });

  app.post('/api/runs/:id/pause', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    await context.os.runtime.pause(run.id);
    return { run: await reload(context, run.id) };
  });

  app.post('/api/runs/:id/cancel', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    await context.os.runtime.cancel(run.id);
    return { run: await reload(context, run.id) };
  });

  app.post('/api/runs/:id/checkpoint', async (request, reply) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    const checkpoint = await context.os.runtime.checkpoint(run.id);
    reply.code(201);
    return { checkpoint, run: await reload(context, run.id) };
  });

  app.post('/api/runs/:id/fork', async (request, reply) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    const body = parse(forkRunSchema, request.body ?? {}, 'fork');
    const forked = await context.os.runtime.fork(run.id, {
      ...(body.checkpointId ? { checkpointId: body.checkpointId } : {}),
      ...(body.goal ? { goal: body.goal } : {}),
      ...(body.labels ? { labels: body.labels } : {}),
    });
    reply.code(201);
    return { run: forked, parentRunId: run.id };
  });

  app.post('/api/runs/:id/replay', async (request) => {
    const { run } = await loadRun(context, request, param(request, 'id'));
    const body = parse(replayRunSchema, request.body ?? {}, 'replay');
    const report = await context.os.runtime.replay(run.id, {
      ...(body.mode ? { mode: body.mode } : {}),
    });
    return { report };
  });
}

async function reload(context: ApiContext, runId: string): Promise<AgentRun> {
  return context.os.runtime.getRun(runId);
}
