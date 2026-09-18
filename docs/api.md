# API

Fastify, JSON, one error shape, and an OpenAPI document generated from the routes
that are actually registered — an undocumented route is the exception the
server notices, not the one a user finds (spec §63).

```bash
pnpm --filter @kazi-ai/agentos-api dev      # or: KZ_API_PORT=4319 node apps/api/dist/bin.js
curl localhost:4319/health
curl localhost:4319/openapi.json
```

## Runs

```text
GET    /api/runs                     list, filtered by status/agent
POST   /api/runs                     create a run
GET    /api/runs/:id                 the run
GET    /api/runs/:id/result          the measured AgentRunResult
GET    /api/runs/:id/state           durable state: plan, usage, context
GET    /api/runs/:id/trace           the span tree
GET    /api/runs/:id/events          the event log
GET    /api/runs/:id/steps           plan steps and their status
GET    /api/runs/:id/journal         the action journal
GET    /api/runs/:id/decisions       policy decisions
GET    /api/runs/:id/failures        classified failures
GET    /api/runs/:id/recoveries      recovery attempts and outcomes
GET    /api/runs/:id/checkpoints     checkpoints
GET    /api/runs/:id/artifacts       artifacts produced by the run
POST   /api/runs/:id/start           start (or dispatch) a run
POST   /api/runs/:id/pause           pause
POST   /api/runs/:id/resume          resume
POST   /api/runs/:id/retry           retry a failed run
POST   /api/runs/:id/cancel          cancel
POST   /api/runs/:id/checkpoint      checkpoint now
POST   /api/runs/:id/fork            fork at a checkpoint into a new run
POST   /api/runs/:id/replay          replay the recorded actions
```

## Approvals

```text
GET  /api/approvals                  pending approvals
GET  /api/approvals/:id
POST /api/approvals/:id/approve
POST /api/approvals/:id/deny
POST /api/approvals/:id/modify
```

A decision is persisted with the decider and their reason, and matched to the
action by fingerprint.

## Catalog and operational

```text
GET  /api/agents      GET /api/tools      GET /api/providers
GET  /api/policies    GET /api/mcp        GET /api/info
GET  /api/memory      DELETE /api/memory/:id      POST /api/memory/prune
GET  /api/whoami      GET /api/identity
GET  /api/keys        POST /api/keys      DELETE /api/keys/:id
GET  /api/webhooks    POST /api/webhooks  DELETE /api/webhooks/:id
GET  /api/webhooks/:id/deliveries         POST /api/webhooks/:id/test
```

## Streaming

```text
GET /api/runs/:id/events/stream      Server-Sent Events
```

Every event the run emits, as it is emitted, so a console can follow a run
without polling (spec §97). The stream is a *view*: it re-reads durable events,
so a dropped connection loses nothing.

## Health and readiness

```text
GET /health      process is up, with version and uptime
GET /ready       the store answers, providers are registered, config is valid
GET /version     build identity
```

`/ready` is what the container orchestrator probes; `/health` is what a load
balancer probes.

## Errors

One shape everywhere:

```json
{
  "error": {
    "code": "RESOURCE_EXHAUSTED",
    "message": "Run exceeded its step limit of 40",
    "detail": { "dimension": "steps", "limit": 40 }
  }
}
```

The HTTP status carries the class of failure; the `code` carries the
`AgentError` code, so a client can distinguish `POLICY_DENIED` from `NOT_FOUND`
without parsing prose.

## Authentication and tenancy

API keys with roles (`admin`, `operator`, `developer`, `viewer`). The tenant
comes from the principal, never from the request body; cross-tenant reads are
`404`. Without configured keys the server runs as a single local operator, which
is intended for a laptop and never for an exposed port.
