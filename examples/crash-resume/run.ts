/**
 * A runnable AgentOS example (spec §31, §114).
 *
 *   pnpm tsx examples/crash-resume/run.ts
 *
 * It starts a real worker process on a real run, kills that process with
 * SIGKILL partway through the job, and then starts a *different* worker against
 * the same durable store. The second worker finishes the run from what the first
 * one had already committed — it does not start over, and it does not lose the
 * work.
 *
 * Nothing here is staged for the camera: the kill is a real SIGKILL, the state
 * is on disk, and the transcript is printed from what is actually stored.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NullLogger, type JournalEntry } from '@kazi-ai/agentos-core';
import { createAgentOS, type AgentOS } from '@kazi-ai/agentos';
import { ContinuationProvider, type ScriptedTurn } from './provider.js';
import { startWorker, type WorkerEvent } from './worker.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '.agentos');
const SCRIPT = join(HERE, 'turns.json');
const GOAL = 'Write five files, one per step.';
const FILES = ['notes/01.txt', 'notes/02.txt', 'notes/03.txt', 'notes/04.txt', 'notes/05.txt'];

const say = (line = ''): void => void process.stdout.write(`${line}\n`);
const rule = (label: string): void => say(`\n\u2500\u2500 ${label} ${'\u2500'.repeat(Math.max(0, 60 - label.length))}`);

async function openOS(): Promise<AgentOS> {
  const parsed = JSON.parse(readFileSync(SCRIPT, 'utf8')) as { turns: ScriptedTurn[] };
  return createAgentOS({
    dataDir: DATA_DIR,
    organizationId: 'org_example',
    projectId: 'prj_crash_resume',
    providersFromEnv: false,
    providers: [new ContinuationProvider(parsed.turns, 'replay')],
    logger: new NullLogger(),
    environment: {
      kind: 'local',
      workspaceRoot: `${DATA_DIR}/workspaces`,
      snapshotStoreRoot: `${DATA_DIR}/snapshots`,
    },
  });
}

rmSync(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });

say('KaziAI AgentOS \u2014 kill a worker mid-run, watch the run survive');
say();
say(`goal  ${GOAL}`);
say('agent crash-demo   model deterministic replay');

// ── create the run, durably, then let go of it ──────────────────────────
let os = await openOS();
const agent = os.agent({
  id: 'crash-demo',
  model: { provider: 'replay', model: 'deterministic-replay' },
  tools: ['filesystem'],
  planning: false,
  verification: false,
  permissions: { filesystem: { read: true, write: true, delete: false } },
});
await agent.register();
const created = await agent.createRun({ goal: GOAL, limits: { maxSteps: 20 } });
const runId = created.id;
const workspace = created.workspaceDir;
await os.close();
say(`run   ${runId}`);

// ── worker #1: killed while it is working ──────────────────────────────
rule('worker #1');
const first = startWorker({ dataDir: DATA_DIR, runId, script: SCRIPT, workerId: 'worker-1' });
const ready = await first.waitFor((event) => event.event === 'ready');
say(`pid ${ready.pid}  started`);
const midway = await first.waitFor(
  (event: WorkerEvent) => event.event === 'status' && (event.checkpoints ?? 0) >= 3,
  120_000,
);
say(`  committed ${midway.steps ?? 0} steps, ${midway.checkpoints ?? 0} checkpoints`);
first.kill();
await first.stopped;
say(`  SIGKILL \u2014 process ${ready.pid} is gone`);

// ── what the crash left behind ─────────────────────────────────────────
os = await openOS();
const crashed = await os.runtime.getRun(runId);
const journal = await os.store.actions.list(runId);
const checkpoints = await os.store.checkpoints.list(runId);
// The journal is append-only: an intent entry carries the arguments, a commit
// entry carries the outcome and the hash. Collapse to one line per action.
const latest = new Map<string, JournalEntry>();
for (const entry of journal) latest.set(entry.idempotencyKey, entry);
const actions = [...latest.values()].sort((left, right) => left.sequence - right.sequence);
const committed = actions.filter((action) => action.status === 'succeeded');
const argumentsFor = (key: string): unknown =>
  journal.find((entry) => entry.idempotencyKey === key && entry.arguments !== undefined)?.arguments;
const onDisk = FILES.filter((file) => existsSync(join(workspace, file)));

rule('what survived the crash');
say(`run status        ${crashed.status}`);
say(`steps committed   ${crashed.usage.steps}`);
say(`checkpoints       ${checkpoints.length}`);
say(`journal           ${committed.length} of ${actions.length} action(s) committed`);
for (const action of actions) {
  say(`                  ${action.toolId}  ${describe(argumentsFor(action.idempotencyKey))}  ${action.status}`);
}
say(`on disk           ${onDisk.join(' ') || '(nothing yet)'}`);
await os.close();

// ── worker #2: a different process, same store ─────────────────────────
rule('worker #2');
const second = startWorker({
  dataDir: DATA_DIR,
  runId,
  script: SCRIPT,
  workerId: 'worker-2',
  // Worker #1 is dead, so its claim is stale almost immediately.
  staleClaimMs: 200,
});
const secondReady = await second.waitFor((event) => event.event === 'ready');
say(`pid ${secondReady.pid}  started on the same store, with no shared memory`);
const finished = await second.waitFor((event) => event.event === 'finished', 120_000);
await second.stopped;

// ── the result ─────────────────────────────────────────────────────────
os = await openOS();
const done = await os.runtime.getRun(runId);
const result = await os.runtime.result(runId);
const written = FILES.filter((file) => existsSync(join(workspace, file)));
await os.close();

rule('result');
say(`status            ${finished.status}`);
say(`files written     ${written.length} / ${FILES.length}`);
say(`steps             ${done.usage.steps}`);
say(`tool calls        ${done.usage.toolCalls}`);
say(`model calls       ${done.usage.modelCalls}`);
say(`checkpoints       ${done.usage.checkpointCount}`);
say();
say(`workspace         ${workspace}`);
say();
say(
  written.length === FILES.length && result.success
    ? 'The worker died. The run did not.'
    : 'The run did not survive \u2014 which would be a bug worth reporting.',
);

process.exitCode = written.length === FILES.length && result.success ? 0 : 1;

function describe(args: unknown): string {
  if (args !== null && typeof args === 'object' && 'path' in args) {
    return String((args as { path: unknown }).path);
  }
  return JSON.stringify(args);
}
