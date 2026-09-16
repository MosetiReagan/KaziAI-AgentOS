import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryLockManager, type AgentTool } from '@kazi-ai/agentos-core';
import { DefaultPolicyEngine, RiskClassifier } from '@kazi-ai/agentos-policies';
import { waitFor } from './helpers.js';
import { createHarness, type Harness } from './harness.js';

let harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses) await harness.cleanup().catch(() => undefined);
  harnesses = [];
});

/**
 * The mandatory durability test (spec §114): a worker executes part of a run,
 * the process disappears, and a *different* runtime built over the same durable
 * store has to finish the job correctly.
 */
describe('crash recovery', () => {
  it('resumes a run after its worker disappears and finishes it correctly', async () => {
    const first = await createHarness({
      turns: [
        { text: 'Step 1: write one.', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'one.txt', content: '1' } }] },
        { text: 'Step 2: write two.', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'two.txt', content: '2' } }] },
        // The worker "dies" here: this call never returns, so the run stops
        // making durable progress mid-flight.
        { text: 'Step 3: hang.', delayMs: 600_000, toolCalls: [{ name: 'filesystem.write', arguments: { path: 'three.txt', content: '3' } }] },
      ],
      limits: { maxSteps: 20 },
    });
    harnesses.push(first);

    const run = await first.runtime.createRun(first.runInput({ goal: 'Write one, two and three' }));
    const abandoned = first.runtime.start(run.id);
    abandoned.catch(() => undefined);

    await waitFor(() => existsSync(`${run.workspaceDir}/two.txt`));
    const crashed = await first.runtime.getRun(run.id);
    expect(['EXECUTING', 'OBSERVING', 'QUEUED']).toContain(crashed.status);
    expect(crashed.usage.modelCalls).toBe(2);
    const checkpointsBeforeCrash = await first.runtime.checkpoints.list(run.id);
    expect(checkpointsBeforeCrash.length).toBeGreaterThan(0);

    // A new worker comes up with nothing but the durable store and workspace.
    const second = await createHarness({
      dataDir: first.rootDir,
      turns: [
        // The agent repeats its first write: the journal must recognise it.
        { text: 'Step 1 again.', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'one.txt', content: '1' } }] },
        { text: 'Step 3: write three.', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'three.txt', content: '3' } }] },
        { text: 'All three files are written.' },
      ],
      limits: { maxSteps: 20 },
    });
    harnesses.push(second);

    await second.runtime.resume(run.id);

    const finished = await second.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.workspaceDir).toBe(run.workspaceDir);
    for (const name of ['one.txt', 'two.txt', 'three.txt']) {
      expect(existsSync(`${finished.workspaceDir}/${name}`)).toBe(true);
    }

    // Usage is cumulative across the crash, not restarted.
    expect(finished.usage.modelCalls).toBe(5);
    expect(finished.usage.steps).toBe(5);

    // The journal is append-only evidence and no *position* executed twice: the
    // durable key that makes a retry idempotent is unique per action.
    const journal = await second.store.actions.list(run.id);
    const commitsByKey = new Map<string, number>();
    for (const entry of journal) {
      if (entry.status !== 'succeeded') continue;
      commitsByKey.set(entry.idempotencyKey, (commitsByKey.get(entry.idempotencyKey) ?? 0) + 1);
    }
    expect(commitsByKey.size).toBeGreaterThan(0);
    expect([...commitsByKey.values()].every((count) => count === 1)).toBe(true);
    const writes = journal.filter((entry) => entry.toolId === 'filesystem.write' && entry.status === 'succeeded');
    expect(writes.length).toBeGreaterThanOrEqual(3);

    // Recovery of the run is visible in its trace.
    const trace = await second.runtime.getTrace(run.id);
    expect(trace.summary.checkpoints).toBeGreaterThanOrEqual(checkpointsBeforeCrash.length);
    const result = await second.runtime.result(run.id);
    expect(result.success).toBe(true);
  });

  it('refuses to double-run a run that another worker is executing', async () => {
    const locks = new InMemoryLockManager();
    const firstWorker = await createHarness({
      turns: [{ text: 'slow', delayMs: 200, toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] }],
      locks,
    });
    harnesses.push(firstWorker);

    const run = await firstWorker.runtime.createRun(firstWorker.runInput());
    // A second worker sharing the lock (same cluster, same run) must not run it.
    const secondWorker = await createHarness({ dataDir: firstWorker.rootDir, turns: [{ text: 'mine' }], locks });
    harnesses.push(secondWorker);
    const running = firstWorker.runtime.start(run.id);
    await expect(secondWorker.runtime.start(run.id)).rejects.toThrow(/Lock already held/);
    await running;

    expect((await firstWorker.runtime.getRun(run.id)).status).toBe('COMPLETED');
    const invocations = await firstWorker.store.invocations.list(run.id);
    expect(invocations.filter((entry) => entry.toolId === 'filesystem.list')).toHaveLength(1);

    // Once finished, starting again is a no-op rather than a second execution.
    await expect(firstWorker.runtime.start(run.id)).resolves.toBeUndefined();
    expect(await firstWorker.store.invocations.list(run.id)).toHaveLength(1);
  });

  it('reports a tool call that was in flight when the worker died', async () => {
    // A tool that never returns: the journal records the intent, the commit
    // never lands, and the next worker must be able to see that.
    const hangTool: AgentTool = {
      id: 'test.hang',
      description: 'Never returns, simulating a worker that dies mid-call',
      kind: 'builtin',
      risk: 'LOW',
      timeoutMs: 600_000,
      inputSchema: z.object({}),
      async execute() {
        return new Promise(() => undefined);
      },
    };
    const policies = new DefaultPolicyEngine({
      classifier: new RiskClassifier([{ id: 'test.tools', description: 'test tools', tool: 'test.*', risk: 'LOW' }]),
    });

    const first = await createHarness({
      turns: [
        { text: 'calling the hanging tool', toolCalls: [{ name: 'test.hang', arguments: {} }] },
        { text: 'never reached', toolCalls: [{ name: 'test.hang', arguments: {} }] },
      ],
      tools: ['test.hang'],
      extraTools: [hangTool],
      runtime: { policies },
    });
    harnesses.push(first);
    const run = await first.runtime.createRun(first.runInput({ goal: 'Call the hanging tool' }));
    const abandoned = first.runtime.start(run.id);
    abandoned.catch(() => undefined);

    await waitFor(async () => {
      const journal = await first!.store.actions.list(run.id);
      return journal.some((entry) => entry.status === 'executing');
    });

    const journal = await first.store.actions.list(run.id);
    const intent = journal.find((entry) => entry.status === 'executing');
    expect(intent?.toolId).toBe('test.hang');
    expect(intent?.idempotency).toBe('unknown');
    // Intent without commit is exactly the evidence recovery needs.
    expect(journal.some((entry) => entry.status === 'succeeded' || entry.status === 'failed')).toBe(false);

    // The next worker runs the same tool catalog, but with no memory of the
    // call that was in flight.
    const second = await createHarness({
      dataDir: first.rootDir,
      turns: [{ text: 'done' }],
      extraTools: [hangTool],
      runtime: { policies },
    });
    harnesses.push(second);
    const recovered = await second.store.actions.list(run.id);
    expect(recovered.find((entry) => entry.status === 'executing')?.id).toBe(intent?.id);

    // The resumed worker completes the run rather than repeating a call whose
    // outcome is unknown.
    await second.runtime.resume(run.id);
    expect((await second.runtime.getRun(run.id)).status).toBe('COMPLETED');
  });

  it('survives a restart in the middle of a checkpoint write', async () => {
    const first = await createHarness({
      turns: [
        { text: 'write', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'durable.txt', content: 'hello' } }] },
        { text: 'hang', delayMs: 600_000, toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] },
      ],
    });
    harnesses.push(first);
    const run = await first.runtime.createRun(first.runInput());
    const abandoned = first.runtime.start(run.id);
    abandoned.catch(() => undefined);
    await waitFor(() => existsSync(`${run.workspaceDir}/durable.txt`));

    // A checkpoint captured before the crash is still readable by the new runtime.
    const latest = await first.store.checkpoints.latest(run.id);
    expect(latest).toBeDefined();
    const second = await createHarness({ dataDir: first.rootDir, turns: [{ text: 'done' }] });
    harnesses.push(second);
    const restored = await second.store.checkpoints.get(String(latest?.id));
    expect(restored?.runId).toBe(run.id);
    expect(restored?.environmentSnapshot).toBeDefined();

    await second.runtime.resume(run.id);
    expect((await second.runtime.getRun(run.id)).status).toBe('COMPLETED');
    expect(readFileSync(`${run.workspaceDir}/durable.txt`, 'utf8')).toBe('hello');
  });

  it("keeps a run's live state durable even with checkpointing switched off", async () => {
    // The strongest form of "no hidden state" (spec §42, §103): without a single
    // checkpoint, a *different* worker must still see how far the run got.
    const first = await createHarness({
      turns: [
        {
          text: 'write one',
          toolCalls: [{ name: 'filesystem.write', arguments: { path: 'live.txt', content: 'live' } }],
        },
        { text: 'the worker dies here', delayMs: 600_000 },
      ],
      runtime: {
        checkpointPolicy: {
          afterPlan: false,
          afterToolCall: false,
          afterStateChange: false,
          beforeRiskyAction: false,
          beforeRecovery: false,
          beforePause: false,
          intervalMs: 0,
          everyNSteps: 0,
        },
      },
    });
    harnesses.push(first);

    const run = await first.runtime.createRun(first.runInput({ goal: 'Write live.txt' }));
    const abandoned = first.runtime.start(run.id);
    abandoned.catch(() => undefined);
    await waitFor(() => existsSync(`${run.workspaceDir}/live.txt`));

    expect(await first.store.checkpoints.list(run.id)).toHaveLength(0);

    const second = await createHarness({ dataDir: first.rootDir, turns: [{ text: 'done' }] });
    harnesses.push(second);
    const state = await second.runtime.getState(run.id);
    expect(state.usage.modelCalls).toBe(1);
    expect(state.observations.length).toBeGreaterThan(0);
    expect(state.observations[0]?.source).toBe('tool');
    expect(state.observations.map((observation) => observation.summary).join(' ')).toContain('filesystem.write');

    await second.runtime.resume(run.id);
    expect((await second.runtime.getRun(run.id)).status).toBe('COMPLETED');
  });

  it('keeps tenant data isolated across a restart', async () => {
    const first = await createHarness({ turns: [{ text: 'one' }] });
    harnesses.push(first);
    const orgA = await first.runtime.createRun(first.runInput({ organizationId: 'org_a', goal: 'A' }));
    await first.runtime.start(orgA.id);

    const second = await createHarness({ dataDir: first.rootDir, turns: [{ text: 'two' }] });
    harnesses.push(second);
    await second.runtime.start(orgA.id); // already terminal, no-op

    const runsForB = await second.runtime.listRuns({ organizationId: 'org_b' });
    expect(runsForB).toHaveLength(0);
    const runsForA = await second.runtime.listRuns({ organizationId: 'org_a' });
    expect(runsForA.map((entry) => entry.id)).toEqual([orgA.id]);
    rmSync(`${first.rootDir}/workspaces/org_a`, { recursive: true, force: true });
  });
});
