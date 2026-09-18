import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createFilesystemDeleteTool,
  createFilesystemEditTool,
  createFilesystemListTool,
  createFilesystemMoveTool,
  createFilesystemReadTool,
  createFilesystemSearchTool,
  createFilesystemWriteTool,
  createTestToolContext,
} from '../src/index.js';

const readPermissions = { filesystem: { read: true } };
const writePermissions = { filesystem: { read: true, write: true } };
const deletePermissions = { filesystem: { read: true, write: true, delete: true } };

describe('filesystem tools', () => {
  it('reads a file inside the workspace and reports a hash', async () => {
    const context = await createTestToolContext({ permissions: readPermissions });
    writeFileSync(join(context.workspaceDir, 'a.txt'), 'hello world');
    const result = await createFilesystemReadTool().execute({ path: 'a.txt' }, context);
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ path: 'a.txt', content: 'hello world', bytes: 11, truncated: false });
  });

  it('refuses to read outside the workspace', async () => {
    const context = await createTestToolContext({ permissions: readPermissions });
    await expect(createFilesystemReadTool().execute({ path: '../../etc/passwd' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
    await expect(createFilesystemReadTool().execute({ path: '/etc/passwd' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('refuses to escape the workspace through a symlink', async () => {
    const context = await createTestToolContext({ permissions: readPermissions });
    const outside = join(context.workspaceDir, '..', 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    symlinkSync(outside, join(context.workspaceDir, 'link'));
    await expect(createFilesystemReadTool().execute({ path: 'link/secret.txt' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
  });

  it('denies reads when the permission is not granted', async () => {
    const context = await createTestToolContext({ permissions: {} });
    writeFileSync(join(context.workspaceDir, 'a.txt'), 'hello');
    await expect(createFilesystemReadTool().execute({ path: 'a.txt' }, context)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });
  });

  it('writes and refuses to overwrite in create mode', async () => {
    const context = await createTestToolContext({ permissions: writePermissions });
    const write = createFilesystemWriteTool();
    await write.execute({ path: 'nested/dir/file.ts', content: 'export const a = 1;' }, context);
    expect(existsSync(join(context.workspaceDir, 'nested/dir/file.ts'))).toBe(true);
    await expect(write.execute({ path: 'nested/dir/file.ts', content: 'x', mode: 'create' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
    await write.execute({ path: 'nested/dir/file.ts', content: '\n// appended', mode: 'append' }, context);
    expect(readFileSync(join(context.workspaceDir, 'nested/dir/file.ts'), 'utf8')).toContain('// appended');
  });

  it('edits text and fails when the target text is ambiguous or absent', async () => {
    const context = await createTestToolContext({ permissions: writePermissions });
    writeFileSync(join(context.workspaceDir, 'a.ts'), 'const a = 1;\nconst a = 1;\n');
    const edit = createFilesystemEditTool();
    await expect(edit.execute({ path: 'a.ts', old_text: 'const a = 1;', new_text: 'const a = 2;' }, context)).rejects.toMatchObject({
      code: 'tool.invalid_input',
    });
    await edit.execute({ path: 'a.ts', old_text: 'const a = 1;', new_text: 'const a = 2;', replace_all: true }, context);
    expect(readFileSync(join(context.workspaceDir, 'a.ts'), 'utf8')).toBe('const a = 2;\nconst a = 2;\n');
    await expect(edit.execute({ path: 'a.ts', old_text: 'missing', new_text: 'x' }, context)).rejects.toMatchObject({
      code: 'tool.edit_no_match',
    });
  });

  it('lists and searches the workspace', async () => {
    const context = await createTestToolContext({ permissions: readPermissions });
    mkdirSync(join(context.workspaceDir, 'src'), { recursive: true });
    writeFileSync(join(context.workspaceDir, 'src/index.ts'), 'export const token = 1;\n');
    writeFileSync(join(context.workspaceDir, 'README.md'), '# project\n');
    const list = await createFilesystemListTool().execute({ path: '.', recursive: true }, context);
    expect(JSON.stringify(list.output)).toContain('src/index.ts');
    const search = await createFilesystemSearchTool().execute({ query: 'token' }, context);
    expect(JSON.stringify(search.output)).toContain('src/index.ts');
    const regexSearch = await createFilesystemSearchTool().execute({ query: 'export\\s+const', regex: true }, context);
    expect(JSON.stringify(regexSearch.output)).toContain('src/index.ts');
  });

  it('moves and deletes only with delete permission', async () => {
    const limited = await createTestToolContext({ permissions: writePermissions });
    writeFileSync(join(limited.workspaceDir, 'a.txt'), 'x');
    await expect(createFilesystemDeleteTool().execute({ path: 'a.txt' }, limited)).rejects.toMatchObject({
      code: 'tool.permission_denied',
    });

    const context = await createTestToolContext({ permissions: deletePermissions });
    writeFileSync(join(context.workspaceDir, 'a.txt'), 'x');
    await createFilesystemMoveTool().execute({ from: 'a.txt', to: 'b.txt' }, context);
    expect(existsSync(join(context.workspaceDir, 'b.txt'))).toBe(true);
    await createFilesystemDeleteTool().execute({ path: 'b.txt' }, context);
    expect(existsSync(join(context.workspaceDir, 'b.txt'))).toBe(false);
  });

  it('refuses to delete the workspace root', async () => {
    const context = await createTestToolContext({ permissions: deletePermissions });
    await expect(createFilesystemDeleteTool().execute({ path: '.', recursive: true }, context)).rejects.toBeTruthy();
  });

  it('reports persisted bytes so the runtime can charge a storage budget (spec §25)', async () => {
    const context = await createTestToolContext({ permissions: writePermissions });
    const write = await createFilesystemWriteTool().execute(
      { path: 'notes.md', content: 'hello' },
      context,
    );
    expect(write.metadata?.['persistedBytes']).toBe(5);

    const overwrite = await createFilesystemWriteTool().execute(
      { path: 'notes.md', content: 'hello world!!' },
      context,
    );
    expect(overwrite.metadata?.['persistedBytes']).toBe(8);

    const append = await createFilesystemWriteTool().execute(
      { path: 'notes.md', content: '!', mode: 'append' },
      context,
    );
    expect(append.metadata?.['persistedBytes']).toBe(1);

    const edit = await createFilesystemEditTool().execute(
      { path: 'notes.md', old_text: 'hello world!!', new_text: 'hi' },
      context,
    );
    expect(edit.metadata?.['persistedBytes']).toBe(-11);
  });

  it('credits the budget with the bytes a recursive delete frees', async () => {
    const context = await createTestToolContext({ permissions: deletePermissions });
    mkdirSync(join(context.workspaceDir, 'dir', 'nested'), { recursive: true });
    writeFileSync(join(context.workspaceDir, 'dir', 'a.txt'), 'aaaa');
    writeFileSync(join(context.workspaceDir, 'dir', 'nested', 'b.txt'), 'bbbbbb');
    const deleted = await createFilesystemDeleteTool().execute({ path: 'dir', recursive: true }, context);
    expect(deleted.metadata?.['persistedBytes']).toBe(-10);
  });
});
