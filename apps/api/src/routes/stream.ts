import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTerminalState, type AgentEvent } from '@kazi-ai/agentos-core';
import { loadRun, param } from '../http.js';
import { parse } from '../schemas.js';

const streamSchema = z.object({
  /** Replay events after this sequence before following live ones. */
  afterSequence: z.coerce.number().int().min(0).optional(),
  /** How often to look for new events. */
  intervalMs: z.coerce.number().int().min(50).max(5_000).optional(),
});

const DEFAULT_INTERVAL_MS = 250;
const HEARTBEAT_MS = 15_000;

/**
 * Follow a run as it executes (spec §97).
 *
 * Events are durable, so this is a subscription to the store rather than to a
 * process's memory: a dashboard that reconnects with `Last-Event-ID` sees
 * everything it missed, and a worker restart is invisible to the client.
 */
export function registerStreamRoutes(app: FastifyInstance): void {
  const context = app.api;

  app.get('/api/runs/:id/events/stream', async (request, reply) => {
    const runId = param(request, 'id');
    // Authorize before taking over the socket: a hijacked response can no
    // longer be turned into a normal error response.
    await loadRun(context, request, runId, 'viewer');
    const query = parse(streamSchema, request.query, 'query');
    const lastEventId = request.headers['last-event-id'];
    const cursor =
      lastEventId !== undefined && lastEventId !== ''
        ? Number(lastEventId)
        : (query.afterSequence ?? 0);
    const intervalMs = query.intervalMs ?? DEFAULT_INTERVAL_MS;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let sequence = Number.isFinite(cursor) ? cursor : 0;
    let closed = false;
    let lastWrite = Date.now();
    request.raw.on('close', () => {
      closed = true;
    });

    const send = (event: AgentEvent): void => {
      reply.raw.write(`id: ${event.sequence}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      lastWrite = Date.now();
    };

    try {
      while (!closed) {
        const events = await context.store.events.list(runId, {
          afterSequence: sequence,
          limit: 500,
        });
        for (const event of events) {
          if (closed) break;
          send(event);
          sequence = event.sequence;
        }
        if (closed) break;

        const run = await context.store.runs.get(runId);
        if (events.length === 0 && (!run || isTerminalState(run.status))) {
          // The stream ends where the run does; a client that reconnects gets
          // the final state from the REST surface.
          reply.raw.write(`event: stream.end\n`);
          reply.raw.write(`data: ${JSON.stringify({ runId, status: run?.status ?? 'UNKNOWN', sequence })}\n\n`);
          break;
        }
        if (Date.now() - lastWrite >= HEARTBEAT_MS) {
          reply.raw.write(': keep-alive\n\n');
          lastWrite = Date.now();
        }
        await sleep(intervalMs);
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
    return reply;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
