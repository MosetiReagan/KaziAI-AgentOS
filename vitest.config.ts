import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

function alias() {
  const entries: Record<string, string> = {};
  const dirs = ['packages', 'apps'];
  for (const dir of dirs) {
    const base = resolve(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pkg = resolve(base, name, 'package.json');
      if (!existsSync(pkg)) continue;
      const entry = resolve(base, name, 'src', 'index.ts');
      if (!existsSync(entry)) continue;
      entries[`@kazi-ai/agentos-${name}`] = entry;
      entries[`@kazi-ai/${name}`] = entry;
    }
  }
  entries['@kazi-ai/agentos'] = resolve(root, 'packages/sdk/src/index.ts');
  entries['@kazi-ai/agentos-bench'] = resolve(root, 'packages/bench/src/index.ts');
  return entries;
}

export default defineConfig({
  resolve: { alias: alias() },
  test: {
    globals: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    projects: [
      {
        resolve: { alias: alias() },
        test: { name: 'unit', include: ['packages/*/test/**/*.test.ts'], exclude: ['**/*..integration.test.ts'] },
      },
      {
        resolve: { alias: alias() },
        test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] },
      },
      {
        resolve: { alias: alias() },
        test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 300_000 },
      },
      {
        resolve: { alias: alias() },
        test: { name: 'security', include: ['tests/security/**/*.test.ts'] },
      },
      {
        resolve: { alias: alias() },
        test: { name: 'chaos', include: ['tests/chaos/**/*.test.ts'], testTimeout: 300_000 },
      },
    ],
  },
});

