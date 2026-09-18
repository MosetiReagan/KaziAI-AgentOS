import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** Every source file an environment variable could legitimately be read from. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.ts')) files.push(rel);
    }
  };
  for (const dir of ['apps', 'packages']) walk(dir);
  return files;
}

const SOURCES = sourceFiles();
/** Variables a deployment sets for another image or for Docker itself. */
const EXTERNAL_VARS = new Set(['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']);

function isReadAnywhere(name: string): boolean {
  if (EXTERNAL_VARS.has(name)) return true;
  return SOURCES.some((file) => read(file).includes(name));
}

describe('docker deployment (spec §106)', () => {
  const compose = parseYaml(read('docker/docker-compose.yml')) as {
    services: Record<string, Record<string, unknown>>;
  };

  it('starts the whole stack: api, worker, dashboard, gateway, postgres, redis', () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ['api', 'dashboard', 'gateway', 'migrate', 'postgres', 'redis', 'worker'].sort(),
    );
  });

  it('probes or gates every long-running service', () => {
    for (const name of ['api', 'worker', 'dashboard', 'gateway']) {
      const service = compose.services[name];
      expect(service, name).toBeDefined();
      const build = service?.['build'] as { dockerfile: string; target?: string } | undefined;
      const dockerfile = read(build?.dockerfile ?? 'Dockerfile');
      // Either the image ships a HEALTHCHECK (so `service_healthy` means
      // something) or the service is gated on another service's readiness.
      const probed = build?.target
        ? new RegExp(`^FROM \\S+ AS ${build.target}\\n(?:.|\\n)*?HEALTHCHECK`, 'm').test(dockerfile)
        : dockerfile.includes('HEALTHCHECK');
      const dependsOn = service?.['depends_on'] as Record<string, { condition?: string }> | undefined;
      const conditions = Object.values(dependsOn ?? {}).map((entry) => entry.condition);
      const gated =
        conditions.includes('service_healthy') ||
        conditions.includes('service_completed_successfully');
      expect(probed || gated, `${name} has neither a healthcheck nor a readiness gate`).toBe(true);
    }
  });

  it('makes the API and the worker wait for the schema step', () => {
    for (const name of ['api', 'worker']) {
      const dependsOn = compose.services[name]?.['depends_on'] as Record<string, { condition?: string }>;
      expect(dependsOn['migrate']?.condition, name).toBe('service_completed_successfully');
    }
  });

  it('shares one data volume between the API and the worker', () => {
    const volumesOf = (name: string): string[] =>
      (compose.services[name]?.['volumes'] as string[] | undefined) ?? [];
    expect(volumesOf('api')).toContain('kazi-data:/var/lib/kazi');
    expect(volumesOf('worker')).toContain('kazi-data:/var/lib/kazi');
  });

  it('points every image at a Dockerfile target that exists', () => {
    const dockerfile = read('docker/node.Dockerfile');
    const targets = new Set(
      [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)$/gm)].map((match) => match[1] as string),
    );
    for (const [name, service] of Object.entries(compose.services)) {
      const build = service['build'] as { dockerfile?: string; target?: string } | undefined;
      if (!build) continue;
      expect(existsSync(join(root, build.dockerfile ?? 'Dockerfile')), `${name} dockerfile`).toBe(true);
      if (build.target !== undefined) {
        expect(targets.has(build.target), `${name} target ${build.target}`).toBe(true);
      }
    }
  });

  it('only sets environment variables that some process actually reads', () => {
    const declared = new Set<string>();
    for (const service of Object.values(compose.services)) {
      for (const key of Object.keys((service['environment'] as Record<string, string>) ?? {})) {
        declared.add(key);
      }
    }
    expect(declared.size).toBeGreaterThan(10);
    const unread = [...declared].filter((name) => !isReadAnywhere(name));
    expect(unread, `compose sets variables nothing reads: ${unread.join(', ')}`).toEqual([]);
  });

  it('defaults the published gateway port to the one the gateway binds', () => {
    const gateway = compose.services['gateway'] as Record<string, unknown>;
    const ports = gateway['ports'] as string[];
    expect(ports[0]).toContain('8080');
    const env = gateway['environment'] as Record<string, string>;
    expect(env['KZ_GATEWAY_PORT']).toBe('8080');
  });
});
