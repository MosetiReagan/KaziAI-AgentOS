/**
 * A real worker process, so the example can kill one outright (spec §114).
 *
 * It reports one JSON object per line on stdout; `worker.ts` turns those lines
 * into the transcript. Everything durable lives in the store, so this process
 * holds nothing the next worker needs.
 *
 * Usage: node --import tsx examples/crash-resume/worker-child.ts \
 *   --data-dir <dir> --run-id <id> --script <turns.json> [--stale-claim-ms N] [--worker-id id]
 */
import { readFileSync } from 'node:fs';
import { NullLogger } from '@kazi-ai/agentos-core';
import { createAgentOS } from '@kazi-ai/agentos';
import { AgentWorker, StoreRunQueue } from '@kazi-ai/agentos-worker';
import { ContinuationProvider, type ScriptedTurn } from './provider.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function report(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const dataDir = arg('data-dir');
  const runId = arg('run-id');
  const script = arg('script');
  if (!dataDir || !runId || !script) throw new Error('data-dir, run-id and script are required');

  const parsed = JSON.parse(readFileSync(script, 'utf8')) as { turns: ScriptedTurn[] };
  const os = await createAgentOS({
    dataDir,
    organizationId: arg('org') ?? 'org_example',
    projectId: arg('project') ?? 'prj_crash_resume',
    providersFromEnv: false,
    providers: [new ContinuationProvider(parsed.turns, 'replay')],
    logger: new NullLogger(),
    environment: {
      kind: 'local',
      workspaceRoot: `${dataDir}/workspaces`,
      snapshotStoreRoot: `${dataDir}/snapshots`,
    },
  });

  const workerId = arg('worker-id') ?? 'worker';
  const worker = new AgentWorker({
    os,
    queue: new StoreRunQueue({ store: os.store, workerId }),
    concurrency: 1,
    pollIntervalMs: 50,
    staleClaimMs: Number(arg('stale-claim-ms') ?? 30_000),
    workerId,
  });
  worker.start();
  report({ event: 'ready', pid: process.pid, workerId });

  let lastStatus = 'none';
  let lastSteps = -1;
  const timer = setInterval(() => {
    void (async () => {
      const run = await os.store.runs.get(runId).catch(() => undefined);
      if (!run) return;
      if (run.status !== lastStatus || run.usage.steps !== lastSteps) {
        lastStatus = run.status;
        lastSteps = run.usage.steps;
        report({
          event: 'status',
          status: run.status,
          steps: run.usage.steps,
          toolCalls: run.usage.toolCalls,
          checkpoints: run.usage.checkpointCount,
          recoveries: run.usage.recoveryCount,
          modelCalls: run.usage.modelCalls,
        });
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.status)) {
        clearInterval(timer);
        report({
          event: 'finished',
          status: run.status,
          steps: run.usage.steps,
          toolCalls: run.usage.toolCalls,
          checkpoints: run.usage.checkpointCount,
          modelCalls: run.usage.modelCalls,
        });
        await worker.stop({ timeoutMs: 2_000 });
        await os.close();
        process.exit(0);
      }
    })();
  }, 50);
}

main().catch((error: unknown) => {
  report({ event: 'error', message: (error as Error).message });
  process.exit(1);
});
