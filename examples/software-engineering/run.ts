/**
 * A runnable AgentOS example (spec §94).
 *
 *   pnpm tsx examples/software-engineering/run.ts
 *   pnpm tsx examples/software-engineering/run.ts --live
 *
 * It hands the runtime a repository with a genuinely failing test suite and the
 * developer agent from `agent.yaml`, and lets the runtime do the work: inspect,
 * run the tests, fix the code, run the tests again, verify, summarise.
 *
 * By default the decisions come from `replay.json`, so the example runs with no
 * API key - the deterministic provider from spec §87 - while every other part is
 * the real thing: the real runtime, the real sandbox, the real tools, the real
 * verification command. `--live` replaces the script with a real model
 * discovered from the environment.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NullLogger } from '@kazi-ai/agentos-core';
import { parseAgentDefinitionYaml } from '@kazi-ai/agentos-agent';
import { createAgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { Output, describeTimeline, renderRunSummary } from '@kazi-ai/agentos-cli';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, 'repo');
const GOAL = 'Fix the failing tests in this repository and prove the suite passes.';

const live = process.argv.includes('--live');
// `--data-dir <path>` keeps the run's durable state out of the example tree,
// which is what the end-to-end test does so it can inspect the record.
const dataDirArg = process.argv.indexOf('--data-dir');
const definition = parseAgentDefinitionYaml(readFileSync(join(HERE, 'agent.yaml'), 'utf8'));
const script = JSON.parse(readFileSync(join(HERE, 'replay.json'), 'utf8')) as { turns: FakeTurn[] };
const dataDir = (dataDirArg >= 0 ? process.argv[dataDirArg + 1] : undefined) ?? join(HERE, '.agentos');
mkdirSync(dataDir, { recursive: true });

const output = new Output((text) => process.stdout.write(text), { color: true });
const os = await createAgentOS({
  dataDir,
  organizationId: process.env['KAZI_ORG'] ?? 'org_example',
  projectId: process.env['KAZI_PROJECT'] ?? 'prj_software_engineering',
  // `--live` uses whatever providers the environment is configured with; the
  // default path needs no credentials at all.
  // Registered under the provider id the definition asks for, so the replay
  // provider stands in the same seat a real one would occupy.
  providers: live
    ? []
    : [
        new FakeModelProvider({
          id: definition.model.provider,
          turns: script.turns,
          onExhausted: { text: 'Done.' },
        }),
      ],
  providersFromEnv: live,
  logger: new NullLogger(),
});

try {
  const agent = os.agent({ ...definition, id: `${definition.id}${live ? '' : '-replay'}` });
  await agent.register();

  const run = await agent.createRun({
    goal: GOAL,
    // The repository is copied into the run's own workspace, so the agent can
    // only touch a copy of it (spec §70).
    workspace: { copyFrom: REPO, ignore: ['node_modules', '.git'] },
  });
  output.line(`workspace: ${run.workspaceDir}`);
  output.line();
  await agent.start(run.id);

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
    ...(result.verification
      ? { verified: `${result.verification.passed ? '✓' : '✗'} ${result.verification.summary}` }
      : {}),
  });
  if (result.verification) {
    output.line();
    output.line('The agent\u2019s own summary is not the evidence: the suite above was run by the runtime.');
  }
  process.exitCode = result.success && (result.verification?.passed ?? true) ? 0 : 1;
} finally {
  await os.close();
}
