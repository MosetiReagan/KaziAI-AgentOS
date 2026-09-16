import { describe, expect, it } from 'vitest';
import { ProviderError } from '@kazi-ai/agentos-core';
import { FakeModelProvider } from '@kazi-ai/agentos-providers';
import { DeterministicPlanner, LlmPlanner, assertAcyclic, findCycle, normalizePlan, responseToText } from '../src/index.js';
import type { PlanningContext } from '@kazi-ai/agentos-core';

const context: PlanningContext = {
  runId: 'run_1',
  goal: 'Fix the failing tests',
  agentId: 'developer',
  observations: [],
  availableTools: [
    { id: 'filesystem.list', description: 'List files' },
    { id: 'filesystem.read', description: 'Read a file' },
    { id: 'filesystem.edit', description: 'Edit a file' },
    { id: 'terminal.exec', description: 'Run a command' },
  ],
  attempt: 1,
};

describe('plan normalization', () => {
  it('assigns ids, indexes and dependencies', () => {
    const plan = normalizePlan({
      objective: 'Fix tests',
      steps: [
        { description: 'Inspect the repository' },
        { description: 'Apply the fix', tool: 'filesystem.edit', depends_on: [0] },
      ],
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[1]?.dependsOn).toEqual([plan.steps[0]?.id]);
    expect(plan.steps.every((step) => step.status === 'pending')).toBe(true);
  });

  it('drops out-of-range and self-referential dependencies instead of trusting them', () => {
    const plan = normalizePlan({
      objective: 'x',
      steps: [{ description: 'first' }, { description: 'second', depends_on: [0, 5, 1, -1] }],
    });
    expect(plan.steps[1]?.dependsOn).toEqual([plan.steps[0]?.id]);
  });

  it('bounds the number of steps', () => {
    const plan = normalizePlan(
      { objective: 'x', steps: Array.from({ length: 80 }, (_, index) => ({ description: `step ${index}` })) },
      { maxSteps: 5 },
    );
    expect(plan.steps).toHaveLength(5);
  });

  it('rejects an empty plan', () => {
    expect(() => normalizePlan({ objective: 'x', steps: [] })).toThrow();
  });

  it('detects dependency cycles', () => {
    const plan = normalizePlan({
      objective: 'x',
      steps: [
        { description: 'a', depends_on: [1] },
        { description: 'b', depends_on: [0] },
      ],
    });
    expect(findCycle(plan)).toBeTruthy();
    expect(() => assertAcyclic(plan)).toThrow(/cycle/);
  });
});

describe('llm planner', () => {
  it('parses a JSON plan from the model', async () => {
    const provider = new FakeModelProvider({
      turns: [
        {
          text: JSON.stringify({
            objective: 'Fix the failing tests',
            steps: [
              { description: 'Run the test suite', tool: 'terminal.exec' },
              { description: 'Fix the failure', tool: 'filesystem.edit', depends_on: [0] },
            ],
          }),
        },
      ],
    });
    const planner = new LlmPlanner({ provider, model: 'test-model' });
    const plan = await planner.createPlan(context);
    expect(plan.objective).toBe('Fix the failing tests');
    expect(plan.steps).toHaveLength(2);
    expect(plan.version).toBe(1);
  });

  it('extracts a plan from a fenced code block', async () => {
    const provider = new FakeModelProvider({
      turns: [{ text: '```json\n{"objective":"o","steps":[{"description":"do it"}]}\n```' }],
    });
    const plan = await new LlmPlanner({ provider, model: 'm' }).createPlan(context);
    expect(plan.steps[0]?.description).toBe('do it');
  });

  it('fails loudly on malformed JSON instead of inventing a plan', async () => {
    const provider = new FakeModelProvider({ turns: [{ text: 'I think we should start by looking around.' }] });
    await expect(new LlmPlanner({ provider, model: 'm' }).createPlan(context)).rejects.toMatchObject({
      code: 'planner.invalid_json',
    });
  });

  it('fails validation when the plan shape is wrong', async () => {
    const provider = new FakeModelProvider({ turns: [{ text: '{"objective":"o","steps":[]}' }] });
    await expect(new LlmPlanner({ provider, model: 'm' }).createPlan(context)).rejects.toMatchObject({
      code: 'validation.failed',
    });
  });

  it('increments the plan version on revision and passes the failure along', async () => {
    const provider = new FakeModelProvider({
      turns: [
        { text: '{"objective":"o","steps":[{"description":"first attempt"}]}' },
        { text: '{"objective":"o","steps":[{"description":"second attempt"}]}' },
      ],
    });
    const planner = new LlmPlanner({ provider, model: 'm' });
    const first = await planner.createPlan(context);
    const revised = await planner.revisePlan(context, first, { code: 'tool.failed', message: 'nope', category: 'tool' });
    expect(revised.version).toBe(2);
    expect(provider.requests[1]?.messages.some((message) => message.content.includes('nope'))).toBe(true);
  });

  it('propagates provider errors so recovery can classify them', async () => {
    const provider = new FakeModelProvider({ turns: [{ fail: { code: 'provider.overloaded', retryable: true } }] });
    await expect(new LlmPlanner({ provider, model: 'm' }).createPlan(context)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('deterministic planner', () => {
  it('produces a phased plan that only uses available tools', async () => {
    const planner = new DeterministicPlanner();
    const plan = await planner.createPlan(context);
    expect(plan.steps.length).toBeGreaterThanOrEqual(2);
    for (const step of plan.steps) {
      if (step.toolId) expect(context.availableTools.map((tool) => tool.id)).toContain(step.toolId);
    }
    expect(assertAcyclic(plan)).toBeUndefined();
  });

  it('prepends a diagnostic step when revising after a failure', async () => {
    const planner = new DeterministicPlanner();
    const first = await planner.createPlan(context);
    const revised = await planner.revisePlan(context, first, { code: 'tool.timeout', message: 'timed out' });
    expect(revised.steps[0]?.description).toContain('tool.timeout');
    expect(revised.version).toBe(2);
    expect(revised.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
  });

  it('omits steps when no suitable tool exists', async () => {
    const planner = new DeterministicPlanner();
    const plan = await planner.createPlan({ ...context, availableTools: [{ id: 'filesystem.read', description: 'read' }] });
    expect(plan.steps).toHaveLength(1);
  });
});

describe('response parsing', () => {
  it('handles plain, fenced and embedded JSON', () => {
    expect(responseToText({ content: [{ type: 'text', text: '{"a":1}' }], toolCalls: [] })).toBe('{"a":1}');
    expect(responseToText({ content: [{ type: 'text', text: '```json\n{"a":1}\n```' }], toolCalls: [] })).toBe('{"a":1}');
    expect(responseToText({ content: [{ type: 'text', text: 'Here: {"a":1} done' }], toolCalls: [] })).toBe('{"a":1}');
  });
});

