import type { JsonObject, JsonValue } from '../json.js';
import type { RiskLevel } from './policy.js';

export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'modified' | 'expired' | 'cancelled';

export interface Approval {
  id: string;
  runId: string;
  organizationId: string;
  projectId: string;
  actionId: string;
  toolId: string;
  arguments: JsonValue;
  risk: RiskLevel;
  reason: string;
  summary: string;
  status: ApprovalStatus;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionReason?: string;
  /** Arguments the approver substituted when modifying the action. */
  modifiedArguments?: JsonValue;
  /** Fingerprint of the approved payload; any deviation voids the approval. */
  actionHash: string;
  expiresAt?: number;
  metadata?: JsonObject;
}

export interface ApprovalStore {
  create(approval: Approval): Promise<void>;
  get(id: string): Promise<Approval | undefined>;
  update(approval: Approval): Promise<void>;
  list(filter: { runId?: string; organizationId?: string; status?: ApprovalStatus }): Promise<Approval[]>;
  /** Pending approvals waiting on a human. */
  pending(organizationId?: string): Promise<Approval[]>;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: 'approve' | 'deny' | 'modify';
  decidedBy: string;
  reason?: string;
  modifiedArguments?: JsonValue;
}

