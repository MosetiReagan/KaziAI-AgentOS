import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NullLogger } from '@kazi-ai/agentos-core';
import { parseAgentDefinitionYaml } from '@kazi-ai/agentos-agent';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { gitOrEmpty, prepareRepository } from '../../examples/approvals/repository.js';

/**
 * The approval gate, end to end (spec §23, §54, §96).
 *
 * The agent in `examples/approvals` is *granted* `git.push` and still cannot
 * push: policy, not permission, is what stops it. These tests drive the same
 * definition, script and fixture the README tells a reader to run, and check the
 * remote afterwards rather than trusting the run's own summary.
 */

const EXAMPLE_DIR = fileURLToPath(new URL('../../examples/approvals', import.meta.url));
const REPO_DIR = join(EXAMPLE_DIR, 'repo');
const OPERATOR = 'operator@example.com';

let dataDir: string | undefined;
let os: AgentOS | undefined;

afterEach(async () => {
  await os?.close().catch(() => undefined);
  os = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

type Decision = 'approve' | 'deny';

interface Script {
  turns: FakeTurn[];
  finish: Record<Decision, FakeTurn>;
}

function readExample(): { definition: ReturnType<typeof parseAgentDefinitionYaml>; script: Script } {
  const definition = parseAgentDefinitionYaml(readFileSync(join(EXAMPLE_DIR, 'agent.yaml'), 'utf8'));
  const script = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'replay.json'), 'utf8')) as Script;
  return { definition, script };
}

async function openAgentOS(dir: string, turns: FakeTurn[]): Promise<AgentOS> {
  // Registered under the provider id the definition asks for, so the replay
  // provider stands in the same seat a real one would occupy.
  const providerId = readExample().definition.model.provider;
  const instance = await createAgentOS({
    dataDir: dir,
    organizationId: 'org_example',
    projectId: 'prj_approvals',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ id: providerId, turns, onExhausted: { text: 'Done.' } })],
    logger: new NullLogger(),
  });
  os = instance;
  return instance;
}

/** Start the example run and stop at the approval gate. */
async function runToGate(decision: Decision): Promise<{
  os: AgentOS;
  runId: string;
  workspaceDir: string;
  originDir: string;
}> {
  const { definition, script } = readExample();
  dataDir = mkdtempSync(join(tmpdir(), 'kazi-approval-'));
  const instance = await openAgentOS(dataDir, [...script.turns, script.finish[decision]]);
  const agent = instance.agent({ ...definition, id: `${definition.id}-replay` });
  await agent.register();
  const run = await agent.createRun({
    goal: 'Prepare the release note, commit it, and push the release to origin.',
    workspace: { copyFrom: REPO_DIR, ignore: ['.git'] },
  });
  const originDir = join(dataDir, 'remotes', `${run.id}.git`);
  prepareRepository(run.workspaceDir, originDir);
  await agent.start(run.id);
  return { os: instance, runId: run.id, workspaceDir: run.workspaceDir, originDir };
}

describe('the human approval gate', () => {
  it('parks the run before an irreversible push, and persists the request', async () => {
    const { os: instance, runId, originDir } = await runToGate('approve');

    const run = await instance.runtime.getRun(runId);
    expect(run.status).toBe('WAITING');

    // The run was allowed to push — this is a policy gate, not a permission
    // error wearing a gate's clothes.
    expect(run.config.permissions.git?.push).toBe(true);

    const pending = await instance.runtime.pendingApprovals();
    expect(pending).toHaveLength(1);
    const approval = pending[0]!;
    expect(approval.runId).toBe(runId);
    expect(approval.risk).toBe('CRITICAL');
    expect(approval.status).toBe('pending');
    expect(approval.toolId).toBe('git');
    expect(approval.reason).toContain('requires human approval');
    expect((approval.arguments as Record<string, unknown>)['operation']).toBe('push');

    // Nothing irreversible happened while the run waits.
    expect(gitOrEmpty(originDir, ['log', '--oneline', 'main'])).toHaveLength(0);

    // And the run can be resumed from disk: the gate is a resting point, not a
    // process holding its breath.
    const checkpoints = await instance.store.checkpoints.list(runId);
    expect(checkpoints.length).toBeGreaterThan(0);
    const events = await instance.store.events.list(runId);
    expect(events.filter((event) => event.type === 'approval.requested')).toHaveLength(1);

    // The append-only action journal is the source of truth for side effects,
    // and it holds no push: an unauthorised action is never even attempted, so
    // there is nothing to undo (spec §32, §33).
    const journal = await instance.store.actions.list(runId);
    const pushed = journal.filter(
      (entry) => (entry.arguments as Record<string, unknown> | null)?.['operation'] === 'push',
    );
    expect(pushed).toHaveLength(0);
    expect(journal.map((entry) => entry.status)).toContain('succeeded');
  });

  it('executes the push on approval, and the remote proves it', async () => {
    const { os: instance, runId, workspaceDir, originDir } = await runToGate('approve');

    const approval = (await instance.runtime.pendingApprovals())[0]!;
    await instance.runtime.decideApproval({
      approvalId: approval.id,
      decision: 'approve',
      decidedBy: OPERATOR,
      reason: 'Reviewed the commit.',
    });
    await instance.runtime.resume(runId);

    const finished = await instance.runtime.getRun(runId);
    expect(finished.status).toBe('COMPLETED');

    // The real evidence: the commit is on the remote, and it took a person.
    const remote = gitOrEmpty(originDir, ['log', '--oneline', 'main']);
    expect(remote).toHaveLength(2);
    expect(remote.join('\n')).toContain('approval-gated flow');
    expect(gitOrEmpty(workspaceDir, ['log', '--oneline', 'main'])).toHaveLength(2);

    const decided = await instance.store.approvals.get(approval.id);
    expect(decided?.status).toBe('granted');
    expect(decided?.decidedBy).toBe(OPERATOR);
    expect(decided?.decidedAt).toBeGreaterThan(0);

    const events = (await instance.store.events.list(runId)).map((event) => event.type);
    expect(events).toContain('approval.granted');
    expect(events).toContain('run.completed');
  });

  it('holds the line on denial, and keeps the work that was safe to keep', async () => {
    const { os: instance, runId, workspaceDir, originDir } = await runToGate('deny');

    const approval = (await instance.runtime.pendingApprovals())[0]!;
    await instance.runtime.decideApproval({
      approvalId: approval.id,
      decision: 'deny',
      decidedBy: OPERATOR,
      reason: 'Releases are pushed by the release manager.',
    });
    await instance.runtime.resume(runId);

    // The irreversible thing did not happen...
    expect(gitOrEmpty(originDir, ['log', '--oneline', 'main'])).toHaveLength(0);
    // ...and the reversible work the agent already did is still there.
    expect(gitOrEmpty(workspaceDir, ['log', '--oneline', 'main'])).toHaveLength(2);

    const decided = await instance.store.approvals.get(approval.id);
    expect(decided?.status).toBe('denied');
    expect(decided?.decisionReason).toContain('release manager');
    const events = (await instance.store.events.list(runId)).map((event) => event.type);
    expect(events).toContain('approval.denied');
  });

  it('carries the pending approval across a process restart', async () => {
    const { os: first, runId, originDir } = await runToGate('approve');
    const approvalId = (await first.runtime.pendingApprovals())[0]!.id;
    await first.close();
    os = undefined;

    // A brand-new process with the same durable state: the run, its checkpoint
    // and the pending request all come back from storage, never from memory.
    const { script } = readExample();
    const second = await openAgentOS(
      dataDir as string,
      [...script.turns.slice(5), script.finish.approve],
    );
    const pending = await second.runtime.pendingApprovals();
    expect(pending.map((item) => item.id)).toEqual([approvalId]);
    expect((await second.runtime.getRun(runId)).status).toBe('WAITING');

    await second.runtime.decideApproval({ approvalId, decision: 'approve', decidedBy: OPERATOR });
    await second.runtime.resume(runId);

    expect((await second.runtime.getRun(runId)).status).toBe('COMPLETED');
    expect(gitOrEmpty(originDir, ['log', '--oneline', 'main'])).toHaveLength(2);
  });

  it('runs the documented command for real', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'kazi-approval-cli-'));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(EXAMPLE_DIR, 'run.ts'), '--data-dir', dataDir],
      { cwd: dirname(EXAMPLE_DIR), encoding: 'utf8', timeout: 180_000 },
    );

    expect(result.stdout).toContain('Approval 1 of 1');
    expect(result.stdout).toContain('Risk:');
    expect(result.stdout).toContain('CRITICAL');
    expect(result.stdout).toContain('git push origin main');
    expect(result.stdout).toContain('WAITING');
    expect(result.stdout).toContain('Remote commits: 2');
    expect(result.status, result.stderr).toBe(0);

    // The denial path is a documented mode too, and it must hold.
    const denied = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(EXAMPLE_DIR, 'run.ts'), '--deny', '--data-dir', dataDir],
      { cwd: dirname(EXAMPLE_DIR), encoding: 'utf8', timeout: 180_000 },
    );
    expect(denied.stdout).toContain('Remote commits: 0');
    expect(denied.status, denied.stderr).toBe(0);
  }, 300_000);
});
