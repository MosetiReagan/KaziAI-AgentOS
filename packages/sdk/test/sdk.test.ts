import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import {
  NullLogger,
  newPlanId,
  newStepId,
  type Plan,
  type Planner,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import { createAgentOS, defineTool, type AgentOS } from '../src/index.js';

let os: AgentOS | undefined;
let dir: string | undefined;

afterEach(async () => {
  await os?.close();
  os = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function agentOSFor(
  turns: FakeTurn[],
  overrides: Parameters<typeof createAgentOS>[0] = {},
): Promise<AgentOS> {
  dir = mkdtempSync(join(tmpdir(), 'kazi-sdk-'));
  os = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
    ...overrides,
  });
  return os;
}

/** What a model-backed planner is asked to return (spec §9). */
function planTurn(objective: string, description: string): FakeTurn {
  return { text: JSON.stringify({ objective, steps: [{ description }] }) };
}

const WRITE_AND_FINISH: FakeTurn[] = [
  planTurn('Write result.txt', 'Write result.txt into the workspace'),
  {
    text: 'writing the file',
    toolCalls: [{ name: 'filesystem.write', arguments: { path: 'result.txt', content: 'hello' } }],
  },
  { text: 'the file is written' },
];

describe('Agent SDK', () => {
  it('declares an agent, runs a goal, and returns a measured result', async () => {
    const agentos = await agentOSFor(WRITE_AND_FINISH);
    const agent = agentos.agent({
      id: 'developer',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['filesystem'],
      limits: { maxSteps: 10 },
    });

    const result = await agent.run({ goal: 'Write result.txt' });

    expect(result.status).toBe('COMPLETED');
    expect(result.success).toBe(true);
    expect(result.steps).toBeGreaterThan(0);
    expect(result.toolCalls).toBe(1);
    expect(result.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(result.recoveryCount).toBe(0);
    expect(result.traceId).toMatch(/^trc_/);
  });

  it('expands tool families so the documented shorthand works', async () => {
    const agentos = await agentOSFor(WRITE_AND_FINISH);
    const agent = agentos.agent({
      id: 'developer',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['filesystem', 'terminal'],
    });

    expect(agent.definition.tools).toEqual(['filesystem.*', 'terminal.*']);
    expect(agentos.tools.resolve(agent.definition.tools).map((tool) => tool.id)).toContain(
      'filesystem.write',
    );
    expect(agentos.tools.resolve(agent.definition.tools).map((tool) => tool.id)).toContain(
      'terminal.exec',
    );
  });

  it('snapshots the effective configuration onto the run for reproducibility', async () => {
    const agentos = await agentOSFor([{ text: 'nothing to do' }]);
    const agent = agentos.agent({
      id: 'developer',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['filesystem'],
      limits: { maxSteps: 7, maxCostUsd: 1 },
      permissions: { filesystem: { read: true, write: true }, network: { enabled: false } },
    });

    const run = await agent.createRun({ goal: 'Inspect the repository' });

    expect(run.config.agentId).toBe('developer');
    expect(run.config.agentVersion).toBe('1.0.0');
    expect(run.config.model).toBe('fake-1');
    expect(run.config.limits).toEqual({ maxSteps: 7, maxCostUsd: 1 });
    expect(run.config.permissions.filesystem).toEqual({ read: true, write: true });
    expect(run.config.permissions.network).toEqual({ enabled: false });
    expect(run.config.tools).toEqual(['filesystem.*']);
  });

  it('lets a run narrow its definition permissions but never widen them', async () => {
    const agentos = await agentOSFor([{ text: 'nothing to do' }]);
    const agent = agentos.agent({
      id: 'developer',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['filesystem'],
      permissions: { filesystem: { read: true, write: false }, network: { enabled: false } },
    });

    // Asking for more than the definition granted gets the intersection, not
    // the request: a run cannot hand itself a capability (spec §21, §47).
    const widened = await agent.createRun({
      goal: 'Try to widen',
      permissions: { filesystem: { read: true, write: true }, network: { enabled: true } },
    });
    expect(widened.config.permissions.filesystem).toEqual({ read: true, write: false });
    expect(widened.config.permissions.network).toEqual({ enabled: false });

    const narrowed = await agent.createRun({
      goal: 'Narrow',
      permissions: { filesystem: { read: true } },
    });
    expect(narrowed.config.permissions.filesystem).toEqual({ read: true, write: false });
  });

  it('registers a custom tool defined with defineTool and executes it', async () => {
    const agentos = await agentOSFor([
      {
        text: 'checking the weather',
        toolCalls: [{ name: 'weather.get', arguments: { city: 'Nairobi' } }],
      },
      { text: 'it is warm' },
    ]);
    const weather = defineTool({
      id: 'weather.get',
      description: 'Get the current weather for a city',
      input: z.object({ city: z.string() }),
      risk: 'LOW',
      permissions: { network: { enabled: true } },
      async execute(input: { city: string }) {
        return { city: input.city, temperatureC: 24 };
      },
    });
    agentos.tools.register(weather);
    const agent = agentos.agent({
      id: 'weather-agent',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['weather.get'],
      permissions: { network: { enabled: true } },
      planning: false,
      verification: false,
    });

    const result = await agent.run({ goal: 'What is the weather in Nairobi?' });

    expect(result.success).toBe(true);
    const invocations = await agentos.store.invocations.list(result.runId);
    expect(invocations.map((entry) => entry.toolId)).toEqual(['weather.get']);
    expect(invocations[0]?.status).toBe('succeeded');
  });

  it('refuses a run without a tenant instead of silently defaulting', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kazi-sdk-'));
    os = await createAgentOS({
      dataDir: dir,
      providersFromEnv: false,
      providers: [new FakeModelProvider({ turns: [{ text: 'no' }] })],
      logger: new NullLogger(),
    });
    const agent = os.agent({ id: 'tenantless', model: { provider: 'fake', model: 'fake-1' } });
    await expect(agent.run({ goal: 'go' })).rejects.toThrow(/organizationId/);
  });

  it('lets an agent replace the planner without touching the runtime', async () => {
    const agentos = await agentOSFor(WRITE_AND_FINISH);
    let created = 0;
    const planner: Planner = {
      id: 'test.fixed',
      async createPlan(context): Promise<Plan> {
        created += 1;
        return {
          id: newPlanId(),
          objective: context.goal,
          version: 1,
          createdAt: Date.now(),
          steps: [
            { id: newStepId(), index: 0, description: 'Write result.txt', status: 'pending' },
          ],
        };
      },
      async revisePlan(_context, previousPlan) {
        return { ...previousPlan, version: previousPlan.version + 1 };
      },
    };
    const agent = agentos.agent({
      id: 'planned-agent',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['filesystem'],
      planner,
    });

    const run = await agent.createRun({ goal: 'Write result.txt' });
    await agent.start(run.id);

    expect(created).toBe(1);
    const state = await agent.getState(run.id);
    expect(state.plan?.steps[0]?.description).toBe('Write result.txt');
    const trace = await agent.getTrace(run.id);
    expect(trace.nodes.some((node) => node.kind === 'plan' || node.label.includes('Plan'))).toBe(
      true,
    );
  });

  it('exposes agent operations (pause, resume, cancel) through the SDK', async () => {
    const agentos = await agentOSFor([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
    const agent = agentos.agent({ id: 'ops-agent', model: { provider: 'fake', model: 'fake-1' } });

    const run = await agent.createRun({ goal: 'Do some work' });
    await agent.cancel(run.id);

    expect((await agent.getRun(run.id)).status).toBe('CANCELLED');
  });
});

describe('agent definition durability', () => {
  it('persists a registered definition so it resolves after a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kazi-defs-'));
    const options = {
      dataDir,
      organizationId: 'org_test',
      projectId: 'prj_test',
      providersFromEnv: false,
      providers: [new FakeModelProvider({ turns: [], onExhausted: { text: 'done' } })],
      logger: new NullLogger(),
    };
    const first = await createAgentOS(options);
    await first
      .agent({ id: 'developer', version: '1.2.0', model: { provider: 'fake', model: 'fake-1' } })
      .register();
    await first.close();

    const second = await createAgentOS(options);
    try {
      const records = await second.store.agentDefinitions.list('org_test', 'prj_test');
      expect(records.map((record) => `${record.id}@${record.version}`)).toContain('developer@1.2.0');
      expect(records[0]?.name).toBe('developer');
      const resolved = await second.runtime.agents.get('org_test', 'developer');
      expect(resolved.version).toBe('1.2.0');
    } finally {
      await second.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * A run request may narrow the agent definition but never widen it. Before this
 * was enforced, a caller who could create a run could hand themselves a
 * capability the definition deliberately withheld — including the opt-in that
 * lets an isolation-requiring tool run on a host-process environment (spec §15,
 * §21).
 */
describe('a run request cannot widen the agent definition', () => {
  async function agentFor(permissions: ToolPermissions) {
    const dataDir = mkdtempSync(join(tmpdir(), 'kazi-sdk-perms-'));
    const os = await createAgentOS({
      dataDir,
      organizationId: 'org_test',
      projectId: 'prj_test',
      providersFromEnv: false,
      providers: [new FakeModelProvider({ turns: [], onExhausted: { text: 'done' } })],
      logger: new NullLogger(),
    });
    const agent = os.agent({
      id: 'narrow-agent',
      model: { provider: 'fake', model: 'fake-1' },
      tools: ['terminal'],
      permissions,
    });
    await agent.register();
    return { os, agent, dataDir };
  }

  it('refuses an allow_unisolated grant the definition did not give', async () => {
    const { os, agent, dataDir } = await agentFor({
      terminal: { execute: true },
    });
    try {
      const run = await agent.createRun({
        goal: 'Run a command',
        permissions: { terminal: { execute: true, allowUnisolated: true } },
      });
      expect(run.config.permissions.terminal?.allowUnisolated).toBe(false);
    } finally {
      await os.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('still lets a request narrow a family the definition granted', async () => {
    const { os, agent, dataDir } = await agentFor({
      filesystem: { read: true, write: true },
      terminal: { execute: true, allowUnisolated: true },
    });
    try {
      const run = await agent.createRun({
        goal: 'Read only',
        permissions: { filesystem: { read: true, write: false } },
      });
      expect(run.config.permissions.filesystem).toMatchObject({ read: true, write: false });
      // A family the request stayed silent about keeps the definition's grant.
      expect(run.config.permissions.terminal?.allowUnisolated).toBe(true);
    } finally {
      await os.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
