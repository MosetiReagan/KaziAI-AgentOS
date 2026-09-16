import { describe, expect, it } from 'vitest';
import {
  SystemClock,
  createEvent,
  emptyUsage,
  newPlanId,
  newRunId,
  newStepId,
  type AgentEvent,
  type AgentEventType,
  type AgentRun,
  type CheckpointRef,
  type JsonObject,
} from '@kazi-ai/agentos-core';
import { InMemorySpanRecorder, SpanFactory, buildTrace, redactAttributes } from '../src/index.js';

const clock = new SystemClock();

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const now = 1_700_000_000_000;
  return {
    id: newRunId(now),
    goal: 'Fix the failing tests',
    agentId: 'developer',
    organizationId: 'org_1',
    projectId: 'prj_1',
    status: 'EXECUTING',
    stateVersion: 5,
    createdAt: now,
    updatedAt: now + 4_000,
    config: {
      agentId: 'developer',
      model: 'test-model',
      provider: 'fake',
      tools: ['filesystem.read', 'terminal.exec'],
      limits: {},
      permissions: {},
      memoryEnabled: false,
      planningEnabled: true,
      verificationEnabled: true,
      recoveryEnabled: true,
    },
    limits: {},
    usage: { ...emptyUsage(), steps: 2, toolCalls: 3, costUsd: 0.071, tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
    rootRunId: 'run_root',
    traceId: 'trc_1',
    workspaceDir: '/tmp/ws',
    ...overrides,
  };
}

function event(sequence: number, type: AgentEventType, data: JsonObject = {}, at?: number): AgentEvent {
  const event = createEvent({
    type,
    runId: 'run_1',
    organizationId: 'org_1',
    projectId: 'prj_1',
    sequence,
    data,
    ...(at === undefined ? {} : { at }),
  });
  return event;
}

describe('SpanFactory', () => {
  it('records spans with timing, attributes and a parent link', async () => {
    const recorder = new InMemorySpanRecorder();
    const factory = new SpanFactory(recorder, () => 1_000);

    const parent = factory.start('agent.run', { traceId: 'trc_1', runId: 'run_1', agentId: 'developer' });
    const child = await factory.withSpan(
      'agent.tool',
      { traceId: 'trc_1', runId: 'run_1', parentSpanId: parent.span.spanId, attributes: { 'tool.id': 'filesystem.read' } },
      async (span) => {
        span.setAttribute('tool.status', 'succeeded');
        return 'result';
      },
    );
    parent.end();

    expect(child).toBe('result');
    const spans = recorder.spans();
    expect(spans).toHaveLength(2);
    const toolSpan = spans.find((span) => span.name === 'agent.tool');
    expect(toolSpan?.attributes['run.id']).toBe('run_1');
    expect(toolSpan?.attributes['tool.id']).toBe('filesystem.read');
    expect(toolSpan?.status).toBe('ok');
    expect(toolSpan?.parentSpanId).toBe(parent.span.spanId);
    expect(spans.every((span) => span.durationMs !== undefined)).toBe(true);
  });

  it('marks failing spans and rethrows', async () => {
    const recorder = new InMemorySpanRecorder();
    const factory = new SpanFactory(recorder);

    await expect(
      factory.withSpan('agent.model', { traceId: 'trc_1', runId: 'run_1' }, async () => {
        throw Object.assign(new Error('provider exploded'), { code: 'provider.error' });
      }),
    ).rejects.toThrow('provider exploded');

    const span = recorder.spans()[0];
    expect(span?.status).toBe('error');
    expect(span?.error?.code).toBe('provider.error');
  });

  it('redacts secrets from span attributes', () => {
    const attributes = redactAttributes({
      'tool.id': 'http.request',
      authorization: 'Bearer sk-live-abcdefghijklmnop',
      apiKey: 'sk-proj-verysecretvalue',
      nested: { password: 'hunter2' },
    });
    const serialized = JSON.stringify(attributes);
    expect(serialized).not.toContain('sk-live-abcdefghijklmnop');
    expect(serialized).not.toContain('hunter2');
    expect(attributes['tool.id']).toBe('http.request');
  });
});

describe('buildTrace', () => {
  it('reconstructs the documented run → plan → step → tool → verification → completion shape', () => {
    const run = makeRun({ status: 'COMPLETED', finishedAt: 1_700_000_043_800 });
    const stepId = newStepId();
    const events: AgentEvent[] = [
      event(1, 'run.started'),
      event(2, 'plan.created', { stepCount: 3 }),
      event(3, 'step.started', { stepId }),
      event(4, 'tool.started', { toolId: 'filesystem.read', actionId: 'act_1' }, 1_700_000_000_000),
      event(5, 'tool.completed', { toolId: 'filesystem.read', actionId: 'act_1', status: 'succeeded' }, 1_700_000_002_000),
      event(6, 'verification.completed', { passed: true, summary: 'tests passed' }),
      event(7, 'checkpoint.created', { sequence: 1 }),
      event(8, 'run.completed'),
    ];

    const trace = buildTrace({
      run: { ...run, plan: { id: newPlanId(), objective: run.goal, steps: [], version: 1, createdAt: 1_700_000_000_100 } },
      events,
    });

    expect(trace.runId).toBe(run.id);
    expect(trace.traceId).toBe(run.traceId);
    const kinds = trace.nodes.map((node) => node.kind);
    expect(kinds).toContain('plan');
    expect(kinds).toContain('step');
    expect(kinds).toContain('tool');
    expect(kinds).toContain('verification');
    expect(kinds).toContain('checkpoint');

    const tool = trace.nodes.find((node) => node.kind === 'tool');
    expect(tool?.label).toBe('filesystem.read');
    expect(tool?.status).toBe('succeeded');
    expect(tool?.durationMs).toBe(2_000);

    expect(trace.summary.toolCalls).toBe(1);
    expect(trace.summary.checkpoints).toBe(1);
    expect(trace.summary.costUsd).toBe(0.071);
    expect(trace.summary.tokens).toBe(150);
    expect(trace.summary.durationMs).toBe(43_800);
  });

  it('keeps a failed tool call visible when it never completed', () => {
    const events: AgentEvent[] = [
      event(1, 'tool.started', { toolId: 'terminal.exec', actionId: 'act_9' }),
      event(2, 'tool.failed', { toolId: 'terminal.exec', actionId: 'act_9', status: 'failed' }),
      event(3, 'recovery.started', { strategy: 'retry_with_backoff', attempt: 1 }),
    ];

    const trace = buildTrace({ run: makeRun(), events });
    const tool = trace.nodes.find((node) => node.kind === 'tool');
    expect(tool?.status).toBe('failed');
    expect(trace.summary.failures).toBe(1);
    expect(trace.summary.recoveries).toBe(1);
  });

  it('falls back to persisted records when no events exist', () => {
    const stepId = newStepId();
    const trace = buildTrace({
      run: makeRun(),
      steps: [
        {
          id: stepId,
          index: 0,
          description: 'Inspect the repository',
          phase: 'execute',
          status: 'completed',
          toolId: 'filesystem.read',
          startedAt: 1_700_000_000_000,
          durationMs: 20,
        },
      ],
      invocations: [
        { id: 'inv_1', toolId: 'filesystem.read', actionId: 'act_1', status: 'succeeded', durationMs: 20, success: true, at: 1_700_000_000_000 },
      ],
      checkpoints: [{ id: 'cp_1', runId: 'run_1', sequence: 1, createdAt: 1_700_000_000_500, stateVersion: 2 } satisfies CheckpointRef],
      recoveries: [{ id: 'rec_1', attempt: 1, strategy: 'retry', success: true, at: 1_700_000_000_600 }],
      approvals: [{ id: 'apr_1', toolId: 'git', status: 'granted', risk: 'CRITICAL', requestedAt: 1_700_000_000_700, decidedAt: 1_700_000_000_800 }],
    });

    const kinds = trace.nodes.map((node) => node.kind);
    expect(kinds).toEqual(['step', 'tool', 'checkpoint', 'recovery', 'approval']);
    expect(trace.nodes.find((node) => node.kind === 'step')?.label).toBe('STEP 1 Inspect the repository');
    expect(trace.summary.steps).toBe(1);
  });

  it('does not duplicate records that events already describe', () => {
    const events: AgentEvent[] = [event(1, 'checkpoint.created', { sequence: 1 })];
    const trace = buildTrace({
      run: makeRun(),
      events,
      checkpoints: [{ id: events[0]!.id, runId: 'run_1', sequence: 1, createdAt: 1, stateVersion: 1 }],
    });
    expect(trace.nodes.filter((node) => node.kind === 'checkpoint')).toHaveLength(1);
  });

  it('orders nodes chronologically', () => {
    const events: AgentEvent[] = [
      event(1, 'step.started', { stepId: 'stp_a' }, 1_700_000_000_900),
      event(2, 'step.started', { stepId: 'stp_b' }, 1_700_000_000_100),
    ];
    const trace = buildTrace({ run: makeRun(), events });
    expect(trace.nodes.map((node) => node.startedAt)).toEqual([1_700_000_000_100, 1_700_000_000_900]);
  });

  it('produces deterministic output for the same input', () => {
    const run = makeRun();
    const steps = [{ id: 'stp_1', index: 0, description: 'x', phase: 'execute', status: 'completed', startedAt: 1 }];
    const first = buildTrace({ run, steps });
    const second = buildTrace({ run, steps });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('InMemorySpanRecorder', () => {
  it('bounds the number of retained spans', () => {
    const recorder = new InMemorySpanRecorder(2);
    const factory = new SpanFactory(recorder, () => clock.now());
    for (let index = 0; index < 5; index += 1) {
      factory.start('agent.step', { traceId: 'trc', runId: 'run' }).end();
    }
    expect(recorder.spans()).toHaveLength(2);
  });
});
