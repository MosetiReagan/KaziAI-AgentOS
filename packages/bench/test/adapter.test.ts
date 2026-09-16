import { afterEach, describe, expect, it } from 'vitest';
import type { RunConfigSnapshot } from '@kazi-ai/agentos-core';
import { BenchAdapter, BenchRunner, parseBenchCase, type BenchRuntime } from '../src/index.js';
import { createHarness, type Harness } from '../../runtime/test/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/**
 * The real launcher: the case's agent gets the harness's default tools and
 * permissions, exactly like a Bench CLI would resolve them from an agent
 * definition.
 */
function runnerFor(harnessInstance: Harness): BenchRunner {
  return new BenchRunner({
    runtime: harnessInstance.runtime as BenchRuntime,
    adapter: new BenchAdapter({ store: harnessInstance.store }),
    buildRunInput: (benchCase) => {
      const base = harnessInstance.runInput({ goal: benchCase.goal, agentId: benchCase.agentId });
      if (benchCase.tools.length === 0 || base.config === undefined) return base;
      const config: RunConfigSnapshot = { ...base.config, tools: [...benchCase.tools] };
      return { ...base, config };
    },
    pollIntervalMs: 5,
    timeoutMs: 30_000,
  });
}

describe('KaziAI Bench adapter', () => {
  it('exports a real run with trajectory, metrics and score', async () => {
    harness = await createHarness({
      turns: [
        { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'auth.ts', content: 'export const ok = true;\n' } }] },
        { text: 'done' },
      ],
      limits: { maxSteps: 10 },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Write auth.ts' }));
    await harness.runtime.start(run.id);
    const adapter = new BenchAdapter({ store: harness.store });
    const exported = await adapter.exportRun(run.id, { caseId: 'coding.write-auth' });

    expect(exported.version).toBe(1);
    expect(exported.caseId).toBe('coding.write-auth');
    expect(exported.runId).toBe(run.id);
    expect(exported.success).toBe(true);
    expect(exported.caseSuccess).toBe(true);
    expect(exported.metrics.toolCalls).toBe(1);
    expect(exported.result.traceId).toBe(run.traceId);
    expect(exported.trajectory.toolCalls.map((call) => call.toolId)).toEqual(['filesystem.write']);
    expect(exported.trajectory.failures).toEqual([]);
    expect(exported.trajectory.recovery).toEqual([]);
    expect(exported.score.components).toHaveLength(4);

    // NDJSON round-trip is lossless for the fields Bench consumes.
    const jsonl = adapter.toJsonl([exported]);
    expect(jsonl.endsWith('\n')).toBe(true);
    const [parsed] = BenchAdapter.parseJsonl(jsonl);
    expect(parsed?.runId).toBe(run.id);
    expect(parsed?.metrics.toolCalls).toBe(1);
    expect(parsed?.trajectory.toolCalls).toHaveLength(1);
  });

  it('summarises a dataset of exports', async () => {
    harness = await createHarness({
      turns: [
        { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
        { text: 'done' },
      ],
    });
    const adapter = new BenchAdapter({ store: harness.store });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const exported = await adapter.exportRun(run.id, { caseId: 'case-1' });
    const summary = adapter.summarize([exported, { ...exported, caseId: 'case-2', caseSuccess: false }]);
    expect(summary.cases).toBe(2);
    expect(summary.runs).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.passRate).toBe(0.5);
    expect(summary.totalToolCalls).toBe(2);
    expect(summary.averageSteps).toBeGreaterThan(0);
  });

  it('refuses to export a run that does not exist', async () => {
    harness = await createHarness();
    const adapter = new BenchAdapter({ store: harness.store });
    await expect(adapter.exportRun('run_missing')).rejects.toThrow(/does not exist/);
  });

  it('rejects an export from an incompatible format version', () => {
    expect(() => BenchAdapter.parseJsonl('{"version":99,"runId":"run_1"}')).toThrow(/Unsupported Bench export version/);
  });
});

describe('Bench case runner', () => {
  it('runs a case, grades the workspace, and reports expectations', async () => {
    harness = await createHarness({
      turns: [
        { text: 'cloning greeting', toolCalls: [{ name: 'filesystem.read', arguments: { path: 'greeting.txt' } }] },
        { text: 'writing', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'greeting.copy.txt', content: 'hello bench\n' } }] },
        { text: 'done' },
      ],
    });

    const exported = await runnerFor(harness).runCase({
      id: 'coding.copy-greeting',
      name: 'Copy the greeting',
      goal: 'Copy greeting.txt to greeting.copy.txt',
      agentId: 'test-agent',
      tools: ['filesystem.read', 'filesystem.write', 'filesystem.list'],
      setup: { files: [{ path: 'greeting.txt', content: 'hello bench\n' }] },
      expectations: {
        files: [
          { path: 'greeting.copy.txt', exists: true, contains: 'hello bench' },
          { path: 'greeting.txt', contains: 'hello bench' },
        ],
      },
    });

    expect(exported.caseId).toBe('coding.copy-greeting');
    expect(exported.success).toBe(true);
    expect(exported.caseSuccess).toBe(true);
    expect(exported.expectations.map((expectation) => expectation.name)).toContain('run completed');
    expect(exported.expectations.every((expectation) => expectation.passed)).toBe(true);
    // The agent's own claim is irrelevant: the case passed because the file is there.
    expect(exported.trajectory.toolCalls).toHaveLength(2);
  });

  it('fails the case when the agent does not produce what was expected', async () => {
    harness = await createHarness({
      turns: [{ text: 'claiming success without doing anything' }],
    });

    const exported = await runnerFor(harness).runCase({
      id: 'coding.write-missing-file',
      name: 'Write a file the agent never writes',
      goal: 'Write required.txt',
      agentId: 'test-agent',
      tools: ['filesystem.write', 'filesystem.list'],
      expectations: { files: [{ path: 'required.txt', exists: true }] },
      setup: { files: [{ path: 'input.txt', content: 'input' }] },
    });

    expect(exported.success).toBe(true);
    expect(exported.caseSuccess).toBe(false);
    const failure = exported.expectations.find((expectation) => !expectation.passed);
    expect(failure?.name).toContain('required.txt');
    expect(failure?.detail).toBe('the file is missing');
  });

  it('requires a passing verification when the case asks for one', async () => {
    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    const exported = await runnerFor(harness).runCase({
      id: 'coding.needs-verification',
      name: 'A case that demands verification evidence',
      goal: 'Do nothing but prove it',
      agentId: 'test-agent',
      expectations: { verification: 'required' },
    });
    expect(exported.caseSuccess).toBe(false);
    expect(exported.expectations.find((expectation) => expectation.name.includes('verification'))?.passed).toBe(false);
  });

  it('builds the command Bench invokes to launch an AgentOS agent', async () => {
    harness = await createHarness();
    const command = runnerFor(harness).launchCommand({
      id: 'coding.fix-auth',
      name: 'Fix auth',
      goal: 'Fix the failing auth tests',
      agentId: 'coding-agent',
    });
    expect(command).toBe('kazi-agent run coding-agent --goal "Fix the failing auth tests" --case coding.fix-auth');
  });

  it('validates case definitions', () => {
    expect(() => parseBenchCase({ id: 'x' })).toThrow();
    const parsed = parseBenchCase({ id: 'x', name: 'X', goal: 'Do it', agentId: 'agent' });
    expect(parsed.tags).toEqual([]);
    expect(parsed.expectations.verification).toBe('optional');
  });
});
