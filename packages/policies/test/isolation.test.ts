import { describe, expect, it } from 'vitest';
import { newActionId, type AgentAction, type JsonValue, type PolicyContext } from '@kazi-ai/agentos-core';
import { DEFAULT_RULES, DefaultPolicyEngine, environmentIsolates } from '../src/index.js';

function action(toolId: string, sandbox?: JsonValue): AgentAction {
  return {
    id: newActionId(),
    runId: 'run_1',
    toolId,
    arguments: { command: 'cat', args: ['/etc/passwd'] },
    idempotencyKey: 'idem_1',
    idempotency: 'non-idempotent',
    status: 'pending',
    createdAt: Date.now(),
    attempt: 1,
    metadata: sandbox === undefined ? {} : { sandbox },
  };
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    runId: 'run_1',
    agentId: 'developer',
    organizationId: 'org_1',
    projectId: 'prj_1',
    environment: 'local',
    workspaceDir: '/tmp/ws',
    trust: 'trusted-policy',
    requestOrigin: 'agent',
    ...overrides,
  };
}

const engine = () => new DefaultPolicyEngine({ rules: DEFAULT_RULES });
const ISOLATION_TOOL: JsonValue = { workspaceConfined: true, requiresIsolation: true };

describe('a tool that needs an isolated sandbox', () => {
  it('is denied on an environment that does not isolate it', async () => {
    const decision = await engine().evaluate(action('terminal.exec', ISOLATION_TOOL), context());
    expect(decision.outcome).toBe('DENY');
    expect(decision.ruleId).toBe('deny.sandbox.unisolated');
    expect(decision.risk).toBe('HIGH');
    expect(decision.reason).toContain('isolated sandbox');
  });

  it('is denied when no environment is configured at all', async () => {
    const decision = await engine().evaluate(
      action('terminal.exec', ISOLATION_TOOL),
      context({ environment: 'none' }),
    );
    expect(decision.outcome).toBe('DENY');
  });

  it('is allowed once the run says out loud that it accepts host execution', async () => {
    const decision = await engine().evaluate(
      action('terminal.exec', ISOLATION_TOOL),
      context({
        metadata: {
          isolatingEnvironment: false,
          permissions: { terminal: { execute: true, allowUnisolated: true } },
        },
      }),
    );
    expect(decision.outcome).toBe('ALLOW');
    expect(decision.ruleId).not.toBe('deny.sandbox.unisolated');
  });

  it('is allowed when the environment really isolates, opt-in or not', async () => {
    const declared = await engine().evaluate(
      action('terminal.exec', ISOLATION_TOOL),
      context({ environment: 'local', metadata: { isolatingEnvironment: true } }),
    );
    expect(declared.outcome).toBe('ALLOW');

    const byKind = await engine().evaluate(
      action('terminal.exec', ISOLATION_TOOL),
      context({ environment: 'docker' }),
    );
    expect(byKind.outcome).toBe('ALLOW');
  });

  it('does not fire for a tool that never asked for isolation', async () => {
    const decision = await engine().evaluate(
      action('filesystem.read', { workspaceConfined: true }),
      context(),
    );
    expect(decision.ruleId).not.toBe('deny.sandbox.unisolated');
  });

  it('cannot be talked into it by a malformed permissions blob', async () => {
    for (const permissions of [null, 'yes', [], { terminal: 'allowUnisolated' }, { terminal: { allowUnisolated: 'true' } }]) {
      const decision = await engine().evaluate(
        action('terminal.exec', ISOLATION_TOOL),
        context({ metadata: { isolatingEnvironment: false, permissions } }),
      );
      expect(decision.outcome).toBe('DENY');
    }
  });

  it('treats an unknown environment kind as unisolated', async () => {
    const decision = await engine().evaluate(
      action('terminal.exec', ISOLATION_TOOL),
      context({ environment: 'someones-laptop' }),
    );
    expect(decision.outcome).toBe('DENY');
  });
});

describe('environmentIsolates', () => {
  it('trusts an explicit declaration over the kind', () => {
    expect(environmentIsolates(context({ environment: 'local', metadata: { isolatingEnvironment: true } }))).toBe(true);
    expect(environmentIsolates(context({ environment: 'docker', metadata: { isolatingEnvironment: false } }))).toBe(true);
    expect(environmentIsolates(context({ environment: 'docker' }))).toBe(true);
    expect(environmentIsolates(context({ environment: 'local' }))).toBe(false);
  });
});
