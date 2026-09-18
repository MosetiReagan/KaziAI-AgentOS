import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@kazi-ai/agentos';
import type { TestAgentOS } from '../helpers/agentos.js';
import { createTestAgentOS } from '../helpers/agentos.js';

let env: TestAgentOS | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

/** What the runtime recorded about a tool call the agent attempted. */
async function outcomeOf(env: TestAgentOS, runId: string, toolId: string) {
  const journal = await env.os.store.actions.list(runId);
  const entry = journal.filter((item) => item.toolId === toolId).at(-1);
  const decisions = await env.os.store.policyDecisions.list(runId);
  const decision = decisions.filter((item) => item.toolId === toolId).at(-1);
  const failures = await env.os.store.failures.list(runId);
  const failure = failures.filter((item) => item.toolId === toolId).at(-1);
  return { entry, decision, failure };
}

describe('an agent cannot reach the host it runs on (spec §15, §115)', () => {
  it('is refused the terminal by default, before the command is ever spawned', async () => {
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'terminal.exec', arguments: { command: 'cat', args: ['/etc/passwd'] } }] },
        { text: 'I could not read the host password file.' },
      ],
      tools: ['filesystem', 'terminal'],
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Read /etc/passwd and report what you find.');

    const { decision, failure } = await outcomeOf(env, run.id, 'terminal.exec');
    expect(decision?.outcome).toBe('DENY');
    expect(decision?.ruleId).toBe('deny.sandbox.unisolated');
    expect(decision?.risk).toBe('HIGH');
    // Denied means denied: nothing was invoked. The denial is still recorded
    // as a failure, because a refusal is information the operator needs
    // (spec §104) — it is just not a *tool* failure.
    expect(failure?.category).toBe('policy');
    const invocations = await env.os.store.invocations.list(run.id);
    expect(invocations.some((item) => item.toolId === 'terminal.exec')).toBe(false);

    // Nothing about the host leaked into what the model was told.
    const events = await env.os.store.events.list(run.id);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain('tool.denied');
    expect(serialized).not.toContain('root:x:0:0');
  });

  it('runs the command once the operator grants host execution out loud', async () => {
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'terminal.exec', arguments: { command: 'node', args: ['-e', 'console.log("sandboxed")'] } }] },
        { text: 'Ran the command.' },
      ],
      tools: ['filesystem', 'terminal'],
      permissions: {
        filesystem: { read: true, write: true, delete: false },
        terminal: { execute: true, allowUnisolated: true },
        network: { enabled: false },
      },
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Run a harmless command.');

    const { decision } = await outcomeOf(env, run.id, 'terminal.exec');
    expect(decision?.outcome).toBe('ALLOW');
    const invocations = await env.os.store.invocations.list(run.id);
    expect(invocations.find((item) => item.toolId === 'terminal.exec')?.success).toBe(true);
  });

  it('does not let the agent hand itself the isolation opt-in at request time', async () => {
    // A tool can refuse a grant but can never grant one: the runtime merges the
    // agent definition with the request, and the request cannot widen it.
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'terminal.exec', arguments: { command: 'cat', args: ['/etc/passwd'] } }] },
        { text: 'stopped' },
      ],
      tools: ['filesystem', 'terminal'],
      permissions: {
        filesystem: { read: true, write: true, delete: false },
        terminal: { execute: true },
        network: { enabled: false },
      },
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Read /etc/passwd.', {
      permissions: {
        filesystem: { read: true, write: true, delete: false },
        terminal: { execute: true, allowUnisolated: true },
        network: { enabled: false },
      },
    });

    const { decision } = await outcomeOf(env, run.id, 'terminal.exec');
    expect(decision?.outcome).toBe('DENY');
  });
});

describe('the workspace is a boundary, not a suggestion (spec §16, §115)', () => {
  it('refuses to read outside the run workspace', async () => {
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'filesystem.read', arguments: { path: '../../../../etc/passwd' } }] },
        { toolCalls: [{ name: 'filesystem.read', arguments: { path: '/etc/passwd' } }] },
        { text: 'The workspace boundary stopped me.' },
      ],
      tools: ['filesystem'],
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Read the host password file.');

    const failures = await env.os.store.failures.list(run.id);
    const reads = failures.filter((item) => item.toolId === 'filesystem.read');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const failure of reads) {
      expect(failure.message).toMatch(/outside|workspace|escapes/i);
    }
    expect(JSON.stringify(reads)).not.toContain('root:x:0:0');
  });

  it('refuses to write outside the run workspace', async () => {
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'filesystem.write', arguments: { path: '../escaped.txt', content: 'pwned' } }] },
        { text: 'Blocked.' },
      ],
      tools: ['filesystem'],
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Write outside the workspace.');

    const failures = await env.os.store.failures.list(run.id);
    expect(failures.some((item) => item.toolId === 'filesystem.write')).toBe(true);
    expect(existsSync(join(run.workspaceDir, '..', 'escaped.txt'))).toBe(false);
  });

  it('follows no symlink out of the workspace', async () => {
    const { mkdtempSync, symlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const outside = mkdtempSync(join(tmpdir(), 'kazi-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');

    env = await createTestAgentOS({ turns: [{ text: 'Done.' }], tools: ['filesystem'] });
    const run = await env.run('Create a workspace.');
    // A link inside the workspace that points outside it.
    symlinkSync(outside, join(run.workspaceDir, 'link'));

    const tool = env.os.tools.get('filesystem.read');
    const attempt = tool?.execute({ path: 'link/secret.txt' }, {
      runId: run.id,
      organizationId: 'org_test',
      projectId: 'prj_test',
      workspaceDir: run.workspaceDir,
      permissions: { filesystem: { read: true } },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      clock: { now: () => Date.now() },
      signal: new AbortController().signal,
      secrets: { resolve: async () => '', has: async () => false },
      environment: {},
      artifacts: {},
    } as never);

    await expect(attempt).rejects.toMatchObject({ code: 'tool.invalid_input' });
    await expect(attempt).rejects.toThrow(/outside the workspace|symlink/i);
  });
});

describe('the network is default-deny (spec §17, §115)', () => {
  it('refuses network tools entirely while the run has no network grant', async () => {
    env = await createTestAgentOS({
      turns: [
        {
          toolCalls: [
            { name: 'http.request', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } },
          ],
        },
        { text: 'Blocked.' },
      ],
      tools: ['http'],
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Fetch the instance metadata.');

    const failures = await env.os.store.failures.list(run.id);
    const attempt = failures.find((item) => item.toolId === 'http.request');
    expect(attempt?.message).toMatch(/network access is not permitted/i);
    expect(JSON.stringify(failures)).not.toContain('ami-id');
  });

  it('blocks the cloud metadata endpoint even when the network is granted', async () => {
    env = await createTestAgentOS({
      turns: [
        {
          toolCalls: [
            { name: 'http.request', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } },
          ],
        },
        { text: 'Blocked.' },
      ],
      tools: ['http'],
      permissions: {
        filesystem: { read: true, write: true, delete: false },
        network: { enabled: true },
      },
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Fetch the instance metadata.');

    const failures = await env.os.store.failures.list(run.id);
    const attempt = failures.find((item) => item.toolId === 'http.request');
    expect(attempt?.message).toMatch(/blocked/i);
    expect(JSON.stringify(failures)).not.toContain('ami-id');
  });

  it('blocks loopback, private and link-local hosts named directly', async () => {
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'http.request', arguments: { url: 'http://127.0.0.1:4000/api/runs' } }] },
        { toolCalls: [{ name: 'http.request', arguments: { url: 'http://10.0.0.5/admin' } }] },
        { toolCalls: [{ name: 'http.request', arguments: { url: 'http://localhost:5432/' } }] },
        { toolCalls: [{ name: 'http.request', arguments: { url: 'http://[::1]:4000/' } }] },
        { text: 'All blocked.' },
      ],
      tools: ['http'],
      permissions: {
        filesystem: { read: true, write: true, delete: false },
        network: { enabled: true },
      },
      // Recovery would re-plan through the scripted turns; this test is about
      // the network boundary, so it is off.
      agent: { recovery: false },
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Probe the internal network.');

    const failures = await env.os.store.failures.list(run.id);
    const attempts = failures.filter((item) => item.toolId === 'http.request');
    expect(attempts.length).toBe(4);
    for (const attempt of attempts) expect(attempt.message).toMatch(/blocked|not permitted/i);
    expect(run.status).toBe('COMPLETED');
  });
});

describe('what the runtime writes down (spec §66)', () => {
  const SECRET = 'ghp_example0123456789abcdefghijklmnop';

  it('never persists a secret value the runtime resolved, even after a tool prints it', async () => {
    env = await createTestAgentOS({
      // The agent is asked to print a credential it is allowed to use. The
      // value exists only inside the runtime, so pattern-matching could never
      // find it: the runtime has to remember what it handed out.
      turns: [
        { toolCalls: [{ name: 'leak.secret', arguments: {} }] },
        { text: 'Done.' },
      ],
      tools: ['filesystem'],
      extraTools: [
        defineTool({
          id: 'leak.secret',
          description: 'Resolve a credential and echo it, as a careless tool would',
          input: z.object({}),
          risk: 'LOW',
          permissions: {},
          async execute(_input, context) {
            const value = await context.secrets.resolve('secret://github/token');
            return { echoed: value, length: value.length };
          },
        }),
      ],
      overrides: {
        secrets: {
          get: async (name: string) => {
            if (name !== 'secret://github/token') throw new Error(`no secret ${name}`);
            return SECRET;
          },
          has: async (name: string) => name === 'secret://github/token',
          set: async () => undefined,
          delete: async () => undefined,
        },
      },
      onExhausted: { text: 'done' },
    });

    const run = await env.run('Echo the github token.');

    const stored = [
      JSON.stringify(await env.os.store.events.list(run.id)),
      JSON.stringify(await env.os.store.failures.list(run.id)),
      JSON.stringify(await env.os.store.actions.list(run.id)),
      JSON.stringify(await env.os.store.invocations.list(run.id)),
      JSON.stringify(await env.os.runtime.getState(run.id)),
      JSON.stringify(await env.os.runtime.getTrace(run.id)),
    ].join('\n');

    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('ghp_example');
    // The run still worked: redaction is not the same as failure.
    expect(run.status).toBe('COMPLETED');
  });

  it('leaves unrelated output alone', async () => {
    env = await createTestAgentOS({
      turns: [
        { toolCalls: [{ name: 'filesystem.write', arguments: { path: 'a.txt', content: 'hello world' } }] },
        { text: 'Done.' },
      ],
      tools: ['filesystem'],
      onExhausted: { text: 'done' },
    });
    const run = await env.run('Write a file.');
    const state = await env.os.runtime.getState(run.id);
    expect(JSON.stringify(state)).toContain('a.txt');
  });
});
