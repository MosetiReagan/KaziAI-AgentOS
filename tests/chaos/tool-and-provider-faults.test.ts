import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@kazi-ai/agentos';
import { FakeModelProvider } from '@kazi-ai/agentos-providers';
import { createTestAgentOS, type TestAgentOS } from '../helpers/agentos.js';
import { Chaos } from '../helpers/chaos.js';

/**
 * Spec §88: inject failures into the things the runtime depends on and check
 * that the run either recovers or stops cleanly — never half-executes and never
 * loses the record of what it tried.
 */

const pingTool = defineTool({
  id: 'chaos.ping',
  description: 'Return the value it was given',
  input: z.object({ value: z.string() }),
  idempotency: 'idempotent',
  risk: 'LOW',
  async execute(input: { value: string }) {
    return { echoed: input.value };
  },
});

let harness: TestAgentOS | undefined;
async function build(
  options: Parameters<typeof createTestAgentOS>[0] & { goal?: string },
): Promise<{ harness: TestAgentOS; os: TestAgentOS['os'] }> {
  harness = await createTestAgentOS({
    tools: ['chaos.ping'],
    extraTools: [pingTool],
    agent: { id: 'chaos-agent' },
    ...options,
  });
  return { harness, os: harness.os };
}

const PING_THEN_FINISH = [
  { text: 'pinging', toolCalls: [{ name: 'chaos.ping', arguments: { value: 'pong' } }] },
  { text: 'all done' },
];

describe('a tool that misbehaves', () => {
  it('retries a tool that fails once and still completes the goal', async () => {
    const chaos = new Chaos({ seed: 11, faults: [{ kind: 'tool_error', toolId: 'chaos.ping', times: 1 }] });
    const { harness, os } = await build({ chaos, turns: PING_THEN_FINISH });
    const finished = await harness.run('ping once');

    expect(chaos.fired.map((record) => record.kind)).toEqual(['tool_error']);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.result.success).toBe(true);

    // The failure, the classification and the recovery are all on the record.
    const recoveries = await os.store.recoveries.list(finished.id);
    expect(recoveries.length).toBeGreaterThanOrEqual(1);
    expect(recoveries[0]?.success).toBe(true);
    const journal = await os.store.actions.list(finished.id);
    expect(journal.some((entry) => entry.status === 'succeeded')).toBe(true);
    expect(journal.some((entry) => entry.status === 'failed')).toBe(true);
  });

  it('recovers from a tool that exceeds its timeout', async () => {
    const chaos = new Chaos({ seed: 12, faults: [{ kind: 'tool_timeout', toolId: 'chaos.ping', times: 1 }] });
    const { harness, os } = await build({ chaos, turns: PING_THEN_FINISH });
    const finished = await harness.run('ping with a hang');

    expect(chaos.firedOf('tool_timeout')).toHaveLength(1);
    expect(finished.status).toBe('COMPLETED');
    const journal = await os.store.actions.list(finished.id);
    const timedOut = journal.find((entry) => entry.status === 'failed');
    expect(timedOut?.error?.['code']).toBe('tool.timeout');
  });

  it('treats a network error inside a tool as a retryable infrastructure failure', async () => {
    const chaos = new Chaos({ seed: 13, faults: [{ kind: 'network_error', toolId: 'chaos.ping', times: 1 }] });
    const { harness } = await build({ chaos, turns: PING_THEN_FINISH });
    const finished = await harness.run('ping over a broken network');

    expect(chaos.firedOf('network_error')).toHaveLength(1);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.result.recoveryCount).toBeGreaterThanOrEqual(1);
  });
});

describe('a provider that misbehaves', () => {
  it('fails over to the fallback provider and records the model switch', async () => {
    const chaos = new Chaos({ seed: 14, faults: [{ kind: 'provider_timeout', times: 1 }] });
    // The fallback answers with the same script; only the route is different.
    const fallback = new FakeModelProvider({ id: 'fake-backup', turns: PING_THEN_FINISH, onExhausted: { text: 'done' } });
    const { harness, os } = await build({
      chaos,
      turns: PING_THEN_FINISH,
      extraProviders: [fallback],
      agent: { fallback: [{ provider: 'fake-backup', model: 'fake-1' }] },
    });
    const finished = await harness.run('survive the provider');

    expect(chaos.firedOf('provider_timeout')).toHaveLength(1);
    expect(finished.status).toBe('COMPLETED');
    expect(fallback.calls).toBeGreaterThan(0);

    const events = await os.store.events.list(finished.id);
    const failover = events.find((event) => event.type === 'model.failover');
    expect(failover).toBeDefined();
    expect(failover?.data['provider']).toBe('fake-backup');
  });

  it('contains a provider that answers with a malformed tool call', async () => {
    const chaos = new Chaos({ seed: 15, faults: [{ kind: 'invalid_provider_output', times: 1 }] });
    const { harness, os } = await build({ chaos, turns: PING_THEN_FINISH });
    const finished = await harness.run('survive a corrupt provider');

    expect(chaos.firedOf('invalid_provider_output')).toHaveLength(1);
    // Whatever the runtime decides, it must be a decision: a resting state with
    // the failure persisted, not a crash and not a stuck run.
    expect(['COMPLETED', 'FAILED']).toContain(finished.status);
    const run = await os.store.runs.get(finished.id);
    expect(['COMPLETED', 'FAILED']).toContain(run?.status);
    if (finished.status === 'FAILED') {
      expect(run?.error).toBeDefined();
      const failures = await os.store.failures.list(finished.id);
      expect(failures.length).toBeGreaterThanOrEqual(1);
    }
  });
});
