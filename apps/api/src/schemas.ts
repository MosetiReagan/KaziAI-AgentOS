import { z } from 'zod';
import type { JsonValue } from '@kazi-ai/agentos-core';
import { badRequest } from './errors.js';

/**
 * One schema, two uses: the same Zod object validates the request and describes
 * it in the OpenAPI document (spec §63), so the two can never drift.
 */

export const runLimitsSchema = z
  .object({
    maxSteps: z.number().int().nonnegative().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    maxTokens: z.number().int().nonnegative().optional(),
    maxCostUsd: z.number().nonnegative().optional(),
    maxDurationSeconds: z.number().positive().optional(),
    maxNetworkRequests: z.number().int().nonnegative().optional(),
    maxStorageBytes: z.number().int().nonnegative().optional(),
    maxRecoveryAttempts: z.number().int().nonnegative().optional(),
    stepTimeoutMs: z.number().int().positive().optional(),
    toolTimeoutMs: z.number().int().positive().optional(),
  })
  .describe('Budgets enforced by the runtime independently of the model');

export const permissionsSchema = z
  .object({
    filesystem: z
      .object({
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        delete: z.boolean().optional(),
        roots: z.array(z.string()).optional(),
      })
      .optional(),
    terminal: z
      .object({
        execute: z.boolean().optional(),
        allowCommands: z.array(z.string()).optional(),
        denyCommands: z.array(z.string()).optional(),
      })
      .optional(),
    network: z
      .object({
        enabled: z.boolean().optional(),
        allowedHosts: z.array(z.string()).optional(),
        methods: z.array(z.string()).optional(),
      })
      .optional(),
    git: z
      .object({ read: z.boolean().optional(), commit: z.boolean().optional(), push: z.boolean().optional() })
      .optional(),
    database: z
      .object({
        read: z.boolean().optional(),
        write: z.boolean().optional(),
        connections: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .describe('Tool permissions granted to a run; anything unlisted is denied');

export const createRunSchema = z.object({
  agentId: z.string().min(1),
  goal: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  limits: runLimitsSchema.optional(),
  permissions: permissionsSchema.optional(),
  labels: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parentRunId: z.string().min(1).optional(),
  /** Start executing as soon as the run is created. Defaults to true. */
  start: z.boolean().optional(),
});

export const listRunsSchema = z.object({
  status: z.string().optional(),
  agentId: z.string().optional(),
  parentRunId: z.string().optional(),
  orderBy: z.enum(['createdAt', 'updatedAt']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listEventsSchema = z.object({
  afterSequence: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const forkRunSchema = z.object({
  checkpointId: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export const memoryTypeSchema = z.enum(['working', 'episodic', 'semantic', 'task']);

export const searchMemorySchema = z.object({
  runId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  type: memoryTypeSchema.optional(),
  text: z.string().min(1).max(500).optional(),
  tags: z.string().optional().describe('Comma-separated tags; an entry must carry all of them'),
  minImportance: z.coerce.number().min(0).max(1).optional(),
  includeExpired: z.coerce.boolean().optional(),
  orderBy: z.enum(['recent', 'importance', 'relevance']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const replayRunSchema = z.object({
  mode: z.enum(['trace', 'deterministic', 'simulate']).optional(),
});

export const approvalDecisionSchema = z.object({
  decidedBy: z.string().min(1).optional(),
  reason: z.string().optional(),
  modifiedArguments: z.unknown().optional(),
});

export type CreateRunBody = z.infer<typeof createRunSchema>;
export type ListRunsQuery = z.infer<typeof listRunsSchema>;
export type ForkRunBody = z.infer<typeof forkRunSchema>;
export type ApprovalDecisionBody = z.infer<typeof approvalDecisionSchema>;

/** Validate or fail with a 400 that names every offending field. */
export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw badRequest(
    `Invalid ${what}`,
    {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map((part) => String(part)).join('.'),
        message: issue.message,
        code: issue.code,
      })),
    } as unknown as JsonValue,
  );
}
