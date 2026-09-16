import type { JsonObject } from '../json.js';
import type { AgentAction } from './action.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PolicyOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL';

export interface PolicyDecision {
  outcome: PolicyOutcome;
  /** Stable identifier of the rule that produced this decision. */
  ruleId: string;
  reason: string;
  risk: RiskLevel;
  /** Human readable summary presented in approval prompts. */
  summary?: string;
  metadata?: JsonObject;
}

export interface PolicyContext {
  runId: string;
  agentId: string;
  organizationId: string;
  projectId: string;
  environment: string;
  /** Remaining budget for the run, consulted by budget-aware rules. */
  remainingBudget?: JsonObject;
  workspaceDir: string;
  /** Provenance of the instruction that produced the action. */
  trust: string;
  requestOrigin: 'agent' | 'system' | 'recovery' | 'verification';
  metadata?: JsonObject;
}

export interface PolicyProvider {
  authorize(action: AgentAction, context: PolicyContext): Promise<PolicyDecision>;
}

export interface PolicyRule {
  id: string;
  description: string;
  /** Higher priority rules are evaluated first. */
  priority?: number;
  risk?: RiskLevel;
  evaluate(action: AgentAction, context: PolicyContext): PolicyDecision | undefined;
}

export interface PolicyEngine extends PolicyProvider {
  evaluate(action: AgentAction, context: PolicyContext): Promise<PolicyDecision>;
  register(rule: PolicyRule): void;
  unregister(ruleId: string): void;
  list(): PolicyRule[];
}

