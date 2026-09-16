import { describe, expect, it } from 'vitest';
import type { Observation, Plan } from '@kazi-ai/agentos-core';
import { ContextManager, HeuristicTokenEstimator } from '../src/index.js';

function observation(index: number, detailSize = 100): Observation {
  return {
    id: `obs_${index}`,
    at: index,
    source: 'tool',
    trust: 'untrusted-tool',
    summary: `step ${index} result`,
    detail: 'y'.repeat(detailSize),
    toolId: 'filesystem.read',
  };
}

const plan: Plan = {
  id: 'pln_1' as Plan['id'],
  objective: 'Fix the failing tests',
  version: 1,
  createdAt: 0,
  steps: [
    { id: 'stp_1' as Plan['steps'][number]['id'], index: 0, description: 'Inspect the repo', status: 'completed' },
    { id: 'stp_2' as Plan['steps'][number]['id'], index: 1, description: 'Fix the code', status: 'pending' },
  ],
};

describe('token estimator', () => {
  it('is monotonic and cheap', () => {
    const estimator = new HeuristicTokenEstimator();
    expect(estimator.estimate('')).toBe(0);
    expect(estimator.estimate('abcd')).toBe(1);
    expect(estimator.estimate('a'.repeat(400))).toBeGreaterThan(estimator.estimate('a'.repeat(40)));
  });
});

describe('context manager', () => {
  it('always includes the system prompt, objective and plan', async () => {
    const manager = new ContextManager();
    const built = await manager.build({
      systemPrompt: 'You are a coding agent.',
      goal: 'Fix the failing tests',
      plan,
      observations: [observation(1)],
      memory: [],
    });
    expect(built.messages[0]).toMatchObject({ role: 'system', trust: 'trusted-system' });
    const joined = built.messages.map((message) => message.content).join('\n');
    expect(joined).toContain('Fix the failing tests');
    expect(joined).toContain('Fix the code');
    expect(built.compressed).toBe(false);
  });

  it('labels tool observations as untrusted data', async () => {
    const manager = new ContextManager();
    const built = await manager.build({
      systemPrompt: 'sys',
      goal: 'goal',
      observations: [observation(1)],
      memory: [],
    });
    const toolMessage = built.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.trust).toBe('untrusted-tool');
  });

  it('compresses older observations when the budget is exceeded and records what it dropped', async () => {
    const manager = new ContextManager({ budget: { maxInputTokens: 500, keepRecentObservations: 3, compressAtRatio: 0.5 } });
    const observations = Array.from({ length: 20 }, (_, index) => observation(index, 400));
    const built = await manager.build({ systemPrompt: 'sys', goal: 'goal', observations, memory: [] });
    expect(built.compressed).toBe(true);
    expect(built.compression?.observationsCompressed).toBeGreaterThan(0);
    expect(built.compression?.summary).toContain('compressed');
    expect(manager.compressionHistory).toHaveLength(1);
    // The most recent observations survive verbatim.
    expect(JSON.stringify(built.messages)).toContain('step 19 result');
  });

  it('never compresses away verification or recovery observations', async () => {
    const manager = new ContextManager({ budget: { maxInputTokens: 400, keepRecentObservations: 1, compressAtRatio: 0.3 } });
    const observations: Observation[] = [
      { ...observation(0, 900), source: 'verification', trust: 'trusted-system', summary: 'tests passed' },
      ...Array.from({ length: 10 }, (_, index) => observation(index + 1, 900)),
    ];
    const built = await manager.build({ systemPrompt: 'sys', goal: 'goal', observations, memory: [] });
    expect(JSON.stringify(built.messages)).toContain('tests passed');
  });

  it('rejects an empty system prompt rather than improvising one', async () => {
    const manager = new ContextManager();
    await expect(manager.build({ systemPrompt: '  ', goal: 'g', observations: [], memory: [] })).rejects.toMatchObject({
      code: 'validation.failed',
    });
  });

  it('produces a checkpoint snapshot capturing plan progress and verification', async () => {
    const manager = new ContextManager();
    const snapshot = manager.snapshot({
      objective: 'Fix the failing tests',
      plan,
      observations: [observation(1)],
      verification: { passed: true, summary: 'tests passed' },
      memoryRefs: ['mem_1'],
    });
    expect(snapshot.completedSteps).toEqual(['stp_1']);
    expect(snapshot.pendingSteps).toEqual(['stp_2']);
    expect(snapshot.memoryRefs).toEqual(['mem_1']);
    expect(snapshot.verification).toMatchObject({ passed: true, summary: 'tests passed' });
  });
});

