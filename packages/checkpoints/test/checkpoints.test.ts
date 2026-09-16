import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyUsage,
  idempotencyKey,
  newActionId,
  newRunId,
  type AgentRun,
  type AgentState,
  type EnvironmentSnapshot,
  type JournalEntry,
  type RunConfigSnapshot,
} from '@kazi-ai/agentos-core';
import { EmbeddedStore } from '@kazi-ai/agentos-persistence';
import { CheckpointManager, DEFAULT_CHECKPOINT_POLICY, shouldCheckpoint } from '../src/index.js';

const config: RunConfigSnapshot = {
  agentId: 'developer',
  model: 'test-model',
  provider: 'fake',
  tools: ['filesystem.read'],
  limits: { maxSteps: 10 },
  permissions: {},
  memoryEnabled: true,
  planningEnabled: true,
  verificationEnabled: true,
  recoveryEnabled: true,
};

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  const now = Date.now();
  return {
    id: newRunId(),
    goal: 'Fix the failing tests',
    agentId: 'developer',
    organizationId: 'org_1',
    projectId: 'prj_1',
    status: 'PLANNING',
    stateVersion: 3,
    createdAt: now,
    updatedAt: now,
    config,
    limits: { maxSteps: 10 },
    usage: emptyUsage(),
    rootRunId: 'run_root',
    traceId: 'trc_1',
    workspaceDir: '/tmp/ws',
    ...overrides,
  };
}

function makeState(run: AgentRun, overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: run.id,
    status: 'PLANNING',
    stateVersion: run.stateVersion,
    usage: emptyUsage(),
    context: { objective: run.goal, memoryRefs: ['mem_1'] },
    observations: [
      {
        id: 'obs_1',
        at: 1,
        source: 'tool',
        trust: 'untrusted-tool',
        summary: 'read package.json',
      },
    ],
    updatedAt: Date.now(),
    ...overrides,
  };
}

function committedEntry(runId: string, toolId: string): JournalEntry {
  return {
    id: `jrn_${toolId}`,
    runId,
    sequence: 1,
    actionId: newActionId(),
    idempotencyKey: idempotencyKey({ runId, toolId, arguments: {} }),
    toolId,
    argumentsHash: 'hash',
    status: 'succeeded',
    attempt: 0,
    startedAt: 1,
    finishedAt: 2,
  };
}

async function createHarness(options: {
  policy?: Partial<typeof DEFAULT_CHECKPOINT_POLICY>;
  captureEnvironment?: (input: { run: AgentRun; state: AgentState }) => Promise<EnvironmentSnapshot | undefined>;
} = {}): Promise<{ manager: CheckpointManager; store: EmbeddedStore; run: AgentRun; state: AgentState }> {
  const store = new EmbeddedStore();
  await store.init();
  const manager = new CheckpointManager({
    store: store.checkpoints,
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.captureEnvironment ? { captureEnvironment: options.captureEnvironment } : {}),
  });
  const run = makeRun();
  return { manager, store, run, state: makeState(run) };
}

describe('shouldCheckpoint', () => {
  const base = { now: 1_000, stepsSinceCheckpoint: 0 };

  it('always honours explicit and structural triggers', () => {
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'manual' }).checkpoint).toBe(true);
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'run_created' }).checkpoint).toBe(true);
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'after_plan' }).checkpoint).toBe(true);
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'before_pause' }).checkpoint).toBe(true);
  });

  it('respects disabled triggers', () => {
    const policy = { ...DEFAULT_CHECKPOINT_POLICY, afterPlan: false };
    const decision = shouldCheckpoint(policy, { ...base, trigger: 'after_plan' });
    expect(decision.checkpoint).toBe(false);
    expect(decision.reason).toContain('disabled');
  });

  it('checkpoints before risky actions but not before routine ones', () => {
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'before_risky_action', risk: 'CRITICAL' }).checkpoint).toBe(true);
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'before_risky_action', risk: 'LOW' }).checkpoint).toBe(false);
    expect(shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, { ...base, trigger: 'before_risky_action' }).checkpoint).toBe(false);
  });

  it('treats a labelled trigger as risky regardless of the risk level', () => {
    const decision = shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, {
      ...base,
      trigger: 'before_risky_action',
      risk: 'LOW',
      label: 'release',
    });
    expect(decision.checkpoint).toBe(true);
    expect(decision.reason).toContain('labelled');
  });

  it('fires periodic checkpoints on elapsed time or step count', () => {
    const byTime = shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, {
      trigger: 'periodic',
      now: 100_000,
      lastCheckpointAt: 1_000,
      stepsSinceCheckpoint: 1,
    });
    expect(byTime.checkpoint).toBe(true);
    expect(byTime.reason).toContain('interval');

    const bySteps = shouldCheckpoint(
      { ...DEFAULT_CHECKPOINT_POLICY, intervalMs: undefined },
      { trigger: 'periodic', now: 2_000, lastCheckpointAt: 1_999.5, stepsSinceCheckpoint: 10 },
    );
    expect(bySteps.checkpoint).toBe(true);
    expect(bySteps.reason).toContain('steps');

    const notYet = shouldCheckpoint(DEFAULT_CHECKPOINT_POLICY, {
      trigger: 'periodic',
      now: 2_000,
      lastCheckpointAt: 1_999.5,
      stepsSinceCheckpoint: 2,
    });
    expect(notYet.checkpoint).toBe(false);
  });
});

describe('CheckpointManager', () => {
  it('captures serialized state, a context snapshot and an environment snapshot', async () => {
    const harness = await createHarness({
      captureEnvironment: async ({ run }) => ({
        kind: 'local',
        workspaceDir: run.workspaceDir,
        files: [{ path: 'src/index.ts', sha256: 'a'.repeat(64), size: 12 }],
        capturedAt: Date.now(),
      }),
    });

    const checkpoint = await harness.manager.create({
      run: harness.run,
      state: harness.state,
      committedActions: [committedEntry(harness.run.id, 'filesystem.read')],
      trigger: 'after_plan',
    });

    expect(checkpoint.sequence).toBe(1);
    expect(checkpoint.stateVersion).toBe(3);
    expect(checkpoint.state.organizationId).toBe('org_1');
    expect(checkpoint.state.projectId).toBe('prj_1');
    expect(checkpoint.state.committedActions).toHaveLength(1);
    expect(checkpoint.contextSnapshot.objective).toBe('Fix the failing tests');
    expect(checkpoint.contextSnapshot.memoryRefs).toEqual(['mem_1']);
    expect(checkpoint.contextSnapshot.observations).toHaveLength(1);
    expect(checkpoint.environmentSnapshot?.files).toHaveLength(1);

    const stored = await harness.store.checkpoints.latest(harness.run.id);
    expect(stored?.id).toBe(checkpoint.id);
  });

  it('increments the sequence for each checkpoint and survives a manager restart', async () => {
    const harness = await createHarness();
    await harness.manager.create({ run: harness.run, state: harness.state, trigger: 'manual' });
    await harness.manager.create({ run: harness.run, state: harness.state, trigger: 'manual' });

    const fresh = new CheckpointManager({ store: harness.store.checkpoints });
    const third = await fresh.create({ run: harness.run, state: harness.state, trigger: 'manual' });

    expect(third.sequence).toBe(3);
    expect((await fresh.list(harness.run.id)).map((item) => item.sequence)).toEqual([1, 2, 3]);
  });

  it('skips checkpoints the policy does not ask for', async () => {
    const harness = await createHarness({ policy: { afterToolCall: false } });
    const skipped = await harness.manager.maybeCreate({
      run: harness.run,
      state: harness.state,
      trigger: 'after_tool_call',
    });
    expect(skipped).toBeUndefined();
    expect(await harness.manager.list(harness.run.id)).toHaveLength(0);

    const created = await harness.manager.maybeCreate({ run: harness.run, state: harness.state, trigger: 'after_plan' });
    expect(created?.sequence).toBe(1);
  });

  it('records a pending action for forensics when a risky action is about to run', async () => {
    const harness = await createHarness();
    const pendingAction = {
      id: newActionId(),
      runId: harness.run.id,
      toolId: 'git',
      arguments: { operation: 'push' },
      idempotencyKey: 'idem_push',
      idempotency: 'non-idempotent' as const,
      status: 'pending' as const,
      createdAt: Date.now(),
      attempt: 0,
    };

    const checkpoint = await harness.manager.create({
      run: harness.run,
      state: harness.state,
      trigger: 'before_risky_action',
      risk: 'CRITICAL',
      pendingAction,
    });

    expect(checkpoint.state.pendingAction?.toolId).toBe('git');
    expect(checkpoint.label).toBeUndefined();
  });

  it('prunes old checkpoints but keeps the newest and labelled ones', async () => {
    const harness = await createHarness({ policy: { retain: 3, retainLabelled: true } });
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const checkpoint = await harness.manager.create({
        run: harness.run,
        state: harness.state,
        trigger: 'manual',
        ...(index === 1 ? { label: 'release-candidate' } : {}),
      });
      ids.push(checkpoint.id);
    }

    const remaining = await harness.manager.list(harness.run.id);
    // 3 newest (sequences 4,5,6) plus the protected labelled checkpoint (2).
    expect(remaining.map((item) => item.sequence)).toEqual([2, 4, 5, 6]);
    expect(remaining.map((item) => item.id)).toContain(ids[1]);
  });

  it('restores state and environment from a checkpoint', async () => {
    const restored: EnvironmentSnapshot[] = [];
    const store = new EmbeddedStore();
    await store.init();
    const run = makeRun();
    const state = makeState(run);
    const manager = new CheckpointManager({
      store: store.checkpoints,
      captureEnvironment: async () => ({ kind: 'local', workspaceDir: run.workspaceDir, capturedAt: 1 }),
      restoreEnvironment: async (snapshot) => {
        restored.push(snapshot);
      },
    });

    const checkpoint = await manager.create({ run, state, trigger: 'manual' });
    const result = await manager.restore(checkpoint.id);

    expect(result.state.runId).toBe(run.id);
    expect(result.state.goal).toBe('Fix the failing tests');
    expect(result.environmentRestored).toBe(true);
    expect(restored).toHaveLength(1);
  });

  it('forks a checkpoint into a new run without touching the original', async () => {
    const harness = await createHarness();
    const checkpoint = await harness.manager.create({
      run: harness.run,
      state: harness.state,
      trigger: 'manual',
    });

    const fork = await harness.manager.fork(checkpoint.id, { goal: 'Try a different approach' });

    expect(fork.input.goal).toBe('Try a different approach');
    expect(fork.input.agentId).toBe('developer');
    expect(fork.input.organizationId).toBe('org_1');
    expect(fork.input.projectId).toBe('prj_1');
    expect(fork.input.parentRunId).toBe(harness.run.id);
    expect(fork.input.metadata?.['forkedFrom']).toEqual({
      runId: harness.run.id,
      checkpointId: checkpoint.id,
      sequence: checkpoint.sequence,
    });
    expect(await harness.manager.list(harness.run.id)).toHaveLength(1);
  });

  it('keeps the state checkpoint when the environment snapshot fails', async () => {
    const harness = await createHarness({
      captureEnvironment: async () => {
        throw new Error('docker daemon unavailable');
      },
    });

    const checkpoint = await harness.manager.create({ run: harness.run, state: harness.state, trigger: 'manual' });

    expect(checkpoint.environmentSnapshot).toBeUndefined();
    expect(checkpoint.state.goal).toBe('Fix the failing tests');
  });

  it('restores a checkpoint written by a different process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kazi-cp-'));
    const first = new EmbeddedStore({ dir: join(dir, 'store') });
    await first.init();
    const run = makeRun();
    const checkpoint = await new CheckpointManager({ store: first.checkpoints }).create({
      run,
      state: makeState(run),
      trigger: 'manual',
    });
    await first.close();

    const second = new EmbeddedStore({ dir: join(dir, 'store') });
    await second.init();
    const reloaded = await new CheckpointManager({ store: second.checkpoints }).get(checkpoint.id);
    expect(reloaded.state.stateVersion).toBe(run.stateVersion);
    expect(reloaded.id).toBe(checkpoint.id);
  });
});
