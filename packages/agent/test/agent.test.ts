import { describe, expect, it } from 'vitest';
import { ValidationError, hashObject } from '@kazi-ai/agentos-core';
import {
  AgentRegistry,
  InMemoryPromptRegistry,
  effectiveConfig,
  parseAgentDefinition,
  parseAgentDefinitionYaml,
  runInputFromDefinition,
  serializeAgentDefinition,
} from '../src/index.js';

const CODING_AGENT = `
id: coding-agent
version: 1.0.0
name: Coding Agent
description: Fixes failing tests.

model:
  provider: openai-compatible
  model: gpt-5.6
  temperature: 0.2

providers:
  primary:
    provider: openai-compatible
    model: gpt-5.6
  fallback:
    - provider: ollama
      model: llama-local

system_prompt: |
  You are a software engineering agent.

tools:
  - filesystem.read
  - filesystem.write
  - terminal.exec
  - git

memory:
  enabled: true
  ttl_seconds: 86400

planning:
  enabled: true
  max_steps: 40

verification:
  enabled: true
  commands:
    - pnpm test

recovery:
  enabled: true
  tool_timeout:
    strategy: retry
    max_attempts: 3
  authentication_failure:
    strategy: ask_human

limits:
  max_steps: 100
  max_duration_seconds: 1800
  max_cost_usd: 5

permissions:
  filesystem:
    read: true
    write: true
    delete: false
  terminal:
    execute: true
    deny_commands:
      - "rm -rf*"
  network:
    enabled: false
  git:
    commit: true
    push: false

checkpointing:
  after_plan: true
  before_risky_action: true
  retain: 25
`;

describe('parseAgentDefinitionYaml', () => {
  it('parses the documented agent definition', () => {
    const definition = parseAgentDefinitionYaml(CODING_AGENT);

    expect(definition.id).toBe('coding-agent');
    expect(definition.version).toBe('1.0.0');
    expect(definition.model).toEqual({ provider: 'openai-compatible', model: 'gpt-5.6', temperature: 0.2 });
    expect(definition.providers?.fallback).toEqual([{ provider: 'ollama', model: 'llama-local' }]);
    expect(definition.systemPrompt).toContain('software engineering agent');
    expect(definition.tools).toEqual(['filesystem.read', 'filesystem.write', 'terminal.exec', 'git']);
    expect(definition.memory).toEqual({ enabled: true, ttlSeconds: 86_400 });
    expect(definition.planning).toEqual({ enabled: true, maxSteps: 40 });
    expect(definition.verification).toEqual({ enabled: true, commands: ['pnpm test'] });
    expect(definition.limits).toEqual({ maxSteps: 100, maxDurationSeconds: 1800, maxCostUsd: 5 });
    expect(definition.permissions.filesystem).toEqual({ read: true, write: true, delete: false });
    expect(definition.permissions.terminal?.denyCommands).toEqual(['rm -rf*']);
    expect(definition.permissions.network).toEqual({ enabled: false });
    expect(definition.permissions.git).toEqual({ commit: true, push: false });
    expect(definition.checkpointing).toEqual({ afterPlan: true, beforeRiskyAction: true, retain: 25 });
  });

  it('translates recovery policies into the runtime policy map', () => {
    const definition = parseAgentDefinitionYaml(CODING_AGENT);
    expect(definition.recovery.enabled).toBe(true);
    expect(definition.recovery.policies['tool_timeout']).toEqual({ kind: 'tool_timeout', strategy: 'retry', maxAttempts: 3 });
    expect(definition.recovery.policies['authentication_failure']?.strategy).toBe('ask_human');
  });

  it('accepts shorthands for the enabled flags', () => {
    const definition = parseAgentDefinition({
      id: 'minimal',
      version: '0.1.0',
      model: { provider: 'fake', model: 'fake-1' },
      system_prompt: 'hi',
      memory: false,
      planning: false,
      verification: false,
      recovery: false,
    });
    expect(definition.memory.enabled).toBe(false);
    expect(definition.planning.enabled).toBe(false);
    expect(definition.verification.enabled).toBe(false);
    expect(definition.recovery.enabled).toBe(false);
    expect(definition.tools).toEqual([]);
    expect(definition.limits).toEqual({});
  });

  it('accepts a prompt registry reference', () => {
    const definition = parseAgentDefinition({
      id: 'registry-agent',
      version: '2.0.0',
      model: { provider: 'fake', model: 'fake-1' },
      system_prompt: { registry: 'kazi://agents/coding/system', version: '2.1.0' },
    });
    expect(definition.systemPrompt).toEqual({ registry: 'kazi://agents/coding/system', version: '2.1.0' });
  });

  it('rejects unknown keys instead of ignoring typos', () => {
    expect(() =>
      parseAgentDefinition({
        id: 'typo-agent',
        version: '1.0.0',
        model: { provider: 'fake', model: 'fake-1' },
        system_prompt: 'hi',
        limmits: { max_steps: 5 },
      }),
    ).toThrow(ValidationError);
  });

  it('rejects invalid ids, versions and malformed recovery strategies', () => {
    expect(() =>
      parseAgentDefinition({
        id: 'Bad Agent',
        version: '1.0.0',
        model: { provider: 'fake', model: 'fake-1' },
        system_prompt: 'hi',
      }),
    ).toThrow(/agent ids use lowercase/);

    expect(() =>
      parseAgentDefinition({
        id: 'agent',
        version: 'v1',
        model: { provider: 'fake', model: 'fake-1' },
        system_prompt: 'hi',
      }),
    ).toThrow(/semver/);

    expect(() =>
      parseAgentDefinition({
        id: 'agent',
        version: '1.0.0',
        model: { provider: 'fake', model: 'fake-1' },
        system_prompt: 'hi',
        recovery: { tool_timeout: { strategy: 'hope' } },
      }),
    ).toThrow(/Unknown recovery strategy/);

    expect(() =>
      parseAgentDefinition({
        id: 'agent',
        version: '1.0.0',
        model: { provider: 'fake', model: 'fake-1' },
        system_prompt: 'hi',
        recovery: { tool_timeout: { strategy: 'retry', max_attempts: -1 } },
      }),
    ).toThrow(/non-negative integer/);
  });

  it('round-trips through the stored (snake_case) form', () => {
    const definition = parseAgentDefinitionYaml(CODING_AGENT);
    const reparsed = parseAgentDefinition(JSON.parse(JSON.stringify(serializeAgentDefinition(definition))));
    expect(reparsed).toEqual(definition);
    expect(serializeAgentDefinition(reparsed)).toEqual(serializeAgentDefinition(definition));
  });

  it('reports a useful error for invalid YAML', () => {
    expect(() => parseAgentDefinitionYaml('id: [unclosed')).toThrow(/not valid YAML/);
    expect(() => parseAgentDefinitionYaml('- just\n- a list')).toThrow(/must be a YAML mapping/);
  });
});

describe('AgentRegistry', () => {
  it('registers versions and resolves the newest by default', async () => {
    const registry = new AgentRegistry();
    registry.registerSync({ organizationId: 'org_1', projectId: 'prj_1', definition: parseAgentDefinitionYaml(CODING_AGENT) });
    registry.registerSync({
      organizationId: 'org_1',
      projectId: 'prj_1',
      definition: { ...parseAgentDefinitionYaml(CODING_AGENT), version: '1.2.0' },
    });

    expect(registry.versions('org_1', 'coding-agent')).toEqual(['1.0.0', '1.2.0']);
    expect((await registry.get('org_1', 'coding-agent')).version).toBe('1.2.0');
    expect((await registry.get('org_1', 'coding-agent', '1.0.0')).version).toBe('1.0.0');
    expect(registry.list('org_1')).toHaveLength(2);
  });

  it('never lets two different definitions share a version', () => {
    const registry = new AgentRegistry();
    const definition = parseAgentDefinitionYaml(CODING_AGENT);
    registry.registerSync({ organizationId: 'org_1', projectId: 'prj_1', definition });
    expect(() =>
      registry.registerSync({
        organizationId: 'org_1',
        projectId: 'prj_1',
        definition: { ...definition, tools: ['terminal.exec'] },
      }),
    ).toThrow(/bump the version/);
  });

  it('persists definitions through a store and reloads them', async () => {
    const saved: { organizationId: string; definition: unknown; hash: string }[] = [];
    const store = {
      save: async (record: { organizationId: string; definition: unknown; hash: string }) => {
        saved.push(record);
      },
      get: async () => undefined,
      list: async () => [],
    };
    const registry = new AgentRegistry({ store });
    const definition = parseAgentDefinitionYaml(CODING_AGENT);
    await registry.register({ organizationId: 'org_1', projectId: 'prj_1', definition, source: CODING_AGENT });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.hash).toBe(hashObject(saved[0]?.definition));
    expect(saved[0]?.hash).toBe(hashObject(JSON.parse(JSON.stringify(saved[0]?.definition))));
  });

  it('fails clearly for unknown agents and versions', async () => {
    const registry = new AgentRegistry();
    await expect(registry.get('org_1', 'missing')).rejects.toThrow(/agent not found/);
    registry.registerSync({ organizationId: 'org_1', projectId: 'prj_1', definition: parseAgentDefinitionYaml(CODING_AGENT) });
    await expect(registry.get('org_1', 'coding-agent', '9.9.9')).rejects.toThrow(/not found/);
    expect(registry.has('org_1', 'coding-agent')).toBe(true);
    expect(registry.has('org_2', 'coding-agent')).toBe(false);
  });
});

describe('prompt resolution', () => {
  it('resolves inline prompts by hashing the text', async () => {
    const registry = new InMemoryPromptRegistry();
    const resolved = await registry.resolve('You are a helper.');
    expect(resolved.id).toBe('inline');
    expect(resolved.text).toBe('You are a helper.');
    expect(resolved.hash).toHaveLength(64);
  });

  it('resolves a registry reference to an exact version', async () => {
    const registry = new InMemoryPromptRegistry([
      { id: 'agents/coding/system', version: '2.0.0', text: 'old prompt' },
      { id: 'agents/coding/system', version: '2.1.0', text: 'new prompt' },
    ]);

    const pinned = await registry.resolve({ registry: 'kazi://agents/coding/system', version: '2.0.0' });
    expect(pinned.text).toBe('old prompt');
    expect(pinned.version).toBe('2.0.0');

    const latest = await registry.resolve({ registry: 'kazi://agents/coding/system' });
    expect(latest.version).toBe('2.1.0');
    expect(registry.versions('agents/coding/system')).toEqual(['2.0.0', '2.1.0']);
  });

  it('fails when the referenced prompt does not exist', async () => {
    const registry = new InMemoryPromptRegistry();
    await expect(registry.resolve({ registry: 'kazi://nope' })).rejects.toThrow(/prompt not found/);
  });
});

describe('effectiveConfig', () => {
  it('snapshots the run configuration and records the prompt identity', async () => {
    const definition = parseAgentDefinitionYaml(CODING_AGENT);
    const prompt = await new InMemoryPromptRegistry().resolve(definition.systemPrompt);
    const { config, metadata } = effectiveConfig({ definition, resolvedPrompt: prompt });

    expect(config.agentId).toBe('coding-agent');
    expect(config.agentVersion).toBe('1.0.0');
    expect(config.provider).toBe('openai-compatible');
    expect(config.fallbackProviders).toEqual([{ provider: 'ollama', model: 'llama-local' }]);
    expect(config.limits.maxSteps).toBe(100);
    expect(config.memoryEnabled).toBe(true);
    expect(metadata['prompt']).toEqual({ id: 'inline', version: '0.0.0', hash: prompt.hash });
  });

  it('lets overrides narrow limits and permissions but never widen them', () => {
    const definition = parseAgentDefinitionYaml(CODING_AGENT);
    const { config } = effectiveConfig({
      definition,
      overrides: {
        limits: { maxSteps: 5 },
        permissions: { filesystem: { read: true, write: false, delete: true }, terminal: { execute: true } },
      },
    });

    expect(config.limits.maxSteps).toBe(5);
    expect(config.limits.maxCostUsd).toBe(5);
    expect(config.permissions.filesystem?.write).toBe(false);
    // `delete: true` in the override cannot re-enable what the agent denied.
    expect(config.permissions.filesystem?.delete).toBe(false);
    expect(config.permissions.terminal?.execute).toBe(true);
  });

  it('builds a run input that carries the definition identity', () => {
    const input = runInputFromDefinition({
      definition: parseAgentDefinitionYaml(CODING_AGENT),
      goal: 'Fix the failing tests',
      organizationId: 'org_1',
      projectId: 'prj_1',
    });

    expect(input.goal).toBe('Fix the failing tests');
    expect(input.agentId).toBe('coding-agent');
    expect(input.config?.agentVersion).toBe('1.0.0');
    expect(input.limits?.maxDurationSeconds).toBe(1800);
    expect(input.metadata?.['agent']).toEqual({ id: 'coding-agent', version: '1.0.0' });
  });
});
