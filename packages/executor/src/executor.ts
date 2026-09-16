import {
  AgentError,
  ApprovalRequiredError,
  ToolInputError,
  ToolNotFoundError,
  ToolTimeoutError,
  ValidationError,
  mapConcurrent,
  restrictPermissions,
  toAgentError,
  truncateJson,
  type ActionJournal,
  type AgentAction,
  type AgentTool,
  type JsonObject,
  type JsonValue,
  type Logger,
  type Observation,
  type PolicyContext,
  type PolicyDecision,
  type PolicyEngine,
  type ToolContext,
  type ToolPermissions,
  type ToolResult,
} from '@kazi-ai/agentos-core';
import type { ApprovalManager } from '@kazi-ai/agentos-policies';
import { planWaves } from './dag.js';

export interface ExecutorToolRegistry {
  get(toolId: string): AgentTool | undefined;
}

export type ActionOutcomeStatus =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'awaiting_approval'
  | 'already_committed'
  | 'skipped';

export interface ActionOutcome {
  actionId: string;
  toolId: string;
  status: ActionOutcomeStatus;
  result?: ToolResult;
  policy?: PolicyDecision;
  observation?: Observation;
  error?: AgentError;
  approvalId?: string;
  durationMs: number;
  /** True when the journal proved the action had already been attempted. */
  replayed: boolean;
}

export interface ExecutionRequest {
  runId: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  environment: string;
  workspaceDir: string;
  trust: string;
  requestOrigin: PolicyContext['requestOrigin'];
  actions: AgentAction[];
  concurrency?: number;
  /** Abort the whole batch, e.g. when the run is cancelled. */
  signal?: AbortSignal;
  remainingBudget?: JsonObject;
  stepId?: string;
}

export interface ExecutionOutcome {
  outcomes: ActionOutcome[];
  waves: number;
  succeeded: number;
  failed: number;
  denied: number;
  awaitingApproval: number;
  replayed: number;
}

export interface ExecutionHooks {
  onPolicyDecision?(input: { action: AgentAction; decision: PolicyDecision }): Promise<void> | void;
  onInvocation?(input: { action: AgentAction; result: ToolResult; durationMs: number }): Promise<void> | void;
}

export type PermissionResolver =
  | ToolPermissions
  | ((request: ExecutionRequest, toolId: string) => ToolPermissions);

export interface ExecutorOptions {
  registry: ExecutorToolRegistry;
  journal: ActionJournal;
  policy: PolicyEngine;
  approvals?: ApprovalManager;
  permissions: PermissionResolver;
  createToolContext(request: ExecutionRequest, tool: AgentTool, signal: AbortSignal): ToolContext;
  logger?: Logger;
  hooks?: ExecutionHooks;
  /** Maximum parallel tool calls inside one wave. */
  concurrency?: number;
  /** Overrides the tool's declared timeout. */
  defaultToolTimeoutMs?: number;
}

/**
 * Executes actions. Every action is authorized, journaled *before* it runs, and
 * committed after it finishes, so a crash mid-tool leaves evidence the recovery
 * engine can act on instead of silently repeating side effects.
 */
export class Executor {
  constructor(private readonly options: ExecutorOptions) {}

  async execute(request: ExecutionRequest): Promise<ExecutionOutcome> {
    assertExecutable(request.actions);
    const dagNodes = request.actions.map((action) => ({
      id: action.id as string,
      ...(action.dependsOn && action.dependsOn.length > 0 ? { dependsOn: action.dependsOn.map(String) } : {}),
      value: action,
    }));
    const waves = planWaves(dagNodes);
    const outcomes: ActionOutcome[] = [];
    const failedIds = new Set<string>();
    const concurrency = request.concurrency ?? this.options.concurrency ?? 4;

    for (const wave of waves) {
      const runnable = wave.nodes.filter((node) => {
        const blocked = (node.dependsOn ?? []).some((dependency) => failedIds.has(dependency));
        if (!blocked) return true;
        outcomes.push(skippedOutcome(node.value, 'a dependency failed'));
        return false;
      });

      const waveResults = await mapConcurrent(runnable, concurrency, async (node) =>
        this.executeOne(node.value, request, this.effectivePermissions(request, node.value.toolId)),
      );
      for (const outcome of waveResults) {
        outcomes.push(outcome);
        if (outcome.status !== 'succeeded' && outcome.status !== 'already_committed') {
          failedIds.add(outcome.actionId);
        }
      }
    }

    return {
      outcomes,
      waves: waves.length,
      succeeded: outcomes.filter((outcome) => outcome.status === 'succeeded').length,
      failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      denied: outcomes.filter((outcome) => outcome.status === 'denied').length,
      awaitingApproval: outcomes.filter((outcome) => outcome.status === 'awaiting_approval').length,
      replayed: outcomes.filter((outcome) => outcome.replayed).length,
    };
  }

  /** Execute exactly one action, used for retries and single-step recovery. */
  async executeSingle(
    action: AgentAction,
    request: Omit<ExecutionRequest, 'actions'>,
    permissions?: ToolPermissions,
  ): Promise<ActionOutcome> {
    const full: ExecutionRequest = { ...request, actions: [action] };
    return this.executeOne(action, full, permissions ?? this.effectivePermissions(full, action.toolId));
  }

  private permissionsFor(request: ExecutionRequest, toolId: string): ToolPermissions {
    return typeof this.options.permissions === 'function'
      ? this.options.permissions(request, toolId)
      : this.options.permissions;
  }

  /**
   * A tool may only ever use less capability than the run grants it: the run's
   * resolved permissions are restricted by the permissions the tool declares it
   * needs (spec §21). A tool that wants a capability the run does not grant is
   * handed a denial, so it cannot escalate by declaring its own requirements.
   */
  private effectivePermissions(request: ExecutionRequest, toolId: string): ToolPermissions {
    return restrictPermissions(this.permissionsFor(request, toolId), this.options.registry.get(toolId)?.permissions);
  }

  private async executeOne(
    action: AgentAction,
    request: ExecutionRequest,
    permissions: ToolPermissions,
  ): Promise<ActionOutcome> {
    const started = Date.now();
    const base = { actionId: action.id as string, toolId: action.toolId, durationMs: 0, replayed: false };

    const tool = this.options.registry.get(action.toolId);
    if (!tool) {
      return {
        ...base,
        status: 'failed',
        error: new ToolNotFoundError(action.toolId),
        durationMs: Date.now() - started,
      };
    }

    // Already-committed actions are never re-run: the journal is the source of
    // truth for "did this side effect happen".
    const existing = await this.options.journal.findByKey(request.runId, action.idempotencyKey);
    if (existing && (existing.status === 'succeeded' || existing.status === 'failed')) {
      const succeeded = existing.status === 'succeeded';
      return {
        ...base,
        status: succeeded ? 'already_committed' : 'failed',
        replayed: true,
        result: {
          success: succeeded,
          output: (existing.result ?? null) as JsonValue,
          idempotency: existing.idempotency ?? 'unknown',
        },
        ...(succeeded
          ? {}
          : {
              error: new AgentError({
                code: (existing.error?.['code'] as string | undefined) ?? 'tool.previously_failed',
                message: (existing.error?.['message'] as string | undefined) ?? 'Action previously failed',
                category: 'tool',
                retryable: false,
                idempotency: existing.idempotency ?? 'unknown',
              }),
            }),
        durationMs: Date.now() - started,
      };
    }

    const policyContext: PolicyContext = {
      runId: request.runId,
      agentId: request.agentId,
      organizationId: request.organizationId,
      projectId: request.projectId,
      environment: request.environment,
      workspaceDir: request.workspaceDir,
      trust: request.trust,
      requestOrigin: request.requestOrigin,
      ...(request.remainingBudget ? { remainingBudget: request.remainingBudget } : {}),
    };
    const decision = await this.options.policy.evaluate(action, policyContext);
    await this.options.hooks?.onPolicyDecision?.({ action, decision });

    if (decision.outcome === 'DENY') {
      return {
        ...base,
        status: 'denied',
        policy: decision,
        error: new AgentError({
          code: 'policy.denied',
          message: decision.reason,
          category: 'policy',
          retryable: false,
          idempotency: 'idempotent',
          details: { ruleId: decision.ruleId, risk: decision.risk },
        }),
        durationMs: Date.now() - started,
      };
    }

    let effectiveArguments = action.arguments;
    if (decision.outcome === 'REQUIRE_APPROVAL') {
      if (!this.options.approvals) {
        return {
          ...base,
          status: 'denied',
          policy: decision,
          error: new AgentError({
            code: 'policy.approval_unavailable',
            message: `${decision.reason} but no approval channel is configured`,
            category: 'policy',
            retryable: false,
            idempotency: 'idempotent',
          }),
          durationMs: Date.now() - started,
        };
      }
      // An action keeps the same fingerprint across a pause, so a decision an
      // operator already made is found again instead of re-requested forever.
      const existingApprovalId =
        action.metadata?.['approvalId'] !== undefined
          ? String(action.metadata['approvalId'])
          : (await this.options.approvals.findForAction({ runId: request.runId, action }))?.id;
      if (existingApprovalId !== undefined) {
        const approvalId = String(existingApprovalId);
        const record = await this.options.approvals.get(approvalId);
        if (record?.status === 'pending') {
          return {
            ...base,
            status: 'awaiting_approval',
            policy: decision,
            approvalId,
            error: new ApprovalRequiredError(approvalId, record.reason),
            durationMs: Date.now() - started,
          };
        }
        try {
          const resolved = await this.options.approvals.resolve({ approvalId, action });
          effectiveArguments = resolved.arguments;
          return await this.runAuthorized(
            request,
            tool,
            action,
            effectiveArguments,
            decision,
            started,
            permissions,
            approvalId,
          );
        } catch (error) {
          return {
            ...base,
            status: 'denied',
            policy: decision,
            approvalId,
            error: toAgentError(error),
            durationMs: Date.now() - started,
          };
        }
      } else {
        const approval = await this.options.approvals.request({
          runId: request.runId,
          organizationId: request.organizationId,
          projectId: request.projectId,
          action,
          risk: decision.risk,
          reason: decision.reason,
          summary: decision.summary ?? `${action.toolId} requires approval`,
        });
        return {
          ...base,
          status: 'awaiting_approval',
          policy: decision,
          approvalId: approval.id,
          error: new ApprovalRequiredError(approval.id, decision.reason),
          durationMs: Date.now() - started,
        };
      }
    }

    return this.runAuthorized(request, tool, action, effectiveArguments, decision, started, permissions);
  }

  /** Journal, execute and commit an action that policy has authorized. */
  private async runAuthorized(
    request: ExecutionRequest,
    tool: AgentTool,
    action: AgentAction,
    effectiveArguments: JsonValue,
    decision: PolicyDecision,
    started: number,
    permissions: ToolPermissions,
    approvalId?: string,
  ): Promise<ActionOutcome> {
    const base: Omit<ActionOutcome, 'status' | 'durationMs'> = {
      actionId: action.id as string,
      toolId: action.toolId,
      policy: decision,
      replayed: false,
      ...(approvalId === undefined ? {} : { approvalId }),
    };
    const parsed = tool.inputSchema.safeParse(effectiveArguments);
    if (!parsed.success) {
      const error = new ToolInputError(action.toolId, `Invalid arguments: ${parsed.error.message}`, {
        issues: truncateJson(parsed.error.issues ?? [], 4_000).value,
      });
      await this.commit(request.runId, action, 'failed', undefined, error);
      return { ...base, status: 'failed', error, durationMs: Date.now() - started };
    }

    await this.options.journal.recordIntent({
      id: action.id as string,
      runId: request.runId,
      actionId: action.id as string,
      idempotencyKey: action.idempotencyKey,
      toolId: action.toolId,
      idempotency: action.idempotency,
      arguments: effectiveArguments,
      argumentsHash: action.idempotencyKey,
      status: 'executing',
      attempt: action.attempt,
      startedAt: started,
      ...(request.stepId ? { stepId: request.stepId } : {}),
    });

    const controller = new AbortController();
    const onAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = tool.timeoutMs ?? this.options.defaultToolTimeoutMs ?? 120_000;
    const timer = setTimeout(() => controller.abort(new ToolTimeoutError(action.toolId, timeoutMs)), timeoutMs);

    try {
      if (request.signal?.aborted) throw toAgentError(request.signal.reason, 'operation.aborted');
      const context = this.options.createToolContext(fullRequest(request, action), tool, controller.signal);
      const toolContext: ToolContext = { ...context, permissions };
      const result = await tool.execute(parsed.data, toolContext);
      const durationMs = Date.now() - started;
      await this.commit(request.runId, action, result.success ? 'succeeded' : 'failed', result.output, undefined);
      await this.options.hooks?.onInvocation?.({ action, result, durationMs });
      return {
        ...base,
        status: result.success ? 'succeeded' : 'failed',
        result,
        durationMs,
        observation: buildObservation(action, result),
        ...(result.success
          ? {}
          : {
              error: new AgentError({
                code: result.error?.code ?? 'tool.failed',
                message: result.error?.message ?? 'Tool reported failure',
                category: 'tool',
                retryable: result.error?.retryable ?? false,
                idempotency: (result.error?.idempotency as AgentAction['idempotency']) ?? action.idempotency,
                details: { toolId: action.toolId },
              }),
            }),
      };
    } catch (error) {
      const agentError = toAgentError(error);
      await this.commit(request.runId, action, 'failed', undefined, agentError);
      return { ...base, status: 'failed', error: agentError, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async commit(
    runId: string,
    action: AgentAction,
    status: 'succeeded' | 'failed',
    result: JsonValue | undefined,
    error: AgentError | undefined,
  ): Promise<void> {
    await this.options.journal.recordCommit({
      runId,
      idempotencyKey: action.idempotencyKey,
      status,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error: error.toJSON() as JsonObject }),
      finishedAt: Date.now(),
    });
  }
}

function fullRequest(request: ExecutionRequest, action: AgentAction): ExecutionRequest {
  return { ...request, actions: [action] };
}

function skippedOutcome(action: AgentAction, reason: string): ActionOutcome {
  return {
    actionId: action.id as string,
    toolId: action.toolId,
    status: 'skipped',
    error: new AgentError({
      code: 'action.dependency_failed',
      message: `Skipped ${action.toolId}: ${reason}`,
      category: 'state',
      retryable: false,
      idempotency: 'idempotent',
    }),
    durationMs: 0,
    replayed: false,
  };
}

function buildObservation(action: AgentAction, result: ToolResult): Observation {
  const summary = result.success
    ? `${action.toolId} succeeded`
    : `${action.toolId} failed: ${result.error?.message ?? 'unknown error'}`;
  return {
    id: `obs_${String(action.id)}`,
    at: Date.now(),
    source: 'tool',
    trust: 'untrusted-tool',
    summary,
    detail: truncateJson(result.output, 8_192).value,
    ...(action.stepId ? { stepId: action.stepId as string } : {}),
    toolId: action.toolId,
  };
}

export function assertExecutable(actions: AgentAction[]): void {
  if (actions.length === 0) throw new ValidationError('No actions to execute');
}

