import { afterEach, describe, expect, it } from 'vitest';
import {
  newPlanId,
  newStepId,
  type Plan,
  type Planner,
  type PlanningContext,
} from '@kazi-ai/agentos-core';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/** A planner under the caller's control, used to prove replacement works. */
const fixedPlan: Planner = {
  id: 'test.fixed-planner',
  async createPlan(context: PlanningContext): Promise<Plan> {
    return {
      id: newPlanId(),
      objective: context.goal,
      version: 1,
      createdAt: Date.now(),
      steps: [
        {
          id: newStepId(),
          index: 0,
          description: 'Write the file the operator asked for',
          status: 'pending',
        },
      ],
    };
  },
  async revisePlan(_context: PlanningContext, previousPlan: Plan): Promise<Plan> {
    return { ...previousPlan, version: previousPlan.version + 1 };
  },
};

describe('custom planner injection', () => {
  it('uses the injected planner and records its plan on the run', async () => {
    harness = await createHarness({
      turns: [
        {
          text: 'writing',
          toolCalls: [
            { name: 'filesystem.write', arguments: { path: 'planned.txt', content: 'planned' } },
          ],
        },
        { text: 'done' },
      ],
      runtime: { planner: fixedPlan },
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Write planned.txt' }));
    await harness.runtime.start(run.id);

    const state = await harness.runtime.getState(run.id);
    expect(state.plan?.objective).toBe('Write planned.txt');
    expect(state.plan?.steps[0]?.description).toBe('Write the file the operator asked for');
    const events = await harness.store.events.list(run.id);
    expect(events.some((event) => event.type === 'plan.created')).toBe(true);
  });

  it('lets a factory choose a planner per run', async () => {
    let calls = 0;
    const factory = ({ run }: { run: { agentId: string } }): Planner | undefined => {
      calls += 1;
      return run.agentId === 'planned-agent' ? fixedPlan : undefined;
    };
    harness = await createHarness({
      turns: [{ text: 'nothing to do' }],
      runtime: { planner: factory },
    });

    const planned = await harness.runtime.createRun(harness.runInput({ agentId: 'planned-agent' }));
    await harness.runtime.start(planned.id);
    const plain = await harness.runtime.createRun(harness.runInput({ agentId: 'plain-agent' }));
    await harness.runtime.start(plain.id);

    expect(calls).toBeGreaterThanOrEqual(2);
    expect((await harness.runtime.getState(planned.id)).plan).toBeDefined();
    expect((await harness.runtime.getState(plain.id)).plan).toBeUndefined();
  });
});
