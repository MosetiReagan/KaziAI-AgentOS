import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryEventBus,
  newRunId,
  type AgentRun,
  type AgentTool,
  type JsonValue,
  type ModelProvider,
  type ToolContext,
} from '@kazi-ai/agentos-core';
import { createStore } from '@kazi-ai/agentos-persistence';
import { FakeModelProvider, ModelProviderRegistry } from '@kazi-ai/agentos-providers';
import { DefaultPolicyEngine, RiskClassifier } from '@kazi-ai/agentos-policies';
import { z } from 'zod';
import {
  Backpressure,
  EventWriter,
  GatewayProvider,
  InProcessRunControl,
  actionFromToolCall,
  actionHashOf,
  advanceRunTo,
  idempotencyFor,
  idempotencyKeyFor,
  toAgentRunResult,
  type ModelGatewayLike,
} from '../src/index.js';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('idempotency classification', () => {
  it('classifies each tool by how safe it is to repeat', () => {
    expect(idempotencyFor({ id: 'filesystem.read' }, null)).toBe('idempotent');
    expect(idempotencyFor({ id: 'filesystem.list' }, null)).toBe('idempotent');
    expect(idempotencyFor({ id: 'filesystem.write' }, null)).toBe('retry-safe');
    expect(idempotencyFor({ id: 'filesystem.delete' }, null)).toBe('non-idempotent');
    expect(idempotencyFor({ id: 'terminal.exec' }, null)).toBe('non-idempotent');
    expect(idempotencyFor({ id: 'unknown.tool' }, null)).toBe('unknown');
    expect(idempotencyFor({ id: 'mcp.github.create_issue' }, null)).toBe('unknown');
  });

  it('treats a mutating git or database operation as non-idempotent', () => {
    expect(idempotencyFor({ id: 'git' }, { operation: 'diff' })).toBe('idempotent');
    expect(idempotencyFor({ id: 'git' }, { operation: 'push' })).toBe('non-idempotent');
    expect(idempotencyFor({ id: 'git' }, { operation: 'commit' })).toBe('non-idempotent');
    expect(idempotencyFor({ id: 'database.query' }, { sql: 'select 1' })).toBe('idempotent');
    expect(idempotencyFor({ id: 'database.query' }, { sql: 'delete from users' })).toBe('non-idempotent');
  });

  it('derives a stable key for the same action and a different one otherwise', () => {
    const base = { runId: 'run_1', stepIndex: 3, toolId: 'filesystem.read', args: { path: 'a' } as JsonValue, attempt: 0 };
    expect(idempotencyKeyFor(base.runId, base.stepIndex, base.toolId, base.args, base.attempt)).toBe(
      idempotencyKeyFor(base.runId, base.stepIndex, base.toolId, base.args, base.attempt),
    );
    const different = idempotencyKeyFor(base.runId, base.stepIndex, base.toolId, base.args, base.attempt + 1);
    expect(different).not.toBe(idempotencyKeyFor(base.runId, base.stepIndex, base.toolId, base.args, base.attempt));
    const otherStep = idempotencyKeyFor(base.runId, base.stepIndex + 1, base.toolId, base.args, base.attempt);
    expect(otherStep).not.toBe(idempotencyKeyFor(base.runId, base.stepIndex, base.toolId, base.args, base.attempt));
  });

  it('builds an action whose hash covers the tool and its arguments only', () => {
    const run = { id: 'run_1', goal: 'g', agentId: 'a' } as unknown as AgentRun;
    const action = actionFromToolCall({
      run,
      toolCall: { id: 'call_1', name: 'filesystem__read', arguments: { path: 'a' } },
      tool: { id: 'filesystem.read' },
      stepIndex: 0,
      attempt: 0,
    });
    expect(action.toolId).toBe('filesystem.read');
    expect(action.idempotency).toBe('idempotent');
    expect(actionHashOf(action)).toBe(actionHashOf({ ...action, id: 'other' as never }));
  });
});

describe('InProcessRunControl', () => {
  it('propagates cancellation to an abort signal exactly once', () => {
    const control = new InProcessRunControl('run_1');
    const listener = vi.fn();
    control.signal.addEventListener('abort', listener);
    expect(control.cancelled).toBe(false);
    control.cancel('because');
    expect(control.cancelled).toBe(true);
    expect(control.cancelReason).toBe('because');
    expect(control.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('records pause without touching the cancellation signal', () => {
    const control = new InProcessRunControl('run_1');
    control.pause();
    expect(control.paused).toBe(true);
    expect(control.cancelled).toBe(false);
    expect(control.signal.aborted).toBe(false);
  });
});

describe('Backpressure', () => {
  it('reserves, releases and reports the configured limits', async () => {
    const backpressure = new Backpressure({ maxConcurrentRuns: 2 });
    backpressure.reserve();
    backpressure.reserve();
    expect(backpressure.active).toBe(2);
    await expect(backpressure.assertAccepting({ organizationId: 'org_1' })).rejects.toThrow(/already executing/i);
    backpressure.release();
    await expect(backpressure.assertAccepting({ organizationId: 'org_1' })).resolves.toBeUndefined();
    expect(backpressure.maximum.maxConcurrentRuns).toBe(2);
  });

  it('refuses queue growth past the configured depth', async () => {
    const backpressure = new Backpressure({ maxQueueDepth: 5 });
    const decision = await backpressure.check({ organizationId: 'org_1', queueDepth: 5 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/queue is full/i);
  });
});

describe('EventWriter', () => {
  it('persists before publishing and assigns monotonic sequences', async () => {
    const store = await createStore({ driver: 'memory' });
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));
    const writer = new EventWriter({ store, bus });
    const runId = newRunId();
    await writer.emit({ type: 'run.created', runId, organizationId: 'org_1', projectId: 'prj_1' });
    await writer.emit({ type: 'run.started', runId, organizationId: 'org_1', projectId: 'prj_1' });

    const stored = await store.events.list(runId);
    expect(stored.map((stored) => stored.sequence)).toEqual([1, 2]);
    expect(stored.every((stored) => stored.version >= 1)).toBe(true);
    expect(seen).toEqual(['run.created', 'run.started']);
    await store.close();
  });
});

describe('advanceRunTo', () => {
  it('walks only legal transitions and records each hop', async () => {
    const store = await createStore({ driver: 'memory' });
    const writer = new EventWriter({ store });
    const run = {
      id: newRunId(),
      status: 'CREATED',
      stateVersion: 1,
      organizationId: 'org_1',
      projectId: 'prj_1',
      traceId: 'trc_1',
    } as unknown as AgentRun;
    await store.runs.create(run);

    await advanceRunTo({ store, events: writer, run, target: 'EXECUTING', reason: 'test' });
    expect(run.status).toBe('EXECUTING');
    const events = await store.events.list(run.id);
    const hops = events.filter((event) => event.type === 'state.transitioned');
    expect(hops.length).toBeGreaterThan(0);
    expect(hops[0]?.data['from']).toBe('CREATED');
    expect(hops.at(-1)?.data['to']).toBe('EXECUTING');
    await store.close();
  });
});

describe('GatewayProvider', () => {
  it('presents the failover gateway as one provider', async () => {
    const gateway: ModelGatewayLike = {
      generate: async () => ({
        response: { content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        attempts: 2,
        provider: 'fallback-provider',
        model: 'model-b',
        failedOver: true,
      }),
    };
    const provider: ModelProvider = new GatewayProvider({ gateway, id: 'gw', defaultModel: 'model-a' });
    const response = await provider.generate({ model: '', messages: [] });
    expect(response.provider).toBe('fallback-provider');
    expect(response.model).toBe('model-b');
    expect((await provider.generate({ model: 'pinned', messages: [] })).model).toBe('model-b');
  });
});

describe('toAgentRunResult', () => {
  it('reports the outcome of a run without inventing success', async () => {
    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const state = await harness.runtime.getState(run.id);
    const finished = await harness.runtime.getRun(run.id);

    const result = toAgentRunResult({ run: finished, state, policyViolations: 2, artifacts: [] });
    expect(result.success).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(result.policyViolations).toBe(2);
    expect(result.runId).toBe(run.id);

    const failed = toAgentRunResult({
      run: { ...finished, status: 'FAILED' },
      state,
      policyViolations: 0,
      artifacts: [],
    });
    expect(failed.success).toBe(false);
  });
});

describe('runtime wiring', () => {
  it('registers providers and reports them for the API surface', async () => {
    const registry = new ModelProviderRegistry();
    registry.register(new FakeModelProvider({ turns: [{ text: 'x' }] }));
    expect(registry.ids()).toEqual(['fake']);
    expect(registry.describe()[0]?.kind).toBe('fake');
  });

  it('exposes the tool catalog with schemas, risks and permissions', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }] });
    const definitions = harness.runtime.tools.toDefinitions(['filesystem.read']);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe('filesystem.read');
    expect(definitions[0]?.parameters['type']).toBe('object');
    const describe = harness.runtime.tools.describe();
    expect(describe.some((tool) => tool.id === 'filesystem.read' && tool.risk === 'LOW')).toBe(true);
    expect(harness.runtime.tools.permissionsOf('filesystem.read')).toEqual({ filesystem: { read: true } });
  });

  it('lists runs and reports pending approvals for an organization', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }] });
    const run = await harness.runtime.createRun(harness.runInput());
    const runs = await harness.runtime.listRuns({ organizationId: 'org_test' });
    expect(runs.map((entry) => entry.id)).toEqual([run.id]);
    expect(await harness.runtime.pendingApprovals('org_test')).toEqual([]);
  });
});

describe('custom tools', () => {
  it('runs an operator-supplied tool through the same authorization path', async () => {
    const calls: JsonValue[] = [];
    const weather: AgentTool = {
      id: 'weather.get',
      description: 'Get the current weather',
      kind: 'custom',
      risk: 'LOW',
      timeoutMs: 5_000,
      inputSchema: z.object({ city: z.string() }),
      permissions: {},
      async execute(input: unknown, context: ToolContext) {
        void context;
        calls.push(input as JsonValue);
        return { success: true, output: { city: (input as { city: string }).city, tempC: 21 } };
      },
    };

    harness = await createHarness({
      turns: [
        { text: 'checking the weather', toolCalls: [{ name: 'weather.get', arguments: { city: 'Nairobi' } }] },
        { text: 'It is 21C in Nairobi.' },
      ],
      tools: ['weather.get'],
      extraTools: [weather],
      // A tool the runtime knows nothing about is HIGH risk by default, so an
      // operator has to say otherwise before it can run without approval.
      runtime: {
        policies: new DefaultPolicyEngine({
          classifier: new RiskClassifier([
            { id: 'weather.read', description: 'reading weather is low risk', tool: 'weather.*', risk: 'LOW' },
          ]),
        }),
      },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Check the weather' }));
    await harness.runtime.start(run.id);

    expect((await harness.runtime.getRun(run.id)).status).toBe('COMPLETED');
    expect(calls).toEqual([{ city: 'Nairobi' }]);
    const invocations = await harness.store.invocations.list(run.id);
    expect(invocations[0]?.toolId).toBe('weather.get');
    expect(invocations[0]?.success).toBe(true);
  });

  it('rejects a tool registration that duplicates an id', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }] });
    const duplicate: AgentTool = {
      id: 'filesystem.read',
      description: 'duplicate',
      inputSchema: z.object({}),
      async execute() {
        return { success: true, output: null };
      },
    };
    expect(() => harness!.runtime.tools.register(duplicate)).toThrow(/already registered/i);
  });

  it('rejects a tool whose id is not namespaced', async () => {
    harness = await createHarness({ turns: [{ text: 'x' }] });
    const bad: AgentTool = {
      id: 'Weather',
      description: 'bad id',
      inputSchema: z.object({}),
      async execute() {
        return { success: true, output: null };
      },
    };
    expect(() => harness!.runtime.tools.register(bad)).toThrow(/Invalid tool id/);
  });
});
