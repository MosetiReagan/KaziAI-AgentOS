import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatBytes,
  formatCost,
  formatDuration,
  formatJson,
  formatPercent,
  formatTokens,
  truncateId,
} from '../src/lib/format.js';
import { budgetLines } from '../src/lib/budget.js';
import type { AgentRun } from '../src/api/types.js';

describe('formatting', () => {
  it('renders durations at a readable scale', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(377)).toBe('377ms');
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(43_800)).toBe('44s');
    expect(formatDuration(185_000)).toBe('3m 5s');
    expect(formatDuration(7_300_000)).toBe('2h 1m');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });

  it('renders cost without pretending to a precision it does not have', () => {
    expect(formatCost(0)).toBe('$0.000');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(0.071)).toBe('$0.071');
    expect(formatCost(undefined)).toBe('—');
  });

  it('scales tokens and bytes', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_536)).toBe('1.5 KB');
  });

  it('renders ages as a short delta', () => {
    const now = 1_000_000;
    expect(formatAge(now - 400, now)).toBe('now');
    expect(formatAge(now - 12_000, now)).toBe('12s');
    expect(formatAge(now - 240_000, now)).toBe('4m');
    expect(formatAge(now - 7_200_000, now)).toBe('2h');
    expect(formatAge(now - 172_800_000, now)).toBe('2d');
  });

  it('never throws on a value it cannot serialise', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatJson(cyclic)).toBe('[object Object]');
    expect(formatPercent(0.256)).toBe('26%');
    expect(truncateId('run_01M2SS9H5AJ823CY18MEQKFNPJ')).toBe('run_01M2SS9H…');
  });
});

describe('budget lines', () => {
  const run = {
    limits: { maxSteps: 10, maxCostUsd: 1, maxTokens: 1_000 },
    usage: {
      steps: 5,
      toolCalls: 4,
      tokens: { inputTokens: 800, outputTokens: 0, totalTokens: 800 },
      costUsd: 0.9,
      durationMs: 0,
      networkRequests: 0,
      storageBytes: 0,
      recoveryCount: 0,
      checkpointCount: 0,
      modelCalls: 0,
    },
  } as unknown as Pick<AgentRun, 'limits' | 'usage'>;

  it('reports usage, remaining allowance and a tone per budget', () => {
    const lines = budgetLines(run);
    const steps = lines.find((line) => line.key === 'maxSteps');
    expect(steps?.display).toBe('5 / 10');
    expect(steps?.remaining).toBe('5 left');
    expect(steps?.ratio).toBe(0.5);
    expect(steps?.tone).toBe('neutral');

    const cost = lines.find((line) => line.key === 'maxCostUsd');
    expect(cost?.tone).toBe('warn');
    expect(cost?.remaining).toBe('$0.100 left');
  });

  it('marks an exhausted budget and says so for an unlimited one', () => {
    const exhausted = budgetLines({
      limits: { maxSteps: 5 },
      usage: { ...run.usage, steps: 5 },
    } as unknown as Pick<AgentRun, 'limits' | 'usage'>);
    expect(exhausted.find((line) => line.key === 'maxSteps')?.tone).toBe('danger');
    expect(exhausted.find((line) => line.key === 'maxSteps')?.remaining).toBe('0 left');
    expect(exhausted.find((line) => line.key === 'maxCostUsd')?.remaining).toBe('unlimited');
    expect(exhausted.find((line) => line.key === 'maxCostUsd')?.ratio).toBeUndefined();
  });
});
