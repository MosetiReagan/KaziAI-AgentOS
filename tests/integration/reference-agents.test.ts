import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAgentDefinitionYaml, type AgentDefinition } from '@kazi-ai/agentos-agent';

/**
 * The reference agents in `agents/` are the definitions a reader copies from, so
 * they have to load and they have to stay conservative (spec §93). A definition
 * that quietly gained `git.push` or `database.write` would be a security default
 * change wearing a documentation change's clothes.
 */

const AGENTS_DIR = fileURLToPath(new URL('../../agents', import.meta.url));

function loadAll(): Array<{ file: string; definition: AgentDefinition }> {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .sort()
    .map((file) => ({
      file,
      definition: parseAgentDefinitionYaml(readFileSync(join(AGENTS_DIR, file), 'utf8')),
    }));
}

describe('the reference agents', () => {
  it('all load, and each declares its own identity', () => {
    const agents = loadAll();
    expect(agents.map(({ file }) => file)).toEqual([
      'database-agent.yaml',
      'developer-agent.yaml',
      'devops-agent.yaml',
      'research-agent.yaml',
    ]);
    expect(new Set(agents.map(({ definition }) => definition.id)).size).toBe(agents.length);
    for (const { file, definition } of agents) {
      expect(definition.version, file).toMatch(/^\d+\.\d+\.\d+/);
      // A prompt may be inline or a versioned reference (spec §61); the
      // reference agents keep theirs inline, which is what this asserts.
      expect(typeof definition.systemPrompt, file).toBe('string');
      expect((definition.systemPrompt as string).length, file).toBeGreaterThan(50);
      expect(definition.limits.maxSteps, file).toBeGreaterThan(0);
      expect(definition.limits.maxCostUsd, file).toBeGreaterThan(0);
    }
  });

  it('never grant a capability the reference set is supposed to withhold', () => {
    for (const { file, definition } of loadAll()) {
      expect(definition.permissions.git?.push, file).not.toBe(true);
      expect(definition.permissions.filesystem?.delete, file).not.toBe(true);
      // `allow_unisolated` is an explicit, recorded acceptance; the reference
      // agents that use a shell say so, and the others do not get a shell.
      if (definition.permissions.terminal?.execute !== true) {
        expect(definition.tools, file).not.toContain('terminal.*');
      }
    }
  });

  it('keeps the analyst read-only and pointed at named connections', () => {
    const analyst = loadAll().find(({ definition }) => definition.id === 'database-agent')!.definition;
    expect(analyst.permissions.database?.read).toBe(true);
    expect(analyst.permissions.database?.write).toBe(false);
    expect(analyst.permissions.database?.connections).toEqual(['analytics']);
    expect(analyst.permissions.network?.enabled).not.toBe(true);
  });

  it('keeps the researcher unable to execute anything', () => {
    const researcher = loadAll().find(({ definition }) => definition.id === 'research-agent')!.definition;
    expect(researcher.tools).toContain('http.request');
    expect(researcher.permissions.terminal?.execute).not.toBe(true);
    // A fetching agent needs an allow list, or "network access" means every host.
    expect(researcher.permissions.network?.allowedHosts?.length ?? 0).toBeGreaterThan(0);
  });

  it('gives the operator a shell but not a push, and a verifier only where one exists', () => {
    const operator = loadAll().find(({ definition }) => definition.id === 'devops-agent')!.definition;
    expect(operator.permissions.terminal?.execute).toBe(true);
    expect(operator.permissions.terminal?.allowUnisolated).toBe(true);
    expect(operator.permissions.git?.push).not.toBe(true);
    // `verification.enabled: false` with no commands must not look like a check
    // that silently passes.
    expect(operator.verification.enabled).toBe(false);
    expect(operator.verification.commands ?? []).toEqual([]);
  });
});
