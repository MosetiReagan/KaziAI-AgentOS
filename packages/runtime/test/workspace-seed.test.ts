import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationError } from '@kazi-ai/agentos-core';
import { createHarness, type Harness } from './harness.js';

let harness: Harness | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await harness?.cleanup().catch(() => undefined);
  harness = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/**
 * A run starts on an empty workspace unless the caller puts something in it
 * (spec §70). The seed is the caller's, and it happens before the run row
 * exists, so a bad seed is an error rather than a run nobody can execute.
 */
describe('seeding a run workspace', () => {
  it('writes inline files into the workspace before the run starts', async () => {
    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    const run = await harness.runtime.createRun(
      harness.runInput({
        workspace: { files: { 'src/cart.js': 'module.exports = {};\n', 'package.json': '{}' } },
      }),
    );

    expect(readFileSync(join(run.workspaceDir, 'src/cart.js'), 'utf8')).toContain('module.exports');
    expect(existsSync(join(run.workspaceDir, 'package.json'))).toBe(true);
    const events = await harness.store.events.list(run.id);
    expect(events.find((event) => event.type === 'workspace.created')?.data['seededFiles']).toBe(2);
  });

  it('copies a directory in, honouring the ignore list', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'kazi-seed-src-'));
    writeFileSync(join(scratch, 'index.js'), 'console.log(1)\n', 'utf8');
    mkdirSync(join(scratch, 'node_modules'), { recursive: true });
    writeFileSync(join(scratch, 'node_modules', 'junk.js'), 'junk\n', 'utf8');
    mkdirSync(join(scratch, 'test'), { recursive: true });
    writeFileSync(join(scratch, 'test', 'index.test.js'), 'test\n', 'utf8');

    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    const run = await harness.runtime.createRun(
      harness.runInput({ workspace: { copyFrom: scratch, ignore: ['node_modules'] } }),
    );

    expect(readFileSync(join(run.workspaceDir, 'index.js'), 'utf8')).toBe('console.log(1)\n');
    expect(existsSync(join(run.workspaceDir, 'test', 'index.test.js'))).toBe(true);
    expect(existsSync(join(run.workspaceDir, 'node_modules'))).toBe(false);
  });

  it('refuses a seed that would write outside the workspace', async () => {
    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    await expect(
      harness.runtime.createRun(harness.runInput({ workspace: { files: { '../escaped.txt': 'nope' } } })),
    ).rejects.toBeInstanceOf(ValidationError);
    // Nothing was created outside the workspace directory.
    expect(existsSync(join(harness.rootDir, 'escaped.txt'))).toBe(false);
  });

  it('refuses a seed source that is not a directory', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'kazi-seed-file-'));
    const file = join(scratch, 'a-file.txt');
    writeFileSync(file, 'x', 'utf8');

    harness = await createHarness({ turns: [{ text: 'nothing to do' }] });
    await expect(
      harness.runtime.createRun(harness.runInput({ workspace: { copyFrom: file } })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
