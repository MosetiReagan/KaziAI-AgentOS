import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitTool, createTestToolContext } from '../src/index.js';

const readOnly = { git: { read: true } };
const writable = { git: { read: true, commit: true } };
const pusher = { git: { read: true, commit: true, push: true } };

function initRepo(dir: string): void {
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
}

describe('git tool', () => {
  it('reports status in a real repository', async () => {
    const context = await createTestToolContext({ permissions: readOnly });
    initRepo(context.workspaceDir);
    writeFileSync(join(context.workspaceDir, 'a.txt'), 'changed');
    const result = await createGitTool().execute({ operation: 'status' }, context);
    expect(result.success).toBe(true);
    expect((result.output as { stdout: string }).stdout).toContain('a.txt');
  });

  it('commits changes and returns the log', async () => {
    const context = await createTestToolContext({ permissions: writable });
    initRepo(context.workspaceDir);
    writeFileSync(join(context.workspaceDir, 'a.txt'), 'first');
    const tool = createGitTool();
    await tool.execute({ operation: 'add', path: '.' }, context);
    const commit = await tool.execute({ operation: 'commit', message: 'test: add a.txt' }, context);
    expect(commit.success).toBe(true);
    const log = await tool.execute({ operation: 'log' }, context);
    expect((log.output as { stdout: string }).stdout).toContain('test: add a.txt');
    const diff = await tool.execute({ operation: 'diff' }, context);
    expect(diff.success).toBe(true);
  });

  it('refuses commit without write permission', async () => {
    const context = await createTestToolContext({ permissions: readOnly });
    await expect(createGitTool().execute({ operation: 'commit', message: 'nope' }, context)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
  });

  it('never pushes unless the run explicitly allows it', async () => {
    const withoutPush = await createTestToolContext({ permissions: writable });
    await expect(createGitTool().execute({ operation: 'push', remote: 'origin' }, withoutPush)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
    const withPushButDisabledTool = await createTestToolContext({ permissions: pusher });
    await expect(
      createGitTool({ allowPush: false }).execute({ operation: 'push', remote: 'origin' }, withPushButDisabledTool),
    ).rejects.toMatchObject({ code: 'tool.permission_denied' });
  });

  it('requires a message for commit and a branch for checkout', async () => {
    const context = await createTestToolContext({ permissions: writable });
    await expect(createGitTool().execute({ operation: 'commit' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
    await expect(createGitTool().execute({ operation: 'checkout' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });
});

