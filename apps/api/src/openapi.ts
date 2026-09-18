import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  approvalDecisionSchema,
  createRunSchema,
  searchMemorySchema,
  forkRunSchema,
  listEventsSchema,
  listRunsSchema,
  permissionsSchema,
  replayRunSchema,
  runLimitsSchema,
} from './schemas.js';

/**
 * The HTTP surface, described once and checked against what the app actually
 * serves (spec §63). `openapi.test.ts` fails if a registered route is missing
 * here, so the document cannot quietly rot.
 */

export interface DocumentedRoute {
  method: 'get' | 'post' | 'delete';
  path: string;
  summary: string;
  tag: string;
  /** Minimum role; `none` means the probe endpoints. */
  role: 'none' | 'viewer' | 'developer' | 'operator' | 'admin';
  /** Where the parameters live. */
  query?: z.ZodType;
  body?: z.ZodType;
  responses?: Record<string, string>;
}

const errorRef = { $ref: '#/components/schemas/Error' } as const;

export const DOCUMENTED_ROUTES: DocumentedRoute[] = [
  {
    method: 'get',
    path: '/health',
    summary: 'Liveness probe',
    tag: 'System',
    role: 'none',
  },
  {
    method: 'get',
    path: '/ready',
    summary: 'Readiness probe, including the durable store',
    tag: 'System',
    role: 'none',
  },
  {
    method: 'get',
    path: '/version',
    summary: 'Build information',
    tag: 'System',
    role: 'none',
  },
  {
    method: 'get',
    path: '/api/whoami',
    summary: 'The authenticated principal',
    tag: 'Identity',
    role: 'viewer',
  },
  {
    method: 'get',
    path: '/api/identity',
    summary: 'The organization and project this caller belongs to',
    tag: 'Identity',
    role: 'viewer',
  },
  { method: 'get', path: '/api/keys', summary: 'List API keys', tag: 'Identity', role: 'admin' },
  { method: 'post', path: '/api/keys', summary: 'Create an API key', tag: 'Identity', role: 'admin' },
  { method: 'delete', path: '/api/keys/{id}', summary: 'Revoke an API key', tag: 'Identity', role: 'admin' },
  {
    method: 'get',
    path: '/api/memory',
    summary: 'Search the memory an agent kept, with provenance and TTL',
    tag: 'Memory',
    role: 'viewer',
    query: searchMemorySchema,
  },
  {
    method: 'delete',
    path: '/api/memory/{id}',
    summary: 'Forget one memory entry',
    tag: 'Memory',
    role: 'operator',
  },
  {
    method: 'post',
    path: '/api/memory/prune',
    summary: 'Remove every expired memory entry',
    tag: 'Memory',
    role: 'operator',
  },
  {
    method: 'get',
    path: '/api/runs',
    summary: 'List runs',
    tag: 'Runs',
    role: 'viewer',
    query: listRunsSchema,
  },
  {
    method: 'post',
    path: '/api/runs',
    summary: 'Create a run, and start it unless start is false',
    tag: 'Runs',
    role: 'developer',
    body: createRunSchema,
    responses: { '201': 'The created run' },
  },
  { method: 'get', path: '/api/runs/{id}', summary: 'Get a run', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/state', summary: 'Current agent state', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/result', summary: 'Measured run result', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/trace', summary: 'Execution trace', tag: 'Runs', role: 'viewer' },
  {
    method: 'get',
    path: '/api/runs/{id}/events',
    summary: 'Durable events, in sequence order',
    tag: 'Runs',
    role: 'viewer',
    query: listEventsSchema,
  },
  {
    method: 'get',
    path: '/api/runs/{id}/events/stream',
    summary: 'Follow events over server-sent events',
    tag: 'Runs',
    role: 'viewer',
  },
  { method: 'get', path: '/api/runs/{id}/steps', summary: 'Run steps', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/checkpoints', summary: 'Checkpoints', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/artifacts', summary: 'Artifacts', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/failures', summary: 'Classified failures', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/recoveries', summary: 'Recovery attempts', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/journal', summary: 'Append-only action journal', tag: 'Runs', role: 'viewer' },
  { method: 'get', path: '/api/runs/{id}/decisions', summary: 'Policy decisions', tag: 'Runs', role: 'viewer' },
  { method: 'post', path: '/api/runs/{id}/start', summary: 'Start a run', tag: 'Runs', role: 'developer' },
  { method: 'post', path: '/api/runs/{id}/resume', summary: 'Resume a paused run', tag: 'Runs', role: 'developer' },
  { method: 'post', path: '/api/runs/{id}/retry', summary: 'Retry a failed or paused run', tag: 'Runs', role: 'developer' },
  { method: 'post', path: '/api/runs/{id}/pause', summary: 'Pause a running run', tag: 'Runs', role: 'developer' },
  { method: 'post', path: '/api/runs/{id}/cancel', summary: 'Cancel a run', tag: 'Runs', role: 'developer' },
  {
    method: 'post',
    path: '/api/runs/{id}/checkpoint',
    summary: 'Checkpoint a run now',
    tag: 'Runs',
    role: 'developer',
    responses: { '201': 'The created checkpoint' },
  },
  {
    method: 'post',
    path: '/api/runs/{id}/fork',
    summary: 'Fork a run from a checkpoint; the original is untouched',
    tag: 'Runs',
    role: 'developer',
    body: forkRunSchema,
    responses: { '201': 'The forked run' },
  },
  {
    method: 'post',
    path: '/api/runs/{id}/replay',
    summary: 'Replay a run from its journal',
    tag: 'Runs',
    role: 'developer',
    body: replayRunSchema,
  },
  { method: 'get', path: '/api/approvals', summary: 'List approvals', tag: 'Approvals', role: 'viewer' },
  { method: 'get', path: '/api/approvals/{id}', summary: 'Get an approval', tag: 'Approvals', role: 'viewer' },
  {
    method: 'post',
    path: '/api/approvals/{id}/approve',
    summary: 'Approve the action a run is waiting on',
    tag: 'Approvals',
    role: 'operator',
    body: approvalDecisionSchema,
  },
  {
    method: 'post',
    path: '/api/approvals/{id}/deny',
    summary: 'Deny the action a run is waiting on',
    tag: 'Approvals',
    role: 'operator',
    body: approvalDecisionSchema,
  },
  {
    method: 'post',
    path: '/api/approvals/{id}/modify',
    summary: 'Approve with substituted arguments',
    tag: 'Approvals',
    role: 'operator',
    body: approvalDecisionSchema,
  },
  { method: 'get', path: '/api/agents', summary: 'Agent definitions available to this tenant', tag: 'Catalog', role: 'viewer' },
  { method: 'get', path: '/api/tools', summary: 'Registered tools', tag: 'Catalog', role: 'viewer' },
  { method: 'get', path: '/api/providers', summary: 'Configured model providers', tag: 'Catalog', role: 'viewer' },
  { method: 'get', path: '/api/policies', summary: 'Policy and risk rules in force', tag: 'Catalog', role: 'viewer' },
  { method: 'get', path: '/api/mcp', summary: 'MCP server status and discovered tools', tag: 'Catalog', role: 'viewer' },
  { method: 'get', path: '/api/info', summary: 'How this deployment is configured', tag: 'Catalog', role: 'viewer' },
  { method: 'get', path: '/api/webhooks', summary: 'List webhook subscriptions', tag: 'Webhooks', role: 'admin' },
  {
    method: 'post',
    path: '/api/webhooks',
    summary: 'Subscribe an endpoint; the signing secret is returned once',
    tag: 'Webhooks',
    role: 'admin',
    responses: { '201': 'The subscription and its secret' },
  },
  { method: 'delete', path: '/api/webhooks/{id}', summary: 'Disable a subscription', tag: 'Webhooks', role: 'admin' },
  { method: 'get', path: '/api/webhooks/{id}/deliveries', summary: 'Delivery log', tag: 'Webhooks', role: 'viewer' },
  { method: 'post', path: '/api/webhooks/{id}/test', summary: 'Send a signed test delivery', tag: 'Webhooks', role: 'operator' },
  { method: 'get', path: '/openapi.json', summary: 'This document', tag: 'System', role: 'none' },
  { method: 'get', path: '/api/routes', summary: 'Routes this deployment serves', tag: 'System', role: 'viewer' },
  { method: 'get', path: '/docs', summary: 'Human-readable API index', tag: 'System', role: 'none' },
];

const ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const;

/** Build the OpenAPI 3.1 document from the route table and the Zod schemas. */
export function openApiDocument(input: { version: string; url: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of DOCUMENTED_ROUTES) {
    const parameters: unknown[] = route.path.includes('{id}') ? [ID_PARAM] : [];
    if (route.query) {
      parameters.push({
        name: 'query',
        in: 'query',
        required: false,
        content: { 'application/json': { schema: z.toJSONSchema(route.query, { io: 'input' }) } },
      });
    }
    const operation: Record<string, unknown> = {
      summary: route.summary,
      tags: [route.tag],
      parameters,
      responses: {
        '200': { description: 'Success' },
        '400': { description: 'Invalid request', content: { 'application/json': { schema: errorRef } } },
        '401': { description: 'Missing or invalid API key', content: { 'application/json': { schema: errorRef } } },
        '403': { description: 'The key\'s role does not allow this', content: { 'application/json': { schema: errorRef } } },
        '404': { description: 'Not found', content: { 'application/json': { schema: errorRef } } },
        ...Object.fromEntries(
          Object.entries(route.responses ?? {}).map(([status, description]) => [status, { description }]),
        ),
      },
      'x-kazi-minimum-role': route.role,
    };
    if (route.body) {
      operation['requestBody'] = {
        required: true,
        content: { 'application/json': { schema: z.toJSONSchema(route.body, { io: 'input' }) } },
      };
    }
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'KaziAI AgentOS API',
      version: input.version,
      description:
        'Control plane for durable agent execution: create runs, watch them, approve risky actions, ' +
        'checkpoint, fork, replay and measure.',
      license: { name: 'Apache-2.0' },
    },
    servers: [{ url: input.url }],
    tags: [
      { name: 'Runs' },
      { name: 'Approvals' },
      { name: 'Catalog' },
      { name: 'Identity' },
      { name: 'Memory' },
      { name: 'Webhooks' },
      { name: 'System' },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'An AgentOS API key: Authorization: Bearer kz_live_<prefix>.<secret>',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                detail: {},
              },
            },
          },
        },
        RunLimits: z.toJSONSchema(runLimitsSchema, { io: 'input' }),
        ToolPermissions: z.toJSONSchema(permissionsSchema, { io: 'input' }),
      },
    },
    security: [{ apiKey: [] }],
    paths,
  };
}

/** The document plus a small dependency-free index page. */
export function registerDocsRoutes(app: FastifyInstance, version = '0.1.0'): void {
  const context = app.api;

  app.get('/openapi.json', async (request) => {
    const host = request.headers.host ?? 'localhost';
    return openApiDocument({ version, url: `http://${host}` });
  });

  app.get('/docs', async (_request, reply) => {
    const document = openApiDocument({ version, url: '/' });
    const rows = DOCUMENTED_ROUTES.map(
      (route) =>
        `<tr><td><code>${route.method.toUpperCase()}</code></td><td><code>${route.path}</code></td>` +
        `<td>${route.summary}</td><td>${route.role}</td></tr>`,
    ).join('\n');
    void document;
    reply.type('text/html; charset=utf-8');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>KaziAI AgentOS API</title>
<style>body{font-family:ui-sans-serif,system-ui;margin:2rem;max-width:60rem}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem .6rem;text-align:left}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.2rem}</style></head>
<body><h1>KaziAI AgentOS API</h1>
<p>OpenAPI 3.1 document: <a href="/openapi.json">/openapi.json</a></p>
<table><thead><tr><th>Method</th><th>Path</th><th>Summary</th><th>Minimum role</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
  });

  app.get('/api/routes', async () => ({ items: [...context.routes] }));
}
