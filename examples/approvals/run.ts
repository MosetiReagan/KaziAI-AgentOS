/**
 * A runnable AgentOS example (spec §96): the human approval gate.
 *
 *   pnpm tsx examples/approvals/run.ts
 *   pnpm tsx examples/approvals/run.ts --deny
 *
 * The agent is allowed to push — `agent.yaml` grants it `git.push` — and the
 * push still does not happen, because the policy engine in front of every action
 * turns `git push` into a request for a human decision. The runtime parks the run
 * in WAITING at a durable checkpoint, this driver reads the request back out of
 * storage, records a decision, and resumes the run from it.
 *
 * The proof is not the agent's summary: after the run, the driver reads the git
 * remote it set up and reports whether the commit is actually there.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NullLogger, type Approval } from '@kazi-ai/agentos-core';
import { parseAgentDefinitionYaml } from '@kazi-ai/agentos-agent';
import { createAgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { Output, describeTimeline, renderRunSummary } from '@kazi-ai/agentos-cli';
import { gitOrEmpty, prepareRepository } from './repository.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, 'repo');
const GOAL = 'Prepare the release note, commit it, and push the release to origin.';
const OPERATOR = 'operator@example.com';

const deny = process.argv.includes('--deny');
const live = process.argv.includes('--live');
const decision = deny ? 'deny' : 'approve';
const dataDirArg = process.argv.indexOf('--data-dir');
const dataDir = (dataDirArg >= 0 ? process.argv[dataDirArg + 1] : undefined) ?? join(HERE, '.agentos');
mkdirSync(dataDir, { recursive: true });

const definition = parseAgentDefinitionYaml(readFileSync(join(HERE, 'agent.yaml'), 'utf8'));
const script = JSON.parse(readFileSync(join(HERE, 'replay.json'), 'utf8')) as {
  turns: FakeTurn[];
  finish: Record<'approve' | 'deny', FakeTurn>;
};
// The closing turn depends on the decision, and both are read at the same
// position: after the re-issued push.
const turns = [...script.turns, script.finish[decision]];


/** The action the human is being asked about, in the shape they can read. */
function actionText(approval: Approval): string {
  const args = approval.arguments;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    if (typeof record['operation'] === 'string') {
      const rest = [record['remote'], record['branch'], record['path'], record['message']]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
      return `${approval.toolId} ${record['operation']}${rest ? ` ${rest}` : ''}`;
    }
  }
  return `${approval.toolId} ${JSON.stringify(args)}`;
}

const output = new Output((text) => process.stdout.write(text), { color: true });
const os = await createAgentOS({
  dataDir,
  organizationId: process.env['KAZI_ORG'] ?? 'org_example',
  projectId: process.env['KAZI_PROJECT'] ?? 'prj_approvals',
  providers: live
    ? []
    : [new FakeModelProvider({ id: definition.model.provider, turns, onExhausted: { text: 'Done.' } })],
  providersFromEnv: live,
  logger: new NullLogger(),
});

try {
  const agent = os.agent({ ...definition, id: `${definition.id}${live ? '' : '-replay'}` });
  await agent.register();

  const run = await agent.createRun({
    goal: GOAL,
    workspace: { copyFrom: REPO, ignore: ['.git'] },
  });
  const originDir = join(dataDir, 'remotes', `${run.id}.git`);
  prepareRepository(run.workspaceDir, originDir);

  output.title('KaziAI AgentOS');
  output.line();
  output.keyValue('Run:', run.id);
  output.keyValue('Agent:', run.agentId);
  output.keyValue('Workspace:', run.workspaceDir);
  output.keyValue('Remote:', originDir);
  output.line();
  output.title('Goal:');
  output.line(run.goal);
  output.line();

  // `start` returns at the run's next resting point: here, the approval gate.
  await agent.start(run.id);

  const parked = await agent.getRun(run.id);
  // The operator's queue. This example filters it to the run it just started;
  // a real console shows the whole queue across every run in the organization.
  const pending = (await os.runtime.pendingApprovals()).filter((item) => item.runId === run.id);
  if (parked.status !== 'WAITING' || pending.length === 0) {
    throw new Error(
      `expected the run to park in WAITING on an approval, saw ${parked.status} with ${pending.length} pending`,
    );
  }

  for (const [index, approval] of pending.entries()) {
    output.title(`Approval ${index + 1} of ${pending.length} (${approval.id})`);
    output.line();
    output.keyValue('Action:', actionText(approval));
    output.keyValue('Risk:', approval.risk);
    output.keyValue('Reason:', approval.reason);
    output.keyValue('Target:', approval.toolId);
    output.line();
    output.dim(`Status:  ${parked.status} — persisted, not held in memory.`);
    output.line();
  }

  output.title(`Decision: ${decision} (${OPERATOR})`);
  for (const approval of pending) {
    await os.runtime.decideApproval({
      approvalId: approval.id,
      decision,
      decidedBy: OPERATOR,
      reason: deny
        ? 'Releases are pushed by the release manager, not by the agent.'
        : 'Reviewed the commit; approved.',
    });
  }
  output.line();

  await agent.resume(run.id);

  const [result, timeline, finished] = await Promise.all([
    agent.result(run.id),
    describeTimeline(os, run.id),
    agent.getRun(run.id),
  ]);
  renderRunSummary(output, {
    run: finished,
    result,
    timeline,
    model: live ? `${finished.config.provider}/${finished.config.model}` : 'deterministic replay',
  });

  // The evidence: what is actually on the remote, read after the fact.
  const remote = gitOrEmpty(originDir, ['log', '--oneline', 'main']);
  const local = gitOrEmpty(run.workspaceDir, ['log', '--oneline', 'main']);
  output.line();
  output.title('Evidence:');
  output.keyValue('Local commits:', String(local.length));
  output.keyValue('Remote commits:', String(remote.length));
  output.line();
  for (const line of remote) output.line(`  origin/main ${line}`);

  output.line();
  if (decision === 'approve') {
    if (remote.length < 2) throw new Error('approved push did not reach the remote');
    output.ok('The approved push landed on the remote, and it took a human to let it happen.');
    process.exitCode = result.status === 'COMPLETED' ? 0 : 1;
  } else {
    if (remote.length !== 0) throw new Error('denied push still reached the remote');
    output.ok('The denial held: the commit is local and the remote is still empty.');
    output.dim('The decision is durable: it is in the approval record and the run timeline.');
    process.exitCode = 0;
  }
} finally {
  await os.close();
}
