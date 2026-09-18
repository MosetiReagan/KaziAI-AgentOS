import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryLockManager,
  NullLogger,
  type AgentRunInput,
  type AgentTool,
  type LockManager,
  type RunConfigSnapshot,
  type RunLimits,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import { createStore, type AgentOSStore } from '@kazi-ai/agentos-persistence';
import {
  FakeModelProvider,
  ModelProviderRegistry,
  type FakeProviderOptions,
  type FakeTurn,
} from '@kazi-ai/agentos-providers';
import { DefaultToolRegistry, createBuiltinTools } from '@kazi-ai/agentos-tools';
import { AgentOSRuntime } from '../src/index.js';

export const DEFAULT_TOOLS = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.list',
  'filesystem.search',
  'filesystem.edit',
  'terminal.exec',
];

export const DEFAULT_PERMISSIONS: ToolPermissions = {
  filesystem: { read: true, write: true, delete: false },
  // The harness runs the local (host-process) environment, so it has to opt in
  // to isolation-requiring tools out loud. A test that wants the default-deny
  // behaviour overrides these permissions (spec §15).
  terminal: { execute: true, allowUnisolated: true },
  network: { enabled: false },
  git: { read: true, commit: false, push: false },
  database: { read: false, write: false },
};

export interface HarnessOptions {
  turns?: FakeTurn[];
  /** What the fake provider does once the scripted turns run out. */
  onExhausted?: FakeProviderOptions['onExhausted'];
  tools?: string[];
  permissions?: ToolPermissions;
  limits?: RunLimits;
  providerId?: string;
  model?: string;
  runtime?: Partial<ConstructorParameters<typeof AgentOSRuntime>[0]>;
  /** Lock manager to share with another runtime; defaults to a private one. */
  locks?: LockManager;
  /** Additional tools registered alongside the built-ins. */
  extraTools?: AgentTool[];
  dataDir?: string;
}

export interface Harness {
  runtime: AgentOSRuntime;
  provider: FakeModelProvider;
  providers: ModelProviderRegistry;
  store: AgentOSStore;
  rootDir: string;
  workspaceRoot: string;
  runInput(overrides?: Partial<AgentRunInput>): AgentRunInput;
  /** The default run configuration, for tests that need to tweak one switch. */
  defaultConfig(overrides?: Partial<AgentRunInput>): RunConfigSnapshot;
  cleanup(): Promise<void>;
}

/** A real runtime over a real durable store with a deterministic provider. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const rootDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'kazi-runtime-'));
  const storeDir = join(rootDir, 'store');
  const workspaceRoot = join(rootDir, 'workspaces');
  const store = await createStore({ driver: 'memory', dataDir: storeDir });
  const provider = new FakeModelProvider({
    turns: options.turns ?? [],
    ...(options.onExhausted ? { onExhausted: options.onExhausted } : {}),
  });
  const providerId = options.providerId ?? 'fake';
  const model = options.model ?? 'fake-1';
  const providers = new ModelProviderRegistry();
  providers.register(provider);

  const tools = new DefaultToolRegistry(await createBuiltinTools());
  for (const tool of options.extraTools ?? []) tools.register(tool);
  const runtime = new AgentOSRuntime({
    store,
    providers,
    tools,
    logger: new NullLogger(),
    environment: {
      kind: 'local',
      workspaceRoot,
      snapshotStoreRoot: join(rootDir, 'snapshots'),
    },
    // A harness behaves like one process: its own in-memory locks unless the
    // test deliberately shares them to prove mutual exclusion.
    locks: options.locks ?? new InMemoryLockManager(),
    ...options.runtime,
  });

  const config = (overrides: Partial<AgentRunInput> = {}): RunConfigSnapshot => ({
    agentId: overrides.agentId ?? 'test-agent',
    model,
    provider: providerId,
    tools: options.tools ?? DEFAULT_TOOLS,
    limits: { ...(options.limits ?? {}), ...(overrides.limits ?? {}) },
    permissions: overrides.permissions ?? options.permissions ?? DEFAULT_PERMISSIONS,
    memoryEnabled: false,
    planningEnabled: false,
    verificationEnabled: false,
    recoveryEnabled: true,
  });

  return {
    runtime,
    provider,
    providers,
    store,
    rootDir,
    workspaceRoot,
    defaultConfig: config,
    runInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
      const cfg = overrides.config ?? config(overrides);
      return {
        goal: overrides.goal ?? 'Do the thing',
        agentId: overrides.agentId ?? 'test-agent',
        organizationId: overrides.organizationId ?? 'org_test',
        projectId: overrides.projectId ?? 'prj_test',
        config: cfg,
        limits: overrides.limits ?? cfg.limits,
        permissions: overrides.permissions ?? cfg.permissions,
        metadata: overrides.metadata ?? {},
        ...(overrides.parentRunId ? { parentRunId: overrides.parentRunId } : {}),
        ...(overrides.workspace ? { workspace: overrides.workspace } : {}),
      };
    },
    async cleanup() {
      await runtime.close().catch(() => undefined);
      await store.close().catch(() => undefined);
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
