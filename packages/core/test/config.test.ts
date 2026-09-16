import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../src/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'kazi-config-'));
}

describe('configuration loading', () => {
  it('applies defaults when nothing is configured', () => {
    const { config, sources } = loadConfig({ env: {}, ignoreFiles: true });
    expect(config.storage.driver).toBe('memory');
    expect(config.queue.driver).toBe('inline');
    expect(config.environment.kind).toBe('local');
    expect(config.environment.networkEnabled).toBe(false);
    expect(config.api.port).toBe(4319);
    expect(sources).toEqual(['defaults']);
  });

  it('carries MCP server definitions through to the runtime', () => {
    const { config } = loadConfig({
      ignoreFiles: true,
      env: {},
      cli: {
        mcp: {
          servers: [{ id: 'github', transport: { type: 'http', url: 'https://mcp.example/mcp' } }],
        },
      },
    });

    expect(config.mcp.strict).toBe(true);
    expect(config.mcp.servers).toHaveLength(1);
    expect((config.mcp.servers[0] as Record<string, unknown>)['id']).toBe('github');
  });

  it('maps environment variables onto nested paths with correct types', () => {
    const { config, sources } = loadConfig({
      ignoreFiles: true,
      env: {
        KZ_API_PORT: '8080',
        KZ_ENVIRONMENT: 'docker',
        KZ_NETWORK_ENABLED: 'true',
        KZ_CORS_ORIGINS: 'http://a.test, http://b.test',
        KZ_STORAGE_DRIVER: 'postgres',
        DATABASE_URL: 'postgresql://localhost/db',
      },
    });
    expect(config.api.port).toBe(8080);
    expect(config.api.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
    expect(config.environment.networkEnabled).toBe(true);
    expect(config.storage.databaseUrl).toBe('postgresql://localhost/db');
    expect(sources).toContain('environment');
  });

  it('gives CLI overrides the highest precedence', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'agentos.yaml'), 'api:\n  port: 5000\nlogLevel: warn\n');
    const { config, sources } = loadConfig({
      cwd: dir,
      env: { KZ_API_PORT: '6000' },
      cli: { api: { port: 7000 } },
    });
    expect(config.api.port).toBe(7000);
    expect(config.logLevel).toBe('warn');
    expect(sources.indexOf('cli')).toBeGreaterThan(sources.indexOf('environment'));
    expect(sources.indexOf('environment')).toBeGreaterThan(0);
  });

  it('reads JSON project configuration', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'agentos.json'), JSON.stringify({ environment: { workspaceRoot: '/tmp/ws' } }));
    const { config } = loadConfig({ cwd: dir, env: {} });
    expect(config.environment.workspaceRoot).toBe('/tmp/ws');
  });

  it('rejects configuration that cannot work', () => {
    expect(() => loadConfig({ ignoreFiles: true, env: { KZ_STORAGE_DRIVER: 'postgres' } })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ignoreFiles: true, env: { KZ_QUEUE_DRIVER: 'bullmq' } })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ignoreFiles: true, env: { KZ_API_PORT: 'not-a-port' } })).toThrow(ConfigurationError);
  });

  it('rejects unknown keys so typos cannot silently disable safety', () => {
    expect(() => loadConfig({ ignoreFiles: true, env: {}, cli: { env2: 'production' } })).toThrow(ConfigurationError);
  });

  it('warns when a config file embeds a literal secret', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'agentos.yaml'), 'providers:\n  openai:\n    kind: openai-compatible\n    apiKeyRef: sk-abcdefghijklmnopqrst\n');
    const { warnings } = loadConfig({ cwd: dir, env: {} });
    expect(warnings.some((warning) => warning.includes('literal secret'))).toBe(true);
  });
});

