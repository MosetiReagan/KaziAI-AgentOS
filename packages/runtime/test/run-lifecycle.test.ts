import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyUsage } from '@kazi-ai/agentos-core';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('AgentOSRuntime run lifecycle', () => {
  it('executes a real multi-step run: read a file, edit it, then complete', async () => {
    harness = await createHarness({
      turns: [
        { text: 'Inspecting the workspace.', toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }] },
        { text: 'Reading the greeting.', toolCalls: [{ name: 'filesystem.read', arguments: { path: 'greeting.txt' } }] },
        {
          text: 'Rewriting the greeting.',
          toolCalls: [{ name: 'filesystem.write', arguments: { path: 'greeting.txt', content: 'hello kazi\n' } }],
        },
        { text: 'Done: the greeting now says hello kazi.' },
      ],
      limits: { maxSteps: 12 },
    });

    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Make the greeting say hello kazi' }));
    expect(run.status).toBe('CREATED');
    writeFileSync(join(run.workspaceDir, 'greeting.txt'), 'hello world\n');
    await harness.runtime.start(run.id);

    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.usage.steps).toBeGreaterThanOrEqual(4);
    expect(finished.usage.toolCalls).toBe(3);
    expect(finished.usage.modelCalls).toBeGreaterThanOrEqual(4);
    expect(finished.usage.tokens.totalTokens).toBeGreaterThan(0);
    expect(finished.finishedAt).toBeDefined();

    // The agent really did change the world, through real tools.
    const written = readFileSync(join(finished.workspaceDir, 'greeting.txt'), 'utf8');
    expect(written).toBe('hello kazi\n');

    // A completed run has a queryable state, trace and result.
    const state = await harness.runtime.getState(run.id);
    expect(state.status).toBe('COMPLETED');
    const trace = await harness.runtime.getTrace(run.id);
    expect(trace.nodes.length).toBeGreaterThan(0);
    expect(trace.summary.toolCalls).toBe(3);

    const result = await harness.runtime.result(run.id);
    expect(result.success).toBe(true);
    expect(result.runId).toBe(run.id);
    expect(result.toolCalls).toBe(3);
    expect(result.traceId).toBe(run.traceId);
  });

  it('persists a run event stream that reconstructs the execution (spec §48)', async () => {
    harness = await createHarness({
      turns: [
        { text: 'write', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'a' } }] },
        { text: 'finished' },
      ],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);

    const events = await harness.store.events.list(run.id);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('run.started');
    expect(types).toContain('tool.requested');
    expect(types).toContain('tool.completed');
    expect(types).toContain('run.completed');
    // Durable sequencing, so the stream is replayable in order.
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.map((event) => event.sequence)].sort((left, right) => left - right),
    );
    expect(events.every((event) => event.version !== undefined)).toBe(true);
  });

  it('decodes provider wire tool names (dot namespacing) before dispatch', async () => {
    harness = await createHarness({
      turns: [
        { text: 'read it', toolCalls: [{ name: 'filesystem__read', arguments: { path: 'note.txt' } }] },
        { text: 'done' },
      ],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    mkdirSync((await harness.runtime.getRun(run.id)).workspaceDir, { recursive: true });
    writeFileSync(join((await harness.runtime.getRun(run.id)).workspaceDir, 'note.txt'), 'contents');
    await harness.runtime.start(run.id);

    const invocations = await harness.store.invocations.list(run.id);
    expect(invocations.map((entry) => entry.toolId)).toEqual(['filesystem.read']);
    expect((await harness.runtime.getRun(run.id)).status).toBe('COMPLETED');
  });

  it('records model usage per call for cost attribution', async () => {
    harness = await createHarness({
      turns: [
        {
          text: 'thinking',
          toolCalls: [{ name: 'filesystem.list', arguments: { path: '.' } }],
          usage: { inputTokens: 100, outputTokens: 20 },
        },
        { text: 'done', usage: { inputTokens: 120, outputTokens: 10 } },
      ],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const usage = await harness.store.usage.listByRun(run.id);
    expect(usage).toHaveLength(2);
    expect(usage[0]?.inputTokens).toBe(100);
    expect(usage[1]?.outputTokens).toBe(10);
    const finished = await harness.runtime.getRun(run.id);
    expect(finished.usage.tokens.inputTokens).toBe(220);
  });

  it('rejects a run whose model requests an unavailable tool instead of guessing', async () => {
    harness = await createHarness({
      turns: [{ text: 'use magic', toolCalls: [{ name: 'magic.portal', arguments: {} }] }],
    });
    const run = await harness.runtime.createRun(harness.runInput());
    await harness.runtime.start(run.id);
    const finished = await harness.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error?.['code']).toBe('tool.not_found');
    // The failure is persisted and recoverable, not swallowed.
    const failures = await harness.store.failures.list(run.id);
    expect(failures.length).toBeGreaterThan(0);
    const recoveries = await harness.store.recoveries.list(run.id);
    expect(recoveries.length).toBeGreaterThan(0);
    expect(emptyUsage().steps).toBe(0);
  });

  it('runs the same command again when the agent means to run it again', async () => {
    // Re-running a test suite after an edit is normal work, not a duplicate:
    // the second call sits at a later position in the run, so it is its own
    // action with its own journal entry.
    const testCall = { name: 'terminal.exec', arguments: { command: 'node', args: ['-e', 'process.exit(0)'] } };
    harness = await createHarness({
      turns: [
        { text: 'Running the suite.', toolCalls: [testCall] },
        { text: 'Fixing the file.', toolCalls: [{ name: 'filesystem.write', arguments: { path: 'fix.txt', content: 'fix' } }] },
        { text: 'Running it again.', toolCalls: [testCall] },
        { text: 'Green.' },
      ],
      limits: { maxSteps: 10 },
    });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Run the tests twice' }));
    await harness.runtime.start(run.id);

    expect((await harness.runtime.getRun(run.id)).status).toBe('COMPLETED');
    const invocations = await harness.store.invocations.list(run.id);
    const terminal = invocations.filter((entry) => entry.toolId === 'terminal.exec');
    expect(terminal).toHaveLength(2);
    expect(terminal.every((entry) => entry.success)).toBe(true);
    // Two distinct actions in the journal, so neither was suppressed.
    const journal = await harness.store.actions.list(run.id);
    const intents = journal.filter((entry) => entry.status === 'executing');
    expect(new Set(intents.map((entry) => entry.idempotencyKey)).size).toBe(3);
  });

  it('loads an existing run deterministically after re-reading it from the store', async () => {
    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    const run = await harness.runtime.createRun(harness.runInput({ goal: 'Say nothing' }));
    await harness.runtime.start(run.id);
    const reloaded = await harness.store.runs.get(run.id);
    expect(reloaded?.status).toBe('COMPLETED');
    expect(reloaded?.goal).toBe('Say nothing');
  });
});
