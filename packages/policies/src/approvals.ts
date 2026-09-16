import {
  ApprovalDeniedError,
  NotFoundError,
  ValidationError,
  newApprovalId,
  type AgentAction,
  type Approval,
  type ApprovalDecisionInput,
  type ApprovalStore,
  type JsonValue,
  type RiskLevel,
} from '@kazi-ai/agentos-core';
import { actionHash } from './risk.js';

export interface ApprovalManagerOptions {
  store: ApprovalStore;
  /** How long a pending approval stays valid. */
  ttlMs?: number;
  now?: () => number;
}

export interface RequestApprovalInput {
  runId: string;
  organizationId: string;
  projectId: string;
  action: AgentAction;
  risk: RiskLevel;
  reason: string;
  summary: string;
}

/**
 * Approvals are always persisted before the run waits, and always re-verified
 * against the action fingerprint before execution. An in-memory approval can
 * never authorize work (spec §23).
 */
export class ApprovalManager {
  constructor(private readonly options: ApprovalManagerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async request(input: RequestApprovalInput): Promise<Approval> {
    const requestedAt = this.now();
    const approval: Approval = {
      id: newApprovalId(requestedAt),
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      actionId: input.action.id,
      toolId: input.action.toolId,
      arguments: input.action.arguments,
      actionHash: actionHash(input.action),
      risk: input.risk,
      reason: input.reason,
      summary: input.summary,
      status: 'pending',
      requestedAt,
      ...(this.options.ttlMs === undefined ? {} : { expiresAt: requestedAt + this.options.ttlMs }),
    };
    await this.options.store.create(approval);
    return approval;
  }

  async decide(input: ApprovalDecisionInput): Promise<Approval> {
    const approval = await this.options.store.get(input.approvalId);
    if (!approval) throw new NotFoundError('approval', input.approvalId);
    if (approval.status !== 'pending') {
      throw new ValidationError(`Approval ${input.approvalId} is already ${approval.status}`);
    }
    const now = this.now();
    const updated: Approval = {
      ...approval,
      status: input.decision === 'approve' ? 'granted' : input.decision === 'deny' ? 'denied' : 'modified',
      decidedAt: now,
      decidedBy: input.decidedBy,
      ...(input.reason === undefined ? {} : { decisionReason: input.reason }),
      ...(input.modifiedArguments === undefined ? {} : { modifiedArguments: input.modifiedArguments }),
    };
    // The fingerprint always describes the action that was *requested*; a
    // modification records the substituted arguments alongside it.
    await this.options.store.update(updated);
    return updated;
  }

  /**
   * Resolve an approval for execution. Returns the effective arguments, which
   * differ from the requested ones only when the approver modified them.
   */
  async resolve(input: { approvalId: string; action: AgentAction }): Promise<{ arguments: JsonValue }> {
    const approval = await this.options.store.get(input.approvalId);
    if (!approval) throw new NotFoundError('approval', input.approvalId);
    if (approval.status === 'pending') {
      throw new ValidationError(`Approval ${input.approvalId} is still pending`);
    }
    if (approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      throw new ApprovalDeniedError(input.approvalId, approval.decisionReason);
    }
    if (approval.expiresAt !== undefined && approval.expiresAt <= this.now()) {
      await this.options.store.update({ ...approval, status: 'expired' });
      throw new ApprovalDeniedError(input.approvalId, 'approval expired');
    }
    const expected = actionHash(input.action);
    if (expected !== approval.actionHash) {
      throw new ApprovalDeniedError(
        input.approvalId,
        'the action changed after approval was requested; re-approval is required',
      );
    }
    return { arguments: approval.modifiedArguments ?? input.action.arguments };
  }

  async get(approvalId: string): Promise<Approval | undefined> {
    return this.options.store.get(approvalId);
  }

  /**
   * Find an approval that was already requested for this exact action, so a
   * run that waited for a human can use the decision after it resumes instead
   * of asking again forever (spec §23, §54).
   */
  async findForAction(input: { runId: string; action: AgentAction }): Promise<Approval | undefined> {
    const requested = await this.options.store.list({ runId: input.runId });
    const hash = actionHash(input.action);
    const matches = requested
      .filter((approval) => approval.actionHash === hash && approval.status !== 'cancelled')
      .sort((left, right) => right.requestedAt - left.requestedAt);
    return matches[0];
  }

  async cancelForRun(runId: string, reason: string): Promise<number> {
    const pending = await this.options.store.list({ runId, status: 'pending' });
    for (const approval of pending) {
      await this.options.store.update({
        ...approval,
        status: 'cancelled',
        decidedAt: this.now(),
        decisionReason: reason,
      });
    }
    return pending.length;
  }
}
