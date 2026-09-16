import { ValidationError, newPlanId, newStepId, type Plan, type PlanStep } from '@kazi-ai/agentos-core';
import { z } from 'zod';

export const planStepSchema = z.object({
  description: z.string().min(3),
  tool: z.string().optional(),
  depends_on: z.array(z.number().int().nonnegative()).optional(),
  verification: z.string().optional(),
});

export const planSchema = z.object({
  objective: z.string().min(1),
  steps: z.array(planStepSchema).min(1).max(50),
});

export type RawPlan = z.infer<typeof planSchema>;

export interface NormalizePlanOptions {
  maxSteps?: number;
  version?: number;
  now?: number;
}

/**
 * Turn a model-produced plan into a validated `Plan`. Model output is untrusted:
 * unknown tools are recorded but never granted, dependencies outside the range
 * are dropped, and the step count is bounded so a runaway plan cannot be
 * persisted.
 */
export function normalizePlan(raw: RawPlan, options: NormalizePlanOptions = {}): Plan {
  const maxSteps = options.maxSteps ?? 50;
  const now = options.now ?? Date.now();
  if (raw.steps.length === 0) throw new ValidationError('A plan must contain at least one step');
  const steps: PlanStep[] = [];
  const limited = raw.steps.slice(0, maxSteps);
  limited.forEach((step, index) => {
    const dependencies = (step.depends_on ?? [])
      .filter((dependency) => Number.isInteger(dependency) && dependency >= 0 && dependency < limited.length && dependency !== index)
      .map((dependency) => steps[dependency]?.id)
      .filter((id): id is PlanStep['id'] => id !== undefined);
    steps.push({
      id: newStepId(now),
      index,
      description: step.description,
      ...(step.tool ? { toolId: step.tool } : {}),
      ...(step.verification ? { verification: step.verification } : {}),
      ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
      status: 'pending',
    });
  });
  return {
    id: newPlanId(now),
    objective: raw.objective,
    steps,
    version: options.version ?? 1,
    createdAt: now,
  };
}

/** Detect dependency cycles so the executor never deadlocks. */
export function findCycle(plan: Plan): string[] | undefined {
  const byId = new Map<string, PlanStep>(plan.steps.map((step) => [step.id as string, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let cycle: string[] | undefined;

  const visit = (id: string, path: string[]): void => {
    if (cycle) return;
    if (visiting.has(id)) {
      cycle = [...path.slice(path.indexOf(id)), id];
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const step = byId.get(id);
    for (const dependency of step?.dependsOn ?? []) visit(dependency, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  };

  for (const step of plan.steps) visit(step.id, []);
  return cycle;
}

export function assertAcyclic(plan: Plan): void {
  const cycle = findCycle(plan);
  if (cycle) throw new ValidationError(`Plan contains a dependency cycle: ${cycle.join(' -> ')}`);
}
