import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NullLogger,
  type AgentRunResult,
  type AgentTool,
  type ModelProvider,
  type RunLimits,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeProviderOptions, type FakeTurn } from '@kazi-ai/agentos-providers';
import type { AgentOptions } from '@kazi-ai/agentos';
import type { Chaos } from './chaos.js';

export interface TestAgentOSOptions {
  turns: FakeTurn[];
  onExhausted?: FakeProviderOptions['onExhausted'];
  tools?: string[];
  permissions?: ToolPermissions;
  limits?: RunLimits;
  /** Extra tools registered alongside the built-ins. */
  extraTools?: AgentTool[];
  /** Providers registered alongside the scripted fake, e.g. a failover target. */
  extraProviders?: ModelProvider[];
  /** Anything else `createAgentOS` accepts, e.g. `mcp`, `approvals`, `policyRules`. */
  overrides?: Partial<Parameters<typeof createAgentOS>[0]>;
  agent?: Partial<AgentOptions>;
  /** Planning consumes model turns; tests that script turns usually want it off. */
  planning?: boolean;
  verification?: boolean;
  /**
   * Route the provider and every extra tool through a chaos injector
   * (spec §88). The store is wrapped by the test itself, because it is built
   * before this helper runs.
   */
  chaos?: Chaos;
}

export interface TestAgentRun {
  id: string;
  status: string;
  workspaceDir: string;
  result: AgentRunResult;
}

export interface TestAgentOS {
  os: AgentOS;
  provider: FakeModelProvider;
  dataDir: string;
  /** Run a goal with the configured agent and return the finished run. */
  run(
    goal: string,
    overrides?: { limits?: RunLimits; permissions?: ToolPermissions },
  ): Promise<TestAgentRun>;
  cleanup(): Promise<void>;
}

/**
 * A real AgentOS — real store, real runtime, real tools, real policy engine —
 * with a deterministic provider standing in for the model. Everything the
 * security and end-to-end suites assert happens through the same code path a
 * deployment uses; only the model is scripted.
 */
export async function createTestAgentOS(options: TestAgentOSOptions): Promise<TestAgentOS> {
  const dataDir = mkdtempSync(join(tmpdir(), 'kazi-e2e-'));
  const provider = new FakeModelProvider({
    turns: options.turns,
    ...(options.onExhausted === undefined ? {} : { onExhausted: options.onExhausted }),
  });
  const chaos = options.chaos;
  const registeredTools = (options.extraTools ?? []).map((tool) => (chaos ? chaos.tool(tool) : tool));

  const os = await createAgentOS({
    dataDir,
    driver: 'memory',
    organizationId: 'org_test',
    projectId: 'prj_test',
    providersFromEnv: false,
    providers: [chaos ? chaos.provider(provider) : provider, ...(options.extraProviders ?? [])],
    logger: new NullLogger(),
    tools: registeredTools,
    environment: {
      kind: 'local',
      workspaceRoot: join(dataDir, 'workspaces'),
      snapshotStoreRoot: join(dataDir, 'snapshots'),
    },
    ...(options.overrides ?? {}),
  });

  const agent = os.agent({
    id: 'security-agent',
    model: { provider: 'fake', model: 'fake-1' },
    tools: options.tools ?? ['filesystem', 'terminal'],
    // These suites script the model turn by turn, so the runtime's own
    // planning and verification steps are off unless a test asks for them.
    planning: options.planning ?? false,
    verification: options.verification ?? false,
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.agent ?? {}),
  });
  await agent.register();

  return {
    os,
    provider,
    dataDir,
    async run(goal, overrides = {}) {
      const result = await agent.run({
        goal,
        ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
        ...(overrides.permissions === undefined ? {} : { permissions: overrides.permissions }),
      });
      const finished = await os.runtime.getRun(result.runId);
      return {
        id: finished.id,
        status: finished.status,
        workspaceDir: finished.workspaceDir,
        result,
      };
    },
    async cleanup() {
      await os.close().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
