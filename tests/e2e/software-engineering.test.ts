import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { parseAgentDefinitionYaml } from '@kazi-ai/agentos-agent';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';

/**
 * The example has to work (spec §94), and "work" means the repository's test
 * suite is genuinely red before the run and genuinely green after it. This
 * drives the same definition, the same script and the same repository the
 * README tells a reader to run.
 */

const EXAMPLE_DIR = fileURLToPath(new URL('../../examples/software-engineering', import.meta.url));
const REPO_DIR = join(EXAMPLE_DIR, 'repo');

let dataDir: string | undefined;
let os: AgentOS | undefined;

afterEach(async () => {
  await os?.close().catch(() => undefined);
  os = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

function readExample(): { definition: ReturnType<typeof parseAgentDefinitionYaml>; turns: FakeTurn[] } {
  const definition = parseAgentDefinitionYaml(readFileSync(join(EXAMPLE_DIR, 'agent.yaml'), 'utf8'));
  const script = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'replay.json'), 'utf8')) as { turns: FakeTurn[] };
  return { definition, turns: script.turns };
}

async function runExample(): Promise<{ os: AgentOS; runId: string; workspaceDir: string }> {
  const { definition, turns } = readExample();
  dataDir = mkdtempSync(join(tmpdir(), 'kazi-example-'));
  const instance = await createAgentOS({
    dataDir,
    organizationId: 'org_example',
    projectId: 'prj_example',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ id: definition.model.provider, turns, onExhausted: { text: 'Done.' } })],
    logger: new NullLogger(),
  });
  os = instance;
  const agent = instance.agent(definition);
  await agent.register();
  const run = await agent.createRun({
    goal: 'Fix the failing tests in this repository and prove the suite passes.',
    workspace: { copyFrom: REPO_DIR, ignore: ['node_modules', '.git'] },
  });
  await agent.start(run.id);
  return { os: instance, runId: run.id, workspaceDir: run.workspaceDir };
}

describe('the software-engineering example', () => {
  it('starts from a genuinely failing suite', () => {
    const before = spawnSync(process.execPath, ['--test'], { cwd: REPO_DIR, encoding: 'utf8' });
    expect(before.status).not.toBe(0);
    expect(before.stdout).toContain('12.5');
  });

  it('reads the repository, fixes the bug and proves it with the real suite', async () => {
    const { os: instance, runId, workspaceDir } = await runExample();

    const run = await instance.runtime.getRun(runId);
    expect(run.status).toBe('COMPLETED');

    const result = await instance.runtime.result(runId);
    expect(result.success).toBe(true);
    expect(result.verification?.passed).toBe(true);
    expect(result.steps).toBeGreaterThanOrEqual(5);
    expect(result.toolCalls).toBeGreaterThanOrEqual(4);
    expect(result.recoveryCount).toBeGreaterThanOrEqual(1);

    // The fix is in the run's own copy, and the suite the *runtime* ran passes.
    const fixed = readFileSync(join(workspaceDir, 'src', 'cart.js'), 'utf8');
    expect(fixed).toContain('item.price * item.quantity');
    const after = spawnSync(process.execPath, ['--test'], { cwd: workspaceDir, encoding: 'utf8' });
    expect(after.status).toBe(0);

    // The example repository itself is untouched: the agent worked on a copy.
    expect(readFileSync(join(REPO_DIR, 'src', 'cart.js'), 'utf8')).not.toContain('item.quantity');

    // The agent's declared recovery policy, not the deployment default, is what
    // handled the red test run.
    const recoveries = await instance.store.recoveries.list(runId);
    expect(recoveries.map((entry) => entry.strategy)).toContain('skip_step');

    // Verification evidence outlives the worker that produced it.
    const events = await instance.store.events.list(runId);
    expect(events.some((event) => event.type === 'verification.completed' && event.data['passed'] === true)).toBe(true);
    expect(events.some((event) => event.type === 'plan.created')).toBe(true);
  }, 120_000);

  it('runs the documented command for real', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'kazi-example-cli-'));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(EXAMPLE_DIR, 'run.ts'), '--data-dir', dataDir],
      { cwd: dirname(EXAMPLE_DIR), encoding: 'utf8', timeout: 120_000 },
    );

    // The README's first command exits 0 only when the goal was achieved and
    // verification passed; anything else is a failed demo.
    expect(result.stdout).toContain('Verification:');
    expect(result.stdout).toContain('COMPLETED');
    expect(result.status, result.stderr).toBe(0);
    // The run left a durable record behind, and a resumable workspace.
    expect(existsSync(join(dataDir, 'logs', 'agentos-events.jsonl'))).toBe(true);
    expect(existsSync(join(dataDir, 'workspaces'))).toBe(true);
  }, 180_000);
});
