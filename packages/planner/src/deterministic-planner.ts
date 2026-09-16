import { newPlanId, newStepId, type Plan, type PlanStep, type Planner, type PlanningContext } from '@kazi-ai/agentos-core';

export interface DeterministicPlannerOptions {
  /** Ordered tool ids used to fill in the investigate/act/verify phases. */
  investigationTools?: string[];
  actionTools?: string[];
  verificationTools?: string[];
}

/**
 * A plan derived from the goal text and the tool list, without a model call.
 * It is a genuine (if simple) planner: it decides phases, tool selection, and
 * dependencies. Useful for tests, offline runs, and comparing planner variants.
 */
export class DeterministicPlanner implements Planner {
  readonly id = 'deterministic-planner';

  constructor(private readonly options: DeterministicPlannerOptions = {}) {}

  async createPlan(context: PlanningContext): Promise<Plan> {
    return this.build(context.goal, context.availableTools.map((tool) => tool.id), 1);
  }

  async revisePlan(context: PlanningContext, previousPlan: Plan, failure: { code: string; message: string }): Promise<Plan> {
    const plan = this.build(context.goal, context.availableTools.map((tool) => tool.id), previousPlan.version + 1);
    plan.steps.unshift({
      id: newStepId(),
      index: 0,
      description: `Diagnose the previous failure (${failure.code}): ${failure.message}`,
      status: 'pending',
    });
    plan.steps.forEach((step, index) => {
      step.index = index;
    });
    return plan;
  }

  private build(goal: string, toolIds: string[], version: number): Plan {
    const investigate = this.pick(toolIds, this.options.investigationTools ?? ['filesystem.list', 'filesystem.search', 'filesystem.read']);
    const act = this.pick(toolIds, this.options.actionTools ?? ['filesystem.edit', 'filesystem.write', 'terminal.exec']);
    const verify = this.pick(toolIds, this.options.verificationTools ?? ['terminal.exec']);

    const steps: PlanStep[] = [];
    const nextId = (): PlanStep['id'] => newStepId();
    const investigateId = nextId();

    steps.push({
      id: investigateId,
      index: steps.length,
      description: `Inspect the workspace and gather evidence relevant to: ${goal}`,
      ...(investigate ? { toolId: investigate } : {}),
      status: 'pending',
    });
    if (act) {
      steps.push({
        id: nextId(),
        index: steps.length,
        description: `Implement the change required by: ${goal}`,
        toolId: act,
        dependsOn: [investigateId],
        status: 'pending',
      });
    }
    if (verify) {
      steps.push({
        id: nextId(),
        index: steps.length,
        description: 'Verify the change by running the relevant checks',
        toolId: verify,
        dependsOn: [steps[steps.length - 1]?.id ?? investigateId],
        verification: 'commands exit successfully',
        status: 'pending',
      });
    }
    return { id: newPlanId(), objective: goal, steps, version, createdAt: Date.now() };
  }

  private pick(available: string[], preferred: string[]): string | undefined {
    for (const candidate of preferred) {
      if (available.includes(candidate)) return candidate;
    }
    return undefined;
  }
}
