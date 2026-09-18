import { describe, expect, it } from 'vitest';
import { newActionId, type AgentAction, type Approval, type ApprovalStore, type PolicyContext } from '@kazi-ai/agentos-core';
import {
  ApprovalManager,
  CompositePolicyProvider,
  DEFAULT_RULES,
  DefaultPolicyEngine,
  RemotePolicyProvider,
  RiskClassifier,
  actionHash,
  mostRestrictive,
  policyRule,
  policyRuleSpec,
} from '../src/index.js';

function action(toolId: string, args: Record<string, unknown> = {}): AgentAction {
  return {
    id: newActionId(),
    runId: 'run_1',
    toolId,
    arguments: args as AgentAction['arguments'],
    idempotencyKey: 'idem_1',
    idempotency: 'idempotent',
    status: 'pending',
    createdAt: Date.now(),
    attempt: 1,
  };
}

const context: PolicyContext = {
  runId: 'run_1',
  agentId: 'developer',
  organizationId: 'org_1',
  projectId: 'prj_1',
  environment: 'development',
  workspaceDir: '/tmp/ws',
  trust: 'trusted-system',
  requestOrigin: 'agent',
};

describe('risk classification', () => {
  const classifier = new RiskClassifier();

  it('classifies by tool and by argument shape', () => {
    expect(classifier.classify(action('filesystem.read', { path: 'a' })).risk).toBe('LOW');
    expect(classifier.classify(action('filesystem.write', { path: 'a' })).risk).toBe('MEDIUM');
    expect(classifier.classify(action('filesystem.delete', { path: 'a' })).risk).toBe('HIGH');
    expect(classifier.classify(action('filesystem.delete', { path: '/prod/data' })).risk).toBe('CRITICAL');
    expect(classifier.classify(action('terminal.exec', { command: 'ls' })).risk).toBe('MEDIUM');
    expect(classifier.classify(action('terminal.exec', { command: 'rm', args: ['-rf', '/'] })).risk).toBe('CRITICAL');
    expect(classifier.classify(action('git', { operation: 'push' })).risk).toBe('CRITICAL');
    expect(classifier.classify(action('git', { operation: 'status' })).risk).toBe('LOW');
    expect(classifier.classify(action('database.query', { sql: 'select 1' })).risk).toBe('MEDIUM');
    expect(classifier.classify(action('database.query', { sql: 'drop table users' })).risk).toBe('CRITICAL');
    expect(classifier.classify(action('unknown.tool', {})).risk).toBe('HIGH');
  });

  it('never classifies a tool below the risk the tool declares', () => {
    const declared: Record<string, 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'> = {
      'mcp.prod.dangerous_tool': 'CRITICAL',
      'mcp.notes.list_notes': 'MEDIUM',
      'filesystem.read': 'LOW',
    };
    const floored = new RiskClassifier(undefined, undefined, { toolRisk: (toolId) => declared[toolId] });

    const critical = floored.classify(action('mcp.prod.dangerous_tool', {}));
    expect(critical.risk).toBe('CRITICAL');
    expect(critical.ruleId).toBe('mcp.tool+declared');
    expect(critical.description).toContain('declares itself CRITICAL');
    // A declared floor raises risk but never lowers it.
    expect(floored.classify(action('filesystem.read', { path: 'a' })).risk).toBe('LOW');
    expect(floored.classify(action('filesystem.delete', { path: 'a' })).risk).toBe('HIGH');
    expect(floored.classify(action('terminal.exec', { command: 'rm', args: ['-rf', '/'] })).risk).toBe('CRITICAL');
    // MEDIUM declaration on an unknown tool still beats the HIGH default? No:
    // the floor only raises, and the default is already higher.
    expect(floored.classify(action('unknown.tool', {})).risk).toBe('HIGH');
    expect(floored.classify(action('mcp.advanced.tool', {})).risk).toBe('MEDIUM');
  });

  it('trusts a declaration for a tool no rule knows about', () => {
    // A locally registered tool that declares itself LOW is not silently
    // escalated to "unknown, therefore approval" — otherwise `defineTool`'s
    // declaration would be meaningless (spec §13, §23).
    const classifier = new RiskClassifier(undefined, undefined, {
      toolRisk: (toolId) => (toolId === 'weather.get' ? 'LOW' : undefined),
    });

    const declared = classifier.classify(action('weather.get', { city: 'Nairobi' }));
    expect(declared.risk).toBe('LOW');
    expect(declared.ruleId).toBe('risk.declared');

    // A tool that declares nothing still defaults to HIGH → approval.
    expect(classifier.classify(action('mystery.tool', {})).risk).toBe('HIGH');
    // And a remote tool is matched by the operator's `mcp.*` rule first, where
    // the declaration can only ever raise risk.
    expect(classifier.classify(action('mcp.notes.list_notes', {})).risk).toBe('MEDIUM');
  });

  it('gates an approval on a tool that declares itself critical', async () => {
    const engine = new DefaultPolicyEngine({
      rules: DEFAULT_RULES,
      classifier: new RiskClassifier(undefined, undefined, { toolRisk: () => 'CRITICAL' }),
    });
    const decision = await engine.evaluate(action('mcp.prod.deploy', {}), context);
    expect(decision.outcome).toBe('REQUIRE_APPROVAL');
    expect(decision.risk).toBe('CRITICAL');
  });
});

describe('policy engine', () => {
  it('requires approval for git push and denies force pushes', async () => {
    const engine = new DefaultPolicyEngine({ rules: DEFAULT_RULES });
    const push = await engine.evaluate(action('git', { operation: 'push', remote: 'origin' }), context);
    expect(push).toMatchObject({ outcome: 'REQUIRE_APPROVAL', risk: 'CRITICAL' });

    const force = await engine.evaluate(action('terminal.exec', { command: 'git', args: ['push', '--force', 'origin', 'main'] }), context);
    expect(force.outcome).toBe('DENY');
  });

  it('requires approval above the configured risk threshold', async () => {
    const engine = new DefaultPolicyEngine({ approvalRisk: 'HIGH' });
    expect((await engine.evaluate(action('filesystem.read', { path: 'a' }), context)).outcome).toBe('ALLOW');
    expect((await engine.evaluate(action('filesystem.write', { path: 'a' }), context)).outcome).toBe('ALLOW');
    expect((await engine.evaluate(action('filesystem.delete', { path: 'a' }), context)).outcome).toBe('REQUIRE_APPROVAL');
    expect((await engine.evaluate(action('filesystem.delete', { path: '/prod/x' }), context)).outcome).toBe('REQUIRE_APPROVAL');
  });

  it('denies everything above the deny threshold when configured', async () => {
    const engine = new DefaultPolicyEngine({ denyRisk: 'CRITICAL' });
    expect((await engine.evaluate(action('terminal.exec', { command: 'rm', args: ['-rf', '/'] }), context)).outcome).toBe('DENY');
  });

  it('takes the strictest of a rule and the risk classification', async () => {
    const engine = new DefaultPolicyEngine({
      rules: [policyRule({ id: 'allow-all-fs', description: 'allow', tools: ['filesystem.*'], outcome: 'ALLOW', risk: 'LOW' })],
    });
    const decision = await engine.evaluate(action('filesystem.delete', { path: 'a' }), context);
    // Rule says ALLOW, but classification says HIGH, so approval is still required.
    expect(decision.risk).toBe('HIGH');
  });

  it('fails closed when a rule throws', async () => {
    const engine = new DefaultPolicyEngine({
      rules: [
        {
          id: 'broken',
          description: 'throws',
          priority: 100,
          evaluate: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const decision = await engine.evaluate(action('filesystem.read', { path: 'a' }), context);
    expect(decision.outcome).toBe('DENY');
    expect(decision.ruleId).toBe('broken:error');
  });

  it('rejects duplicate rule ids', () => {
    const engine = new DefaultPolicyEngine({ rules: DEFAULT_RULES });
    expect(() =>
      engine.register(policyRule({ id: 'deny.terminal.force-push', description: 'dup', tools: ['x'], outcome: 'DENY' })),
    ).toThrow(/already registered/);
  });

  it('records every decision for auditing', async () => {
    const engine = new DefaultPolicyEngine();
    await engine.evaluate(action('filesystem.read', { path: 'a' }), context);
    await engine.evaluate(action('filesystem.delete', { path: 'a' }), context);
    expect(engine.history()).toHaveLength(2);
  });
});

describe('remote policy provider', () => {
  it('fails closed when the remote authorizer is unavailable', async () => {
    const provider = new RemotePolicyProvider({
      id: 'sentinel',
      endpoint: 'https://sentinel.invalid/authorize',
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    const decision = await provider.authorize(action('filesystem.read', { path: 'a' }), context);
    expect(decision.outcome).toBe('DENY');
  });

  it('combines local and remote decisions using the strictest outcome', () => {
    const local = { outcome: 'ALLOW' as const, ruleId: 'local', reason: 'ok', risk: 'LOW' as const };
    const remote = { outcome: 'REQUIRE_APPROVAL' as const, ruleId: 'remote', reason: 'needs human', risk: 'HIGH' as const };
    expect(mostRestrictive(local, remote).outcome).toBe('REQUIRE_APPROVAL');
    expect(mostRestrictive(remote, local).outcome).toBe('REQUIRE_APPROVAL');
  });

  it('composes local and remote providers', async () => {
    const composite = new CompositePolicyProvider({
      local: new DefaultPolicyEngine({ approvalRisk: 'CRITICAL' }),
      remote: new RemotePolicyProvider({
        id: 'sentinel',
        endpoint: 'https://sentinel/authorize',
        fetchImpl: async () =>
          new Response(JSON.stringify({ outcome: 'ALLOW', ruleId: 'sentinel:ok', reason: 'fine', risk: 'LOW' }), { status: 200 }),
      }),
    });
    const decision = await composite.authorize(action('filesystem.read', { path: 'a' }), context);
    expect(decision.outcome).toBe('ALLOW');
  });
});

function memoryApprovalStore(): ApprovalStore {
  const entries = new Map<string, Approval>();
  return {
    create: async (approval) => {
      entries.set(approval.id, approval);
    },
    get: async (id) => entries.get(id),
    update: async (approval) => {
      entries.set(approval.id, approval);
    },
    list: async (filter) =>
      [...entries.values()].filter((approval) => {
        if (filter.runId && approval.runId !== filter.runId) return false;
        if (filter.status && approval.status !== filter.status) return false;
        return true;
      }),
    pending: async () => [...entries.values()].filter((approval) => approval.status === 'pending'),
  };
}

describe('approval manager', () => {
  it('persists the request and resolves it once granted', async () => {
    const store = memoryApprovalStore();
    const manager = new ApprovalManager({ store });
    const target = action('git', { operation: 'push' });
    const approval = await manager.request({
      runId: 'run_1',
      organizationId: 'org_1',
      projectId: 'prj_1',
      action: target,
      risk: 'CRITICAL',
      reason: 'push requires approval',
      summary: 'git push origin main',
    });
    expect(approval.status).toBe('pending');
    await expect(manager.resolve({ approvalId: approval.id, action: target })).rejects.toBeTruthy();

    await manager.decide({ approvalId: approval.id, decision: 'approve', decidedBy: 'ops@example.com' });
    const resolved = await manager.resolve({ approvalId: approval.id, action: target });
    expect(resolved.arguments).toEqual(target.arguments);
  });

  it('refuses to reuse an approval for a different payload', async () => {
    const store = memoryApprovalStore();
    const manager = new ApprovalManager({ store });
    const target = action('git', { operation: 'push', remote: 'origin' });
    const approval = await manager.request({
      runId: 'run_1',
      organizationId: 'org_1',
      projectId: 'prj_1',
      action: target,
      risk: 'CRITICAL',
      reason: 'push',
      summary: 'push',
    });
    await manager.decide({ approvalId: approval.id, decision: 'approve', decidedBy: 'ops' });
    const tampered = action('git', { operation: 'push', remote: 'attacker' });
    await expect(manager.resolve({ approvalId: approval.id, action: tampered })).rejects.toMatchObject({
      code: 'policy.approval_denied',
    });
  });

  it('honours a modified approval by substituting arguments', async () => {
    const store = memoryApprovalStore();
    const manager = new ApprovalManager({ store });
    const target = action('filesystem.delete', { path: '/prod/data' });
    const approval = await manager.request({
      runId: 'run_1',
      organizationId: 'org_1',
      projectId: 'prj_1',
      action: target,
      risk: 'CRITICAL',
      reason: 'delete production data',
      summary: 'delete',
    });
    await manager.decide({
      approvalId: approval.id,
      decision: 'modify',
      decidedBy: 'ops',
      modifiedArguments: { path: '/staging/data' },
    });
    const resolved = await manager.resolve({ approvalId: approval.id, action: target });
    expect(resolved.arguments).toEqual({ path: '/staging/data' });
  });

  it('rejects a denied request', async () => {
    const store = memoryApprovalStore();
    const manager = new ApprovalManager({ store });
    const target = action('git', { operation: 'push' });
    const approval = await manager.request({
      runId: 'run_1',
      organizationId: 'org_1',
      projectId: 'prj_1',
      action: target,
      risk: 'CRITICAL',
      reason: 'push',
      summary: 'push',
    });
    await manager.decide({ approvalId: approval.id, decision: 'deny', decidedBy: 'ops', reason: 'not today' });
    await expect(manager.resolve({ approvalId: approval.id, action: target })).rejects.toMatchObject({
      code: 'policy.approval_denied',
    });
  });

  it('expires approvals past their ttl', async () => {
    let now = 1_000;
    const store = memoryApprovalStore();
    const manager = new ApprovalManager({ store, ttlMs: 100, now: () => now });
    const target = action('git', { operation: 'push' });
    const approval = await manager.request({
      runId: 'run_1',
      organizationId: 'org_1',
      projectId: 'prj_1',
      action: target,
      risk: 'CRITICAL',
      reason: 'push',
      summary: 'push',
    });
    await manager.decide({ approvalId: approval.id, decision: 'approve', decidedBy: 'ops' });
    now = 5_000;
    await expect(manager.resolve({ approvalId: approval.id, action: target })).rejects.toMatchObject({
      code: 'policy.approval_denied',
    });
  });

  it('fingerprints actions deterministically', () => {
    expect(actionHash({ toolId: 'git', arguments: { a: 1, b: 2 } })).toBe(
      actionHash({ toolId: 'git', arguments: { b: 2, a: 1 } }),
    );
    expect(actionHash({ toolId: 'git', arguments: { a: 1 } })).not.toBe(actionHash({ toolId: 'git', arguments: { a: 2 } }));
  });
});

describe('policy rule introspection', () => {
  it('keeps the declarative spec of a rule so it can be shown or exported', () => {
    const rule = policyRule({
      id: 'require-approval.git.push',
      description: 'Pushing requires approval',
      tools: ['git'],
      outcome: 'REQUIRE_APPROVAL',
      risk: 'CRITICAL',
      priority: 90,
    });
    expect(policyRuleSpec(rule)).toEqual({
      id: 'require-approval.git.push',
      description: 'Pushing requires approval',
      tools: ['git'],
      outcome: 'REQUIRE_APPROVAL',
      risk: 'CRITICAL',
      priority: 90,
    });
    expect(
      policyRuleSpec({ id: 'x', description: 'x', evaluate: () => undefined }),
    ).toBeUndefined();
  });

  it('survives registration, ordering and copying inside the engine', () => {
    const engine = new DefaultPolicyEngine();
    for (const rule of DEFAULT_RULES) engine.register(rule);
    const listed = engine.list();
    expect(listed).toHaveLength(DEFAULT_RULES.length);
    for (const rule of listed) expect(policyRuleSpec(rule)?.id).toBe(rule.id);
  });
});
