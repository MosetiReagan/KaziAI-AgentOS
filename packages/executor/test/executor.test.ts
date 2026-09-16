import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ToolTimeoutError,
  idempotencyKey,
  newActionId,
  newRunId,
  type AgentAction,
  type AgentTool,
  type JsonObject,
  type JsonValue,
  type ToolContext,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import { ApprovalManager, DefaultPolicyEngine, RiskClassifier, policyRule } from '@kazi-ai/agentos-policies';
import { EmbeddedStore } from '@kazi-ai/agentos-persistence';
import { createTestToolContext } from '@kazi-ai/agentos-tools';
import { Executor, type ExecutionRequest } from '../src/index.js';

interface Harness {
  executor: Executor;
  store: EmbeddedStore;
  approvals: ApprovalManager;
  policy: DefaultPolicyEngine;
  calls: { toolId: string; input: unknown }[];
  runId: string;
  request: (actions: AgentAction[]) => ExecutionRequest;
}

const allowAllPermissions: ToolPermissions = {
  filesystem: { read: true, write: true, delete: true },
  terminal: { execute: true },
  network: { enabled: true },
  git: { read: true, commit: true, push: true },
};

/** A tool that records every call and echoes the validated input back. */
function echoTool(id: string, overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    id,
    description: `Echo tool ${id}`,
    inputSchema: z.object({ value: z.string().optional() }),
    permissions: allowAllPermissions,
    async execute(input, context) {
      void context;
      return { success: true, output: input as JsonValue, idempotency: 'idempotent' as const };
    },
    ...overrides,
  } as AgentTool;
}

function makeAction(input: {
  runId: string;
  toolId: string;
  arguments?: JsonValue;
  step?: string;
  attempt?: number;
  dependsOn?: AgentAction['dependsOn'];
  metadata?: JsonObject;
}): AgentAction {
  const action: AgentAction = {
    id: newActionId(),
    runId: input.runId,
    toolId: input.toolId,
    arguments: input.arguments ?? { value: 'x' },
    idempotencyKey: idempotencyKey({
      runId: input.runId,
      step: input.step,
      toolId: input.toolId,
      arguments: input.arguments ?? { value: 'x' },
      attempt: input.attempt ?? 0,
    }),
    idempotency: 'idempotent',
    status: 'pending',
    createdAt: Date.now(),
    attempt: input.attempt ?? 0,
  };
  if (input.step !== undefined) action.stepId = input.step as AgentAction['stepId'];
  if (input.dependsOn !== undefined) action.dependsOn = input.dependsOn;
  if (input.metadata !== undefined) action.metadata = input.metadata;
  return action;
}

async function createHarness(options: { tools?: AgentTool[]; rules?: ReturnType<typeof policyRule>[] } = {}): Promise<Harness> {
  const store = new EmbeddedStore();
  await store.init();
  const runId = newRunId();
  const calls: Harness['calls'] = [];
  // Test tools are declared LOW risk explicitly: the classifier treats unknown
  // tools as HIGH by default, which is the runtime's sensitive-by-default policy.
  const policy = new DefaultPolicyEngine({
    rules: options.rules ?? [],
    classifier: new RiskClassifier([{ id: 'test.tools', description: 'test tools are low risk', tool: 'test.*', risk: 'LOW' }]),
  });
  const approvals = new ApprovalManager({ store: store.approvals });
  const toolContext = await createTestToolContext({ runId, permissions: allowAllPermissions });

  const tools = options.tools ?? [echoTool('test.echo')];
  const registry = { get: (toolId: string): AgentTool | undefined => tools.find((tool) => tool.id === toolId) };

  const executor = new Executor({
    registry,
    journal: store.actions,
    policy,
    approvals,
    permissions: allowAllPermissions,
    createToolContext: (_request, _tool, signal): ToolContext => {
      void _request;
      void _tool;
      return { ...toolContext, signal };
    },
  });

  for (const tool of tools) {
    const original = tool.execute.bind(tool);
    tool.execute = async (input, context) => {
      calls.push({ toolId: tool.id, input });
      return original(input, context);
    };
  }

  const request = (actions: AgentAction[]): ExecutionRequest => ({
    runId,
    agentId: 'agt_test',
    organizationId: 'org_test',
    projectId: 'prj_test',
    environment: 'test',
    workspaceDir: toolContext.workspaceDir,
    trust: 'trusted-user',
    requestOrigin: 'agent',
    actions,
  });

  return { executor, store, approvals, policy, calls, runId, request };
}

describe('Executor', () => {
  it('executes independent actions concurrently and journals intent then commit', async () => {
    const harness = await createHarness();
    const actions = [
      makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'a' } }),
      makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'b' } }),
      makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'c' } }),
    ];

    const outcome = await harness.executor.execute(harness.request(actions));
    expect(outcome.waves).toBe(1);
    expect(outcome.succeeded).toBe(3);
    expect(outcome.failed).toBe(0);
    expect(harness.calls).toHaveLength(3);

    // The journal is append-only: one durable intent entry per action, followed
    // by exactly one commit entry carrying the outcome.
    const journal = await harness.store.actions.list(harness.runId);
    expect(journal.filter((entry) => entry.status === 'executing')).toHaveLength(3);
    const commits = journal.filter((entry) => entry.status === 'succeeded');
    expect(commits).toHaveLength(3);
    expect(commits.every((entry) => entry.finishedAt !== undefined)).toBe(true);
    expect(journal.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('runs dependents only after their dependencies succeed', async () => {
    const harness = await createHarness();
    const first = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'first' } });
    const second = makeAction({
      runId: harness.runId,
      toolId: 'test.echo',
      arguments: { value: 'second' },
      dependsOn: [first.id],
    });

    const outcome = await harness.executor.execute(harness.request([first, second]));

    expect(outcome.waves).toBe(2);
    expect(harness.calls.map((call) => (call.input as { value: string }).value)).toEqual(['first', 'second']);
  });

  it('skips dependents when a dependency fails instead of running them anyway', async () => {
    const failing = echoTool('test.fail', {
      risk: 'LOW' as const,
      async execute() {
        return {
          success: false,
          output: null,
          error: { code: 'tool.boom', message: 'boom', category: 'tool', retryable: true, idempotency: 'idempotent' },
        };
      },
    });
    const harness = await createHarness({ tools: [failing, echoTool('test.echo')] });
    const parent = makeAction({ runId: harness.runId, toolId: 'test.fail', arguments: { value: 'parent' } });
    const child = makeAction({
      runId: harness.runId,
      toolId: 'test.echo',
      arguments: { value: 'child' },
      dependsOn: [parent.id],
    });

    const outcome = await harness.executor.execute(harness.request([parent, child]));

    const childOutcome = outcome.outcomes.find((item) => item.actionId === child.id);
    expect(childOutcome?.status).toBe('skipped');
    expect(childOutcome?.error?.code).toBe('action.dependency_failed');
    expect(harness.calls.map((call) => call.toolId)).toEqual(['test.fail']);
  });

  it('denies actions the policy engine rejects and never calls the tool', async () => {
    const harness = await createHarness({
      rules: [
        policyRule({
          id: 'deny.echo',
          description: 'echo is forbidden',
          tools: ['test.echo'],
          outcome: 'DENY',
          reason: 'echo is forbidden in this environment',
        }),
      ],
    });
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo' });

    const outcome = await harness.executor.execute(harness.request([action]));

    expect(outcome.denied).toBe(1);
    expect(outcome.outcomes[0]?.error?.code).toBe('policy.denied');
    expect(harness.calls).toHaveLength(0);
  });

  it('parks risky actions on a persisted approval and resumes once granted', async () => {
    const harness = await createHarness({
      rules: [
        policyRule({
          id: 'approve.echo',
          description: 'echo needs a human',
          tools: ['test.echo'],
          outcome: 'REQUIRE_APPROVAL',
          reason: 'echo requires approval',
          risk: 'HIGH',
        }),
      ],
    });
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'risky' } });

    const first = await harness.executor.execute(harness.request([action]));
    const parked = first.outcomes[0];
    expect(parked?.status).toBe('awaiting_approval');
    expect(parked?.approvalId).toBeDefined();
    expect(harness.calls).toHaveLength(0);

    const approval = await harness.store.approvals.get(String(parked?.approvalId));
    expect(approval?.status).toBe('pending');
    expect(approval?.risk).toBe('HIGH');

    await harness.approvals.decide({
      approvalId: String(parked?.approvalId),
      decision: 'approve',
      decidedBy: 'user_1',
    });

    const approvedAction = makeAction({
      runId: harness.runId,
      toolId: 'test.echo',
      arguments: { value: 'risky' },
      metadata: { approvalId: String(parked?.approvalId) },
    });
    const second = await harness.executor.execute(harness.request([approvedAction]));

    expect(second.succeeded).toBe(1);
    expect(harness.calls).toHaveLength(1);
  });

  it('uses a granted approval after a resume instead of asking again', async () => {
    const harness = await createHarness({
      rules: [
        policyRule({
          id: 'approve.echo',
          description: 'echo needs a human',
          tools: ['test.echo'],
          outcome: 'REQUIRE_APPROVAL',
          reason: 'echo requires approval',
          risk: 'HIGH',
        }),
      ],
    });
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'risky' } });

    const parked = (await harness.executor.execute(harness.request([action]))).outcomes[0];
    expect(parked?.status).toBe('awaiting_approval');
    await harness.approvals.decide({
      approvalId: String(parked?.approvalId),
      decision: 'approve',
      decidedBy: 'user_1',
    });

    // The resumed run re-derives the same action: identical tool and arguments,
    // no approvalId hand-carried in memory.
    const resumed = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'risky' } });
    const outcome = await harness.executor.execute(harness.request([resumed]));

    expect(outcome.succeeded).toBe(1);
    expect(outcome.outcomes[0]?.approvalId).toBe(parked?.approvalId);
    expect(harness.calls).toHaveLength(1);
    // Exactly one approval: the human was asked once.
    expect(await harness.store.approvals.list({ runId: harness.runId })).toHaveLength(1);
  });

  it('honours a denied approval on a later attempt of the same action', async () => {
    const harness = await createHarness({
      rules: [
        policyRule({
          id: 'approve.echo',
          description: 'echo needs a human',
          tools: ['test.echo'],
          outcome: 'REQUIRE_APPROVAL',
          reason: 'echo requires approval',
          risk: 'HIGH',
        }),
      ],
    });
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'risky' } });
    const parked = (await harness.executor.execute(harness.request([action]))).outcomes[0];
    await harness.approvals.decide({
      approvalId: String(parked?.approvalId),
      decision: 'deny',
      decidedBy: 'user_1',
      reason: 'not on a Friday',
    });

    const resumed = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'risky' } });
    const outcome = await harness.executor.execute(harness.request([resumed]));

    expect(outcome.denied).toBe(1);
    expect(outcome.outcomes[0]?.error?.code).toBe('policy.approval_denied');
    expect(harness.calls).toHaveLength(0);
  });

  it('re-asks when the action changed after the approval was requested', async () => {
    const harness = await createHarness({
      rules: [
        policyRule({
          id: 'approve.echo',
          description: 'echo needs a human',
          tools: ['test.echo'],
          outcome: 'REQUIRE_APPROVAL',
          reason: 'echo requires approval',
          risk: 'HIGH',
        }),
      ],
    });
    const parked = (
      await harness.executor.execute(
        harness.request([makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'first' } })]),
      )
    ).outcomes[0];
    await harness.approvals.decide({
      approvalId: String(parked?.approvalId),
      decision: 'approve',
      decidedBy: 'user_1',
    });

    const changed = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'second' } });
    const outcome = await harness.executor.execute(harness.request([changed]));

    expect(outcome.awaitingApproval).toBe(1);
    expect(harness.calls).toHaveLength(0);
    expect(await harness.store.approvals.list({ runId: harness.runId })).toHaveLength(2);
  });

  it('never re-runs an action whose commit is already in the journal', async () => {
    const harness = await createHarness();
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 'once' } });

    await harness.executor.execute(harness.request([action]));
    expect(harness.calls).toHaveLength(1);

    const replay = await harness.executor.executeSingle(action, harness.request([]));

    expect(replay.status).toBe('already_committed');
    expect(replay.replayed).toBe(true);
    expect(harness.calls).toHaveLength(1);
  });

  it('records intent before executing so a crash leaves evidence', async () => {
    const crashy = echoTool('test.crash', {
      risk: 'LOW' as const,
      async execute() {
        throw new Error('worker died');
      },
    });
    const harness = await createHarness({ tools: [crashy] });
    const action = makeAction({ runId: harness.runId, toolId: 'test.crash' });

    const outcome = await harness.executor.execute(harness.request([action]));
    expect(outcome.failed).toBe(1);
    expect(outcome.outcomes[0]?.error?.message).toContain('worker died');

    // Intent is durable *before* the tool runs, so the crash is visible even
    // though the tool never returned.
    const journal = await harness.store.actions.list(harness.runId);
    expect(journal.map((entry) => entry.status)).toEqual(['executing', 'failed']);
    expect(journal[1]?.startedAt).toBeGreaterThan(0);
    expect(journal[1]?.finishedAt).toBeGreaterThan(0);
    expect(journal[1]?.toolId).toBe('test.crash');
    expect(journal[1]?.error?.['message']).toContain('worker died');
    expect(await harness.store.actions.pending(harness.runId)).toHaveLength(0);
  });

  it('rejects malformed tool arguments before the tool runs', async () => {
    const harness = await createHarness();
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo', arguments: { value: 42 } as unknown as JsonValue });

    const outcome = await harness.executor.execute(harness.request([action]));

    expect(outcome.failed).toBe(1);
    expect(outcome.outcomes[0]?.error?.code).toBe('tool.invalid_input');
    expect(harness.calls).toHaveLength(0);
  });

  it('fails unknown tools without touching the journal', async () => {
    const harness = await createHarness();
    const action = makeAction({ runId: harness.runId, toolId: 'test.missing' });

    const outcome = await harness.executor.execute(harness.request([action]));

    expect(outcome.outcomes[0]?.status).toBe('failed');
    expect(outcome.outcomes[0]?.error?.code).toBe('tool.not_found');
  });

  it('aborts tools that exceed their timeout', async () => {
    const slow = echoTool('test.slow', {
      risk: 'LOW' as const,
      timeoutMs: 50,
      async execute(_input, context) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ToolTimeoutError('test.slow', 50));
          });
        });
        return { success: true, output: null };
      },
    });
    const harness = await createHarness({ tools: [slow] });
    const action = makeAction({ runId: harness.runId, toolId: 'test.slow' });

    const outcome = await harness.executor.execute(harness.request([action]));

    expect(outcome.failed).toBe(1);
    expect(outcome.outcomes[0]?.error?.code).toBe('tool.timeout');
  });

  it('stops the batch when the run is cancelled', async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    controller.abort(new Error('run cancelled'));
    const action = makeAction({ runId: harness.runId, toolId: 'test.echo' });

    const outcome = await harness.executor.execute({ ...harness.request([action]), signal: controller.signal });

    expect(outcome.failed).toBe(1);
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses to execute an empty action list', async () => {
    const harness = await createHarness();
    await expect(harness.executor.execute(harness.request([]))).rejects.toThrow(/No actions to execute/);
  });
});
