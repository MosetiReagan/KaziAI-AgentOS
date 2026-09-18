/**
 * A real worker process, used by the crash-recovery test.
 *
 * It is deliberately a separate OS process: the point of the test is that the
 * runtime survives a worker being killed outright, which an in-process fake
 * cannot demonstrate (spec §114).
 *
 * Usage: node --import tsx tests/fixtures/worker-child.ts --data-dir <dir> --run-id <id> --script <turns.json> [--stale-claim-ms N] [--worker-id id]
 */
import { readFileSync } from 'node:fs';
import { NullLogger, type RunState } from '@kazi-ai/agentos-core';
import { createAgentOS } from '@kazi-ai/agentos';
import { FakeModelProvider, type FakeTurn } from '@kazi-ai/agentos-providers';
import { AgentWorker, StoreRunQueue } from '@kazi-ai/agentos-worker';

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

  const turns = JSON.parse(readFileSync(script, 'utf8')) as FakeTurn[];
  const os = await createAgentOS({
    dataDir,
    organizationId: 'org_e2e',
    projectId: 'prj_e2e',
    providersFromEnv: false,
    providers: [new FakeModelProvider({ turns, onExhausted: { text: 'done' } })],
    logger: new NullLogger(),
    environment: {
      kind: 'local',
      workspaceRoot: `${dataDir}/workspaces`,
      snapshotStoreRoot: `${dataDir}/snapshots`,
    },
  });

  const worker = new AgentWorker({
    os,
    queue: new StoreRunQueue({
      store: os.store,
      workerId: arg('worker-id') ?? 'child-worker',
    }),
    concurrency: 1,
    pollIntervalMs: 50,
    staleClaimMs: Number(arg('stale-claim-ms') ?? 30_000),
    ...(arg('worker-id') ? { workerId: arg('worker-id') as string } : {}),
  });
  worker.start();
  report({ event: 'ready', pid: process.pid, workerId: worker.workerId });

  let last = 'none';
  let lastSteps = -1;
  let ticks = 0;
  const timer = setInterval(() => {
    void (async () => {
      const run = await os.store.runs.get(runId).catch(() => undefined);
      if (!run) return;
      ticks += 1;
      const state: RunState = run.status;
      // A heartbeat every two seconds, so a test can tell "still working" from
      // "wedged".
      if (state !== last || run.usage.steps !== lastSteps || ticks % 8 === 0) {
        last = state;
        lastSteps = run.usage.steps;
        report({
          event: 'status',
          status: state,
          steps: run.usage.steps,
          toolCalls: run.usage.toolCalls,
          checkpoints: run.usage.checkpointCount,
          recoveries: run.usage.recoveryCount,
          modelCalls: run.usage.modelCalls,
        });
      }
      if (state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED' || state === 'TIMED_OUT') {
        clearInterval(timer);
        const failures = await os.store.failures.list(runId).catch(() => []);
        report({
          event: 'finished',
          status: state,
          steps: run.usage.steps,
          ...(run.error ? { error: run.error } : {}),
          ...(failures.length > 0
            ? { failures: failures.map((failure) => `${failure.code}: ${failure.message}`) }
            : {}),
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
