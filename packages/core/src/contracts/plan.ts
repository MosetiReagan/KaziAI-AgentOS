import type { JsonObject } from '../json.js';
import type { PlanId, StepId } from '../ids.js';

export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlanStep {
  id: StepId;
  index: number;
  description: string;
  /** Tool the step intends to use, if the planner is specific. Never trusted for authorization. */
  toolId?: string;
  status: PlanStepStatus;
  /** Ids of steps that must complete first. */
  dependsOn?: StepId[];
  /** Expected verification for this step. */
  verification?: string;
  startedAt?: number;
  finishedAt?: number;
  result?: JsonObject;
  error?: JsonObject;
}

export interface Plan {
  id: PlanId;
  objective: string;
  steps: PlanStep[];
  version: number;
  createdAt: number;
  metadata?: JsonObject;
}

export interface PlanningContext {
  runId: string;
  goal: string;
  agentId: string;
  /** Untrusted observations, clearly labelled. */
  observations: Array<{ source: string; trust: string; content: string }>;
  availableTools: Array<{ id: string; description: string }>;
  previousPlan?: Plan;
  failure?: { code: string; message: string; category: string };
  attempt: number;
  metadata?: JsonObject;
}

export interface Planner {
  readonly id: string;
  createPlan(context: PlanningContext): Promise<Plan>;
  revisePlan(context: PlanningContext, previousPlan: Plan, failure: { code: string; message: string; category: string }): Promise<Plan>;
}

export function pendingSteps(plan: Plan): PlanStep[] {
  return plan.steps.filter((step) => step.status === 'pending');
}

export function planProgress(plan: Plan): { completed: number; failed: number; total: number } {
  const completed = plan.steps.filter((step) => step.status === 'completed').length;
  const failed = plan.steps.filter((step) => step.status === 'failed').length;
  return { completed, failed, total: plan.steps.length };
}

