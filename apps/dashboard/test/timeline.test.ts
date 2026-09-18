import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/api/types.js';
import { summarizeEvents, toTimeline, toolStats } from '../src/lib/timeline.js';

let sequence = 0;
function event(type: string, data: Record<string, unknown> = {}, id?: string): AgentEvent {
  sequence += 1;
  return {
    id: id ?? `evt_${sequence}`,
    type,
    version: 1,
    runId: 'run_1',
    organizationId: 'org_1',
    projectId: 'prj_1',
    sequence,
    at: 1_700_000_000_000 + sequence * 10,
    data,
  } as unknown as AgentEvent;
}

describe('the run timeline', () => {
  it('orders by sequence, not by arrival', () => {
    const first = event('step.started', { index: 1 });
    const second = event('step.completed', { index: 1 });
    const entries = toTimeline([second, first]);
    expect(entries.map((entry) => entry.sequence)).toEqual([first.sequence, second.sequence]);
    expect(entries[0]?.title).toBe('Step 1');
    expect(entries[1]?.tone).toBe('success');
  });

  it('deduplicates an event that is both replayed and streamed', () => {
    const once = event('tool.completed', { toolId: 'filesystem.read', durationMs: 12 });
    expect(toTimeline([once, once])).toHaveLength(1);
  });

  it('names tools, keeps the risk and marks a denial', () => {
    const entries = toTimeline([
      event('tool.requested', { toolId: 'git.push', risk: 'CRITICAL', actions: 1 }),
      event('tool.denied', { toolId: 'git.push', reason: 'rule git.push', risk: 'CRITICAL' }),
    ]);
    expect(entries[0]?.toolId).toBe('git.push');
    expect(entries[0]?.risk).toBe('CRITICAL');
    expect(entries[1]?.title).toBe('Denied git.push');
    expect(entries[1]?.detail).toBe('rule git.push');
    expect(entries[1]?.tone).toBe('danger');
  });

  it('describes a verification failure and a recovery strategy', () => {
    const entries = toTimeline([
      event('verification.completed', { passed: false, summary: '2 tests failed' }),
      event('recovery.completed', { strategy: 'retry_with_backoff', applied: true, attempt: 1 }),
    ]);
    expect(entries[0]?.tone).toBe('danger');
    expect(entries[0]?.detail).toBe('2 tests failed');
    expect(entries[1]?.title).toBe('Recovery applied: retry_with_backoff');
  });

  it('falls back to the raw type for an event it does not know yet', () => {
    const entries = toTimeline([event('something.new', {})]);
    expect(entries[0]?.kind).toBe('other');
    expect(entries[0]?.title).toBe('something.new');
    expect(entries[0]?.tone).toBe('neutral');
  });

  it('summarizes counts and the last state transition', () => {
    const events = [
      event('state.transitioned', { from: 'EXECUTING', to: 'VERIFYING' }),
      event('tool.completed', { toolId: 'a', durationMs: 5 }),
      event('tool.completed', { toolId: 'a', durationMs: 7 }),
      event('tool.failed', { toolId: 'b', code: 'tool.timeout' }),
      event('tool.denied', { toolId: 'c' }),
      event('recovery.completed', { strategy: 'retry', applied: true }),
      event('checkpoint.created', { checkpointId: 'cp_1' }),
      event('approval.requested', { toolId: 'git.push' }),
      event('verification.completed', { passed: false }),
      event('model.responded', { usage: { inputTokens: 10, outputTokens: 4 } }),
      event('model.failover', { from: 'a', to: 'b' }),
      event('budget.warning', { dimension: 'tokens' }),
    ];
    const stats = summarizeEvents(events);
    expect(stats).toMatchObject({
      events: 12,
      toolCalls: 2,
      toolFailures: 1,
      denials: 1,
      recoveries: 1,
      checkpoints: 1,
      approvals: 1,
      verifications: 1,
      failedVerifications: 1,
      modelCalls: 1,
      failovers: 1,
      budgetWarnings: 1,
      lastState: 'VERIFYING',
    });
    expect(stats.lastSequence).toBe(events[events.length - 1]?.sequence);
  });

  it('aggregates tool usage per tool', () => {
    const stats = toolStats([
      event('tool.completed', { toolId: 'filesystem.read', durationMs: 10 }),
      event('tool.completed', { toolId: 'filesystem.read', durationMs: 20 }),
      event('tool.failed', { toolId: 'terminal.exec' }),
      event('tool.denied', { toolId: 'git.push' }),
    ]);
    expect(stats[0]).toEqual({
      toolId: 'filesystem.read',
      calls: 2,
      failures: 0,
      denials: 0,
      totalMs: 30,
      lastStatus: 'completed',
    });
    expect(stats.find((entry) => entry.toolId === 'terminal.exec')?.failures).toBe(1);
    expect(stats.find((entry) => entry.toolId === 'git.push')?.denials).toBe(1);
  });
});
