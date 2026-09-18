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
import {
  CONNECTION,
  createLedgerTool,
  seedDatabase,
  startMaintenanceJob,
} from '../../examples/recovery/database.js';

/**
 * The recovery example has to recover (spec §95): the failure has to be real,
 * the retry has to be a second execution of the same action, and the run has to
 * end by verifying an answer it got from the database rather than from the model.
 */

const EXAMPLE_DIR = fileURLToPath(new URL('../../examples/recovery', import.meta.url));
const REPO_DIR = join(EXAMPLE_DIR, 'repo');

let dataDir: string | undefined;
let os: AgentOS | undefined;
/** Held so an unended maintenance job is not collected mid-test. */
let held: { end(): void } | undefined;

afterEach(async () => {
  await os?.close().catch(() => undefined);
  os = undefined;
  held?.end();
  held = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function runExample(): Promise<{
  os: AgentOS;
  runId: string;
  workspaceDir: string;
  maintenance: { ended: boolean };
}> {
  const definition = parseAgentDefinitionYaml(readFileSync(join(EXAMPLE_DIR, 'agent.yaml'), 'utf8'));
  const script = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'replay.json'), 'utf8')) as { turns: FakeTurn[] };
  dataDir = mkdtempSync(join(tmpdir(), 'kazi-recovery-'));
  const databasePath = join(dataDir, 'shop.db');
  seedDatabase(databasePath);
  const maintenance = startMaintenanceJob(databasePath);

  const instance = await createAgentOS({
    dataDir,
    organizationId: 'org_example',
    projectId: 'prj_recovery',
    providersFromEnv: false,
    providers: [
      new FakeModelProvider({ id: definition.model.provider, turns: script.turns, onExhausted: { text: 'Done.' } }),
    ],
    secrets: {
      resolve: async (reference: string) => {
        if (reference === `db/${CONNECTION}`) return databasePath;
        throw new Error(`Secret not configured: ${reference}`);
      },
      has: async (reference: string) => reference === `db/${CONNECTION}`,
    },
    tools: [createLedgerTool({ onLocked: () => maintenance.end() })],
    logger: new NullLogger(),
  });
  os = instance;
  const agent = instance.agent({ ...definition, id: `${definition.id}-replay` });
  await agent.register();
  const run = await agent.createRun({
    goal: 'How much money is in orders over 10000 cents? Write the answer to report.md.',
    workspace: { copyFrom: REPO_DIR, ignore: ['.git'] },
  });
  await agent.start(run.id);
  return { os: instance, runId: run.id, workspaceDir: run.workspaceDir, maintenance };
}

describe('the recovery example', () => {
  it('recovers from a real transient outage and finishes the work', async () => {
    const { os: instance, runId, workspaceDir, maintenance } = await runExample();

    expect((await instance.runtime.getRun(runId)).status).toBe('COMPLETED');
    const result = await instance.runtime.result(runId);
    expect(result.success).toBe(true);
    expect(result.verification?.passed).toBe(true);
    expect(result.recoveryCount).toBe(1);

    // The failure was the database's, not a stand-in for one.
    const failures = await instance.store.failures.list(runId);
    expect(failures.map((failure) => failure.toolId)).toContain('ledger.orders_over');
    expect(failures[0]!.message).toContain('database is locked');
    expect(failures[0]!.retryable).toBe(true);

    // A retry is a second execution of the same action, not a re-ask: the
    // journal shows one action idempotency key, failed on attempt 0 and
    // committed on attempt 1 (spec §32-33).
    const attempts = (await instance.store.actions.list(runId)).filter(
      (entry) => entry.toolId === 'ledger.orders_over' && entry.status !== 'executing',
    );
    expect(new Set(attempts.map((entry) => entry.idempotencyKey)).size).toBe(1);
    expect(attempts.map((entry) => [entry.attempt, entry.status])).toEqual([
      [0, 'failed'],
      [1, 'succeeded'],
    ]);

    const recoveries = await instance.store.recoveries.list(runId);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]!.strategy).toBe('retry_with_backoff');
    expect(recoveries[0]!.success).toBe(true);

    // The outage really ended, and the answer really came from the database.
    expect(maintenance.ended).toBe(true);
    const report = readFileSync(join(workspaceDir, 'report.md'), 'utf8');
    expect(report).toContain('85000');
    expect(report).toContain('Orders: 4');
  }, 180_000);

  it('fails the run when the outage outlasts recovery, instead of inventing an answer', async () => {
    // Same world, except the maintenance job never ends: the retries cannot
    // succeed, and the run must end loudly rather than report a guess.
    const definition = parseAgentDefinitionYaml(readFileSync(join(EXAMPLE_DIR, 'agent.yaml'), 'utf8'));
    const script = JSON.parse(readFileSync(join(EXAMPLE_DIR, 'replay.json'), 'utf8')) as { turns: FakeTurn[] };
    dataDir = mkdtempSync(join(tmpdir(), 'kazi-recovery-stuck-'));
    const databasePath = join(dataDir, 'shop.db');
    seedDatabase(databasePath);
    held = startMaintenanceJob(databasePath);

    const instance = await createAgentOS({
      dataDir,
      organizationId: 'org_example',
      projectId: 'prj_recovery',
      providersFromEnv: false,
      providers: [
        new FakeModelProvider({ id: definition.model.provider, turns: script.turns, onExhausted: { text: 'Done.' } }),
      ],
      secrets: {
        resolve: async () => databasePath,
        has: async () => true,
      },
      tools: [createLedgerTool()],
      logger: new NullLogger(),
    });
    os = instance;
    const agent = instance.agent({ ...definition, id: `${definition.id}-stuck` });
    await agent.register();
    const run = await agent.createRun({
      goal: 'Unanswerable while the lock is held.',
      workspace: { copyFrom: REPO_DIR, ignore: ['.git'] },
    });
    await agent.start(run.id);

    const finished = await instance.runtime.getRun(run.id);
    expect(finished.status).toBe('FAILED');
    expect((await instance.runtime.result(run.id)).success).toBe(false);

    // It tried more than once - that is what recovery is - and stopped.
    const attempts = (await instance.store.actions.list(run.id)).filter(
      (entry) => entry.toolId === 'ledger.orders_over' && entry.status !== 'executing',
    );
    expect(attempts.length).toBeGreaterThan(1);
    expect(attempts.map((entry) => entry.status)).toEqual(
      attempts.map(() => 'failed'),
    );
  }, 180_000);

  it('runs the documented command for real', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'kazi-recovery-cli-'));
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(EXAMPLE_DIR, 'run.ts'), '--data-dir', dataDir],
      { cwd: dirname(EXAMPLE_DIR), encoding: 'utf8', timeout: 180_000 },
    );

    expect(result.stdout).toContain('database is locked');
    expect(result.stdout).toContain('RETRY          retry_with_backoff');
    expect(result.stdout).toContain('TOOL FAILURE');
    expect(result.stdout).toContain('SUCCESS');
    expect(result.stdout).toContain('Total: 85000 cents');
    expect(result.stderr).not.toContain('Error:');
    expect(result.status, result.stderr).toBe(0);
  }, 300_000);
});
