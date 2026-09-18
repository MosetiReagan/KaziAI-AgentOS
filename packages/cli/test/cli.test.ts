import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startStubProvider, type StubProvider } from '../../../tests/helpers/stub-provider.js';
import { main } from '../src/cli.js';
import { describeTimeline } from '../src/commands/run.js';

let cwd: string;
let stub: StubProvider | undefined;
const lines: string[] = [];

function capture(): { cwd: string; env: Record<string, string>; write(text: string): void } {
  return { cwd, env: { KZ_LOG_LEVEL: 'error' }, write: (text) => lines.push(text) };
}

function output(): string {
  return lines.join('');
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'kazi-cli-'));
  lines.length = 0;
});

afterEach(async () => {
  await stub?.stop();
  stub = undefined;
  rmSync(cwd, { recursive: true, force: true });
});

/** Point the generated agent at the stub provider, as a real deployment would. */
function pointAtStub(provider: StubProvider): void {
  const agentPath = join(cwd, 'agents', 'developer.yaml');
  writeFileSync(
    agentPath,
    readFileSync(agentPath, 'utf8')
      .replace('provider: openai', 'provider: stub')
      .replace('model: gpt-5.6', 'model: stub-model'),
    'utf8',
  );
  const configPath = join(cwd, 'agentos.yaml');
  writeFileSync(
    configPath,
    `${readFileSync(configPath, 'utf8')}
providers:
  stub:
    kind: openai-compatible
    baseUrl: ${provider.baseUrl}
    model: stub-model
`,
    'utf8',
  );
}

describe('the operator timeline', () => {
  it('names the failure a recovery is handling', async () => {
    const os = {
      store: {
        events: {
          list: async () => [
            { type: 'plan.created', at: 1, data: { steps: 2 } },
            { type: 'recovery.started', at: 2, data: { kind: 'tool_failure', toolId: 'terminal.exec' } },
            { type: 'checkpoint.created', at: 3, data: { sequence: 1 } },
          ],
        },
        invocations: { list: async () => [{ toolId: 'filesystem.read', at: 4 }] },
      },
    } as unknown as Parameters<typeof describeTimeline>[0];

    expect(await describeTimeline(os, 'run_1')).toEqual([
      '[01] Planning',
      '[02] filesystem.read',
      '[03] Recovery (tool_failure on terminal.exec)',
      '[04] Checkpoint #1',
    ]);
  });
});

describe('kazi-agent', () => {
  it('scaffolds a project with init', async () => {
    const code = await main(['init'], capture());

    expect(code).toBe(0);
    expect(existsSync(join(cwd, 'agentos.yaml'))).toBe(true);
    expect(existsSync(join(cwd, 'agents/developer.yaml'))).toBe(true);
    expect(output()).toContain('created');

    // A second init refuses to clobber the operator's files.
    lines.length = 0;
    await main(['init'], capture());
    expect(output()).toContain('already exists');
  });

  it('runs a real agent against a real HTTP provider and prints the §111 summary', async () => {
    stub = await startStubProvider([
      {
        content: JSON.stringify({
          objective: 'Fix the failing tests.',
          steps: [{ description: 'Run the tests' }],
        }),
      },
      {
        content: 'Running the test suite.',
        toolCalls: [{ name: 'terminal.exec', arguments: { command: 'echo', args: ['fixed'] } }],
      },
      { content: 'The failing test now passes.' },
    ]);
    await main(['init'], capture());
    pointAtStub(stub);
    lines.length = 0;

    const code = await main(['run', 'developer', '--goal', 'Fix the failing tests.'], capture());

    expect(code).toBe(0);
    const text = output();
    expect(text).toContain('KaziAI AgentOS');
    expect(text).toContain('Goal:');
    expect(text).toContain('Fix the failing tests.');
    expect(text).toContain('[01] Planning');
    expect(text).toContain('[02] terminal.exec');
    expect(text).toContain('[03] Verification');
    expect(text).toMatch(/\[0\d\] Checkpoint #1/);
    expect(text).toContain('COMPLETED');

    // The stub really was called over HTTP: first for the plan, then for the
    // decision that carried the agent's declared tools to the provider.
    const requests = await stub.requests();
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const decisionRequest = requests.find((request) => Array.isArray(request['tools']));
    expect(decisionRequest).toBeDefined();
    // Names are encoded for the wire (`terminal.exec` → `terminal__exec`) and
    // decoded back, so the agent keeps speaking AgentOS tool ids.
    const tools = (decisionRequest?.['tools'] ?? []) as Array<{ function: { name: string } }>;
    const wireNames = tools.map((tool) => tool.function.name);
    expect(wireNames).toContain('terminal__exec');
    expect(wireNames).toContain('filesystem__write');
  });

  it('lists what a run did without re-running it', async () => {
    stub = await startStubProvider([
      {
        content: JSON.stringify({
          objective: 'Do nothing',
          steps: [{ description: 'Confirm there is nothing to do' }],
        }),
      },
      { content: 'Nothing to do.' },
    ]);
    await main(['init'], capture());
    pointAtStub(stub);
    lines.length = 0;
    await main(['run', 'developer', '--goal', 'Do nothing'], capture());

    lines.length = 0;
    const runsCode = await main(['runs', '--json'], capture());
    expect(runsCode).toBe(0);
    const runs = JSON.parse(output()) as Array<{ id: string; status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('COMPLETED');

    const runId = runs[0]?.id as string;
    lines.length = 0;
    expect(await main(['inspect', runId], capture())).toBe(0);
    expect(output()).toContain(`RUN ${runId}`);

    lines.length = 0;
    expect(await main(['logs', runId], capture())).toBe(0);
    expect(output()).toContain('run.created');
    expect(output()).toContain('run.completed');

    lines.length = 0;
    expect(await main(['checkpoint', runId], capture())).toBe(0);
    expect(output()).toContain('Checkpoint');
  });

  it('evaluates a policy decision without running the action', async () => {
    await main(['init'], capture());
    lines.length = 0;

    const denied = await main(
      ['policies', '--tool', 'git', '--args', '{"operation":"push"}'],
      capture(),
    );
    expect(output()).toContain('REQUIRE_APPROVAL');
    expect(denied).toBe(0);

    lines.length = 0;
    await main(['policies', '--tool', 'filesystem.read', '--args', '{"path":"a.txt"}'], capture());
    expect(output()).toContain('ALLOW');

    lines.length = 0;
    await main(['policies'], capture());
    expect(output()).toContain('RULE');
  });

  it('reports the health of the deployment with doctor', async () => {
    await main(['init'], capture());
    lines.length = 0;

    const code = await main(['doctor'], capture());
    const text = output();
    expect(text).toContain('KaziAI AgentOS doctor');
    expect(text).toContain('Node');
    expect(text).toContain('Docker');
    expect(text).toContain('Providers');
    // No provider is configured in a fresh project, and doctor says so.
    expect(code).toBe(1);
    expect(text).toContain('no model providers are configured');
  });

  it('fails clearly when the agent is unknown', async () => {
    await main(['init'], capture());
    lines.length = 0;

    const code = await main(['run', 'nope', '--goal', 'x'], capture());
    expect(code).toBe(2);
    expect(output()).toContain('Unknown agent');
  });
});
