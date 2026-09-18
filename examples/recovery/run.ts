/**
 * A runnable AgentOS example (spec §95): recovering from a real outage.
 *
 *   pnpm tsx examples/recovery/run.ts
 *
 * The agent is asked a question whose answer is in a SQLite database. While it
 * asks, a second connection holds a write lock on that database - the kind of
 * thing a migration or a backup does - so the first query comes back
 * `database is locked`. That is a transient outage, not an answer, and the
 * runtime recovers from it by running the same query again.
 *
 * Nothing about the outage is faked: it is SQLite refusing a read because
 * someone else holds the write lock, and the retry is a second execution of the
 * action against the same file. The driver is an ordinary `DatabaseDriver`, the
 * extension point the process tool exposes, not a special test hook.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NullLogger } from '@kazi-ai/agentos-core';
import { parseAgentDefinitionYaml } from '@kazi-ai/agentos-agent';
import { createAgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { Output, describeTimeline, renderRunSummary } from '@kazi-ai/agentos-cli';
import { CONNECTION, createLedgerTool, seedDatabase, startMaintenanceJob } from './database.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, 'repo');
const GOAL =
  'How much money is in orders over 10000 cents? Write the answer to report.md.';

const live = process.argv.includes('--live');
const dataDirArg = process.argv.indexOf('--data-dir');
const dataDir = (dataDirArg >= 0 ? process.argv[dataDirArg + 1] : undefined) ?? join(HERE, '.agentos');
mkdirSync(dataDir, { recursive: true });

const definition = parseAgentDefinitionYaml(readFileSync(join(HERE, 'agent.yaml'), 'utf8'));
const script = JSON.parse(readFileSync(join(HERE, 'replay.json'), 'utf8')) as { turns: FakeTurn[] };

// The world: a database outside the workspace, and a maintenance job holding a
// lock on it. The agent can reach the database only by naming the connection.
const databasePath = join(dataDir, 'shop.db');
seedDatabase(databasePath);
const maintenance = startMaintenanceJob(databasePath);

const output = new Output((text) => process.stdout.write(text), { color: true });
const os = await createAgentOS({
  dataDir,
  organizationId: process.env['KAZI_ORG'] ?? 'org_example',
  projectId: process.env['KAZI_PROJECT'] ?? 'prj_recovery',
  providers: live
    ? []
    : [new FakeModelProvider({ id: definition.model.provider, turns: script.turns, onExhausted: { text: 'Done.' } })],
  providersFromEnv: live,
  // The connection string is a secret reference the agent cannot read, let alone
  // guess: the driver gets the path, the model never sees it (spec §66).
  secrets: {
    resolve: async (reference: string) => {
      if (reference === `db/${CONNECTION}`) return databasePath;
      throw new Error(`Secret not configured: ${reference}`);
    },
    has: async (reference: string) => reference === `db/${CONNECTION}`,
  },
  tools: [
    createLedgerTool({
      // The outage ends the moment the first attempt hits it. Sleeping for a
      // fixed time instead would make this example a coin flip, because the
      // runtime's backoff is jittered on purpose (spec §37).
      onLocked: () => maintenance.end(),
    }),
  ],
  logger: new NullLogger(),
});

try {
  const agent = os.agent({ ...definition, id: `${definition.id}${live ? '' : '-replay'}` });
  await agent.register();

  const run = await agent.createRun({
    goal: GOAL,
    workspace: { copyFrom: REPO, ignore: ['.git', 'node_modules'] },
  });

  output.title('KaziAI AgentOS');
  output.line();
  output.keyValue('Run:', run.id);
  output.keyValue('Agent:', run.agentId);
  output.keyValue('Database:', databasePath);
  output.line();
  output.title('Goal:');
  output.line(run.goal);
  output.line();
  output.dim('A second connection is holding a write lock on that database.');
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

  // What the runtime recorded about the outage, read back from durable storage.
  const recoveries = await os.store.recoveries.list(run.id);
  const events = await os.store.events.list(run.id);
  const failures = await os.store.failures.list(run.id);
  const reasonOf = (toolId: unknown): string =>
    failures.find((failure) => failure.toolId === toolId)?.message ?? '';
  output.line();
  output.title('What the runtime recorded:');
  for (const event of events) {
    if (event.type === 'tool.failed') {
      output.line(`  TOOL FAILURE   ${String(event.data['toolId'])} - ${reasonOf(event.data['toolId'])}`);
    } else if (event.type === 'recovery.started') {
      output.line(`  RECOVERY       ${String(event.data['kind'])}`);
    } else if (event.type === 'recovery.completed') {
      output.line(`  RETRY          ${String(event.data['strategy'])} (applied: ${String(event.data['applied'])})`);
    } else if (event.type === 'tool.completed') {
      output.line(`  SUCCESS        ${String(event.data['toolId'])}`);
    }
  }
  output.line();
  for (const recovery of recoveries) {
    output.keyValue(
      'Recovery:',
      `attempt ${recovery.attempt} · ${recovery.strategy} · ${recovery.success ? 'applied' : 'not applied'}`,
    );
  }
  output.keyValue('Outage:', `maintenance job ${maintenance.ended ? 'finished' : 'STILL HOLDING THE LOCK'}`);

  const report = readFileSync(join(run.workspaceDir, 'report.md'), 'utf8');
  output.line();
  output.title('report.md:');
  for (const line of report.trimEnd().split('\n')) output.line(`  ${line}`);

  if (!maintenance.ended) throw new Error('the maintenance job never observed the failure');
  if (recoveries.length === 0 || !recoveries.every((recovery) => recovery.success)) {
    throw new Error('the run did not record a successful recovery');
  }
  output.line();
  output.ok('The first query failed, the runtime retried the same action, and the retry succeeded.');
  process.exitCode = result.success && (result.verification?.passed ?? false) ? 0 : 1;
} finally {
  maintenance.end();
  await os.close();
}
