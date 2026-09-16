import { createHash, randomBytes } from 'node:crypto';
import {
  NotFoundError,
  ValidationError,
  hashObject,
  type AgentAction,
  type AgentRun,
  type AgentRunResult,
  type AgentState,
  type AgentTool,
  type ArtifactRef,
  type JsonObject,
  type JsonValue,
  type RunConfigSnapshot,
  type ToolCallRequest,
  type ToolContext,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import { decodeToolName } from '@kazi-ai/agentos-providers';

/** Tools whose repetition is harmless even when the first call half-succeeded. */
const IDEMPOTENT_TOOLS = new Set([
  'filesystem.read',
  'filesystem.list',
  'filesystem.search',
  'git',
  'database.query',
]);
const RETRY_SAFE_TOOLS = new Set(['http.request', 'filesystem.write', 'filesystem.edit', 'filesystem.move']);
const NON_IDEMPOTENT_TOOLS = new Set(['filesystem.delete', 'terminal.exec']);
const MUTATING_GIT_OPERATIONS = new Set(['push', 'commit', 'add', 'checkout', 'reset']);

/**
 * Classify how safe it is to repeat a tool call. The runtime refuses to retry
 * non-idempotent work without evidence that it never landed (spec §32).
 */
export function idempotencyFor(
  tool: Pick<AgentTool, 'id'> & { defaultIdempotency?: AgentAction['idempotency'] },
  args: JsonValue,
): AgentAction['idempotency'] {
  // A tool that knows how its own operations behave wins over the built-in
  // table: guessing wrong here means either replaying a side effect or refusing
  // to recover work that was always safe to repeat.
  if (tool.defaultIdempotency) return tool.defaultIdempotency;
  if (IDEMPOTENT_TOOLS.has(tool.id)) {
    if (tool.id === 'git' && isMutatingGit(args)) return 'non-idempotent';
    if (tool.id === 'database.query' && isMutatingDatabase(args)) return 'non-idempotent';
    return 'idempotent';
  }
  if (NON_IDEMPOTENT_TOOLS.has(tool.id)) return 'non-idempotent';
  if (RETRY_SAFE_TOOLS.has(tool.id)) return 'retry-safe';
  if (tool.id.startsWith('mcp.')) return 'unknown';
  return 'unknown';
}

function isMutatingGit(args: JsonValue): boolean {
  const operation = operationOf(args);
  return operation !== undefined && MUTATING_GIT_OPERATIONS.has(operation);
}

function isMutatingDatabase(args: JsonValue): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const sql = (args as Record<string, unknown>)['sql'];
  if (typeof sql !== 'string') return false;
  return !/^\s*(select|with|show|explain|table|values)\b/i.test(sql);
}

function operationOf(args: JsonValue): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)['operation'];
  return typeof value === 'string' ? value : undefined;
}

export interface ActionFromToolCallInput {
  run: AgentRun;
  toolCall: ToolCallRequest;
  tool: Pick<AgentTool, 'id'>;
  stepId?: string;
  stepIndex: number;
  attempt: number;
  /** Arguments substituted by an approver, if any. */
  argumentsOverride?: JsonValue;
}

/** Turn a model tool call into a journaled, idempotent runtime action. */
export function actionFromToolCall(input: ActionFromToolCallInput): AgentAction {
  const toolId = decodeToolName(input.toolCall.name);
  const args = input.argumentsOverride ?? input.toolCall.arguments ?? null;
  const idempotency = idempotencyFor(input.tool, args);
  const action: AgentAction = {
    id: `act_${hashObject({ runId: input.run.id, step: input.stepIndex, toolId, args, attempt: input.attempt }).slice(0, 26)}` as AgentAction['id'],
    runId: input.run.id,
    toolId,
    arguments: args,
    idempotencyKey: idempotencyKeyFor(input.run.id, input.stepIndex, toolId, args, input.attempt),
    idempotency,
    status: 'pending',
    createdAt: Date.now(),
    attempt: input.attempt,
    metadata: { toolCallId: input.toolCall.id },
  };
  if (input.stepId) action.stepId = input.stepId as AgentAction['stepId'];
  return action;
}

/**
 * Deterministic key for "the same action". Derived from the run, the step, the
 * tool and the arguments, so a replayed action resolves to the same journal
 * record even after a crash.
 */
export function idempotencyKeyFor(
  runId: string,
  stepIndex: number,
  toolId: string,
  args: JsonValue,
  attempt: number,
): string {
  return `idem_${hashObject({ runId, step: stepIndex, toolId, arguments: args, attempt }).slice(0, 40)}`;
}

export function actionHashOf(action: AgentAction): string {
  return hashObject({ toolId: action.toolId, arguments: action.arguments });
}

export interface ToolContextFactoryOptions {
  store: { artifacts: { save(record: ArtifactRecordLike): Promise<void> } };
  artifactDir: string;
  logger: ToolContext['logger'];
  clock: ToolContext['clock'];
  secrets: ToolContext['secrets'];
}

export interface ArtifactRecordLike {
  id: string;
  runId: string;
  organizationId: string;
  projectId: string;
  name: string;
  path: string;
  sha256: string;
  size: number;
  mimeType: string;
  createdAt: number;
}

/**
 * Build the tool execution context for a run. Every tool receives the run's
 * resolved permissions, not the agent's requested ones.
 */
export function createToolContext(input: {
  run: AgentRun;
  permissions: ToolPermissions;
  workspaceDir: string;
  environment: ToolContext['environment'];
  logger: ToolContext['logger'];
  clock: ToolContext['clock'];
  secrets: ToolContext['secrets'];
  artifacts: ToolContext['artifacts'];
  signal: AbortSignal;
  step?: { id: string; index: number };
}): ToolContext {
  return {
    runId: input.run.id,
    organizationId: input.run.organizationId,
    projectId: input.run.projectId,
    workspaceDir: input.workspaceDir,
    permissions: input.permissions,
    logger: input.logger,
    clock: input.clock,
    signal: input.signal,
    secrets: input.secrets,
    environment: input.environment,
    artifacts: input.artifacts,
    ...(input.step ? { step: input.step } : {}),
  };
}

export interface RunResultInput {
  run: AgentRun;
  state: AgentState;
  policyViolations: number;
  artifacts: ArtifactRef[];
  verification?: { passed: boolean; summary: string };
  now?: number;
}

/** The standardized result KaziAI Bench and the evaluation layer consume. */
export function toAgentRunResult(input: RunResultInput): AgentRunResult {
  const { run } = input;
  const now = input.now ?? Date.now();
  const durationMs = (run.finishedAt ?? now) - run.createdAt;
  return {
    runId: run.id,
    status: run.status,
    success: run.status === 'COMPLETED',
    durationMs,
    steps: run.usage.steps,
    toolCalls: run.usage.toolCalls,
    tokenUsage: run.usage.tokens,
    costUsd: run.usage.costUsd,
    recoveryCount: run.usage.recoveryCount,
    policyViolations: input.policyViolations,
    artifacts: input.artifacts,
    traceId: run.traceId,
    ...(input.verification ? { verification: input.verification } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.labels ? { labels: run.labels } : {}),
  };
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} is required and must be a non-empty string`, { field });
  }
  return value;
}

export function requireRun(run: AgentRun | undefined, runId: string): AgentRun {
  if (!run) throw new NotFoundError('run', runId);
  return run;
}

export function emptyState(run: AgentRun): AgentState {
  return {
    runId: run.id,
    status: run.status,
    stateVersion: run.stateVersion,
    ...(run.plan ? { plan: run.plan } : {}),
    ...(run.currentStepId ? { currentStepId: run.currentStepId } : {}),
    usage: run.usage,
    context: {},
    observations: [],
    updatedAt: Date.now(),
  };
}

/** A stable id for a file an agent produced, independent of its extension. */
export function artifactIdFor(name: string, contents: Buffer): string {
  return `art_${hashObject({ name, sha256: createHash('sha256').update(contents).digest('hex') }).slice(0, 26)}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}

export function workspaceMetadata(config: RunConfigSnapshot): JsonObject {
  return { tools: config.tools, model: config.model, provider: config.provider };
}
