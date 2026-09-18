import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ToolExecutionError, ToolInputError, toolResult, type AgentTool, type JsonValue, type ToolContext } from '@kazi-ai/agentos-core';
import { PathGuard } from '../path-guard.js';
import { canDeleteFilesystem, canReadFilesystem, canWriteFilesystem } from '../permissions.js';
import { schemaToJsonSchema } from '../define-tool.js';

const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_MAX_ENTRIES = 2_000;

export interface FilesystemToolOptions {
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxResults?: number;
  maxEntries?: number;
}

function guardFor(context: ToolContext, toolId: string, allowedRoots?: string[]): PathGuard {
  return new PathGuard({
    root: context.workspaceDir,
    ...(allowedRoots ? { allowedRoots } : {}),
  });
}

function ensureRead(context: ToolContext, toolId: string): void {
  const check = canReadFilesystem(context.permissions);
  if (!check.allowed) {
    throw new ToolExecutionError(toolId, check.reason ?? 'filesystem read denied', {
      code: 'tool.permission_denied',
      retryable: false,
      idempotency: 'idempotent',
      terminal: false,
    });
  }
}

function ensureWrite(context: ToolContext, toolId: string): void {
  const check = canWriteFilesystem(context.permissions);
  if (!check.allowed) {
    throw new ToolExecutionError(toolId, check.reason ?? 'filesystem write denied', {
      code: 'tool.permission_denied',
      retryable: false,
      idempotency: 'idempotent',
    });
  }
}

const readInput = z.object({
  path: z.string().describe('Workspace-relative path to read'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  max_bytes: z.number().int().positive().optional(),
});

export function createFilesystemReadTool(options: FilesystemToolOptions = {}): AgentTool {
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  return {
    id: 'filesystem.read',
    description: 'Read a file from the run workspace. Paths are confined to the workspace.',
    kind: 'builtin',
    risk: 'LOW',
    timeoutMs: 10_000,
    inputSchema: readInput,
    permissions: { filesystem: { read: true } },
    sandbox: { workspaceConfined: true },
    async execute(input: unknown, context: ToolContext) {
      ensureRead(context, 'filesystem.read');
      const args = readInput.parse(input);
      const guard = guardFor(context, 'filesystem.read', context.permissions.filesystem?.roots);
      const target = guard.resolvePath(args.path);
      if (!existsSync(target)) {
        throw new ToolExecutionError('filesystem.read', `File not found: ${args.path}`, {
          code: 'tool.file_not_found',
          retryable: false,
          idempotency: 'idempotent',
          details: { path: guard.toRelative(target) },
        });
      }
      const stats = statSync(target);
      if (stats.isDirectory()) {
        throw new ToolInputError('filesystem.read', `${args.path} is a directory; use filesystem.list`);
      }
      const limit = Math.min(args.max_bytes ?? maxReadBytes, maxReadBytes);
      const buffer = readFileSync(target);
      const truncated = buffer.byteLength > limit;
      const slice = truncated ? buffer.subarray(0, limit) : buffer;
      return toolResult({
        success: true,
        output: {
          path: guard.toRelative(target),
          encoding: args.encoding,
          content: slice.toString(args.encoding === 'base64' ? 'base64' : 'utf8'),
          bytes: buffer.byteLength,
          truncated,
          sha256: createHash('sha256').update(buffer).digest('hex'),
        } as JsonValue,
        idempotency: 'idempotent',
      });
    },
  };
}

const writeInput = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['overwrite', 'append', 'create']).default('overwrite'),
});

export function createFilesystemWriteTool(options: FilesystemToolOptions = {}): AgentTool {
  const maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  return {
    id: 'filesystem.write',
    description: 'Write a file inside the run workspace. Creates parent directories as needed.',
    kind: 'builtin',
    risk: 'MEDIUM',
    timeoutMs: 15_000,
    inputSchema: writeInput,
    permissions: { filesystem: { write: true } },
    sandbox: { workspaceConfined: true },
    async execute(input: unknown, context: ToolContext) {
      ensureWrite(context, 'filesystem.write');
      const args = writeInput.parse(input);
      const bytes = Buffer.byteLength(args.content, 'utf8');
      if (bytes > maxWriteBytes) {
        throw new ToolInputError('filesystem.write', `Content exceeds the ${maxWriteBytes} byte write limit`, { bytes });
      }
      const guard = guardFor(context, 'filesystem.write', context.permissions.filesystem?.roots);
      const target = guard.resolvePath(args.path);
      if (args.mode === 'create' && existsSync(target)) {
        throw new ToolInputError('filesystem.write', `File already exists: ${args.path}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      const existed = existsSync(target);
      const previousBytes = existed ? statSync(target).size : 0;
      if (args.mode === 'append') writeFileSync(target, args.content, { encoding: 'utf8', flag: 'a' });
      else writeFileSync(target, args.content, 'utf8');
      const persisted = args.mode === 'append' ? bytes : bytes - previousBytes;
      return toolResult({
        success: true,
        output: {
          path: guard.toRelative(target),
          bytes,
          created: !existed,
          sha256: createHash('sha256').update(args.content).digest('hex'),
        } as JsonValue,
        metadata: { persistedBytes: persisted },
        idempotency: 'retry-safe',
      });
    },
  };
}

const editInput = z.object({
  path: z.string(),
  old_text: z.string().min(1),
  new_text: z.string(),
  replace_all: z.boolean().default(false),
});

export function createFilesystemEditTool(): AgentTool {
  return {
    id: 'filesystem.edit',
    description: 'Replace exact text in a workspace file. Fails if the old text is absent or ambiguous.',
    kind: 'builtin',
    risk: 'MEDIUM',
    timeoutMs: 15_000,
    inputSchema: editInput,
    permissions: { filesystem: { read: true, write: true } },
    async execute(input: unknown, context: ToolContext) {
      ensureRead(context, 'filesystem.edit');
      ensureWrite(context, 'filesystem.edit');
      const args = editInput.parse(input);
      const guard = guardFor(context, 'filesystem.edit', context.permissions.filesystem?.roots);
      const target = guard.resolvePath(args.path);
      if (!existsSync(target)) throw new ToolExecutionError('filesystem.edit', `File not found: ${args.path}`, { code: 'tool.file_not_found' });
      const original = readFileSync(target, 'utf8');
      const occurrences = original.split(args.old_text).length - 1;
      if (occurrences === 0) {
        throw new ToolExecutionError('filesystem.edit', `Text to replace was not found in ${args.path}`, {
          code: 'tool.edit_no_match',
          idempotency: 'idempotent',
        });
      }
      if (occurrences > 1 && !args.replace_all) {
        throw new ToolInputError('filesystem.edit', `Text occurs ${occurrences} times; pass replace_all to replace every match`);
      }
      const updated = args.replace_all
        ? original.split(args.old_text).join(args.new_text)
        : original.replace(args.old_text, args.new_text);
      writeFileSync(target, updated, 'utf8');
      return toolResult({
        success: true,
        output: { path: guard.toRelative(target), replacements: args.replace_all ? occurrences : 1 } as JsonValue,
        metadata: { persistedBytes: Buffer.byteLength(updated, 'utf8') - Buffer.byteLength(original, 'utf8') },
        idempotency: 'retry-safe',
      });
    },
  };
}

const listInput = z.object({
  path: z.string().default('.'),
  recursive: z.boolean().default(false),
  max_depth: z.number().int().positive().max(10).default(3),
});

export function createFilesystemListTool(options: FilesystemToolOptions = {}): AgentTool {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  return {
    id: 'filesystem.list',
    description: 'List files and directories inside the run workspace.',
    kind: 'builtin',
    risk: 'LOW',
    timeoutMs: 15_000,
    inputSchema: listInput,
    permissions: { filesystem: { read: true } },
    async execute(input: unknown, context: ToolContext) {
      ensureRead(context, 'filesystem.list');
      const args = listInput.parse(input);
      const guard = guardFor(context, 'filesystem.list', context.permissions.filesystem?.roots);
      const root = guard.resolvePath(args.path);
      if (!existsSync(root)) throw new ToolExecutionError('filesystem.list', `Directory not found: ${args.path}`, { code: 'tool.file_not_found' });
      const entries: Array<{ path: string; type: 'file' | 'directory' | 'symlink'; size: number }> = [];
      const walk = (dir: string, depth: number): void => {
        if (entries.length >= maxEntries) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entries.length >= maxEntries) return;
          const full = join(dir, entry.name);
          const stats = statSync(full);
          entries.push({
            path: guard.toRelative(full),
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
            size: stats.size,
          });
          if (args.recursive && entry.isDirectory() && depth < args.max_depth) walk(full, depth + 1);
        }
      };
      walk(root, 1);
      return toolResult({
        success: true,
        output: { path: guard.toRelative(root), entries, truncated: entries.length >= maxEntries } as JsonValue,
        idempotency: 'idempotent',
      });
    },
  };
}

const searchInput = z.object({
  query: z.string().min(1),
  path: z.string().default('.'),
  regex: z.boolean().default(false),
  max_results: z.number().int().positive().max(1_000).optional(),
});

export function createFilesystemSearchTool(options: FilesystemToolOptions = {}): AgentTool {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  return {
    id: 'filesystem.search',
    description: 'Search file contents inside the run workspace for a string or regular expression.',
    kind: 'builtin',
    risk: 'LOW',
    timeoutMs: 30_000,
    inputSchema: searchInput,
    permissions: { filesystem: { read: true } },
    async execute(input: unknown, context: ToolContext) {
      ensureRead(context, 'filesystem.search');
      const args = searchInput.parse(input);
      const guard = guardFor(context, 'filesystem.search', context.permissions.filesystem?.roots);
      const root = guard.resolvePath(args.path);
      const limit = Math.min(args.max_results ?? maxResults, 1_000);
      let matcher: (line: string) => boolean;
      if (args.regex) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(args.query);
        } catch (error) {
          throw new ToolInputError('filesystem.search', `Invalid regular expression: ${(error as Error).message}`);
        }
        matcher = (line) => pattern.test(line);
      } else {
        const needle = args.query.toLowerCase();
        matcher = (line) => line.toLowerCase().includes(needle);
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const walk = (dir: string): void => {
        if (matches.length >= limit) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (matches.length >= limit) return;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '.git' || entry.name === 'node_modules') continue;
            walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          const stats = statSync(full);
          if (stats.size > DEFAULT_MAX_READ_BYTES * 4) continue;
          let contents: string;
          try {
            contents = readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          if (contents.includes('\u0000')) continue;
          const lines = contents.split('\n');
          for (let index = 0; index < lines.length; index += 1) {
            if (matches.length >= limit) break;
            const line = lines[index] as string;
            if (matcher(line)) matches.push({ path: guard.toRelative(full), line: index + 1, text: line.slice(0, 400) });
          }
        }
      };
      walk(root);
      return toolResult({
        success: true,
        output: { query: args.query, matches, truncated: matches.length >= limit } as JsonValue,
        idempotency: 'idempotent',
      });
    },
  };
}

const moveInput = z.object({
  from: z.string(),
  to: z.string(),
  overwrite: z.boolean().default(false),
});

export function createFilesystemMoveTool(): AgentTool {
  return {
    id: 'filesystem.move',
    description: 'Move or rename a file inside the run workspace.',
    kind: 'builtin',
    risk: 'MEDIUM',
    timeoutMs: 15_000,
    inputSchema: moveInput,
    permissions: { filesystem: { write: true, delete: true } },
    async execute(input: unknown, context: ToolContext) {
      ensureWrite(context, 'filesystem.move');
      const args = moveInput.parse(input);
      const guard = guardFor(context, 'filesystem.move', context.permissions.filesystem?.roots);
      const source = guard.resolvePath(args.from);
      const target = guard.resolvePath(args.to);
      if (!existsSync(source)) throw new ToolExecutionError('filesystem.move', `Source not found: ${args.from}`, { code: 'tool.file_not_found' });
      if (existsSync(target) && !args.overwrite) {
        throw new ToolInputError('filesystem.move', `Destination exists: ${args.to}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      return toolResult({
        success: true,
        output: { from: guard.toRelative(source), to: guard.toRelative(target) } as JsonValue,
        idempotency: 'retry-safe',
      });
    },
  };
}

const deleteInput = z.object({
  path: z.string(),
  recursive: z.boolean().default(false),
});

export function createFilesystemDeleteTool(): AgentTool {
  return {
    id: 'filesystem.delete',
    description: 'Delete a file or directory inside the run workspace. Requires explicit delete permission.',
    kind: 'builtin',
    risk: 'HIGH',
    timeoutMs: 15_000,
    inputSchema: deleteInput,
    permissions: { filesystem: { delete: true } },
    async execute(input: unknown, context: ToolContext) {
      const check = canDeleteFilesystem(context.permissions);
      if (!check.allowed) {
        throw new ToolExecutionError('filesystem.delete', check.reason ?? 'filesystem delete denied', {
          code: 'tool.permission_denied',
          retryable: false,
        });
      }
      const args = deleteInput.parse(input);
      const guard = guardFor(context, 'filesystem.delete', context.permissions.filesystem?.roots);
      const target = guard.resolvePath(args.path);
      if (target === guard.workspaceRoot) {
        throw new ToolInputError('filesystem.delete', 'Refusing to delete the workspace root');
      }
      if (!existsSync(target)) {
        return toolResult({ success: true, output: { path: args.path, deleted: false } as JsonValue, idempotency: 'idempotent' });
      }
      const stats = statSync(target);
      if (stats.isDirectory() && !args.recursive) {
        throw new ToolInputError('filesystem.delete', 'Target is a directory; pass recursive to delete it');
      }
      const freed = freedBytes(target, stats, args.recursive);
      rmSync(target, { recursive: args.recursive, force: false });
      return toolResult({
        success: true,
        output: { path: guard.toRelative(target), deleted: true } as JsonValue,
        metadata: { persistedBytes: -freed },
        idempotency: 'retry-safe',
      });
    },
  };
}

export function createFilesystemTools(options: FilesystemToolOptions = {}): AgentTool[] {
  return [
    createFilesystemReadTool(options),
    createFilesystemWriteTool(options),
    createFilesystemEditTool(),
    createFilesystemListTool(options),
    createFilesystemSearchTool(options),
    createFilesystemMoveTool(),
    createFilesystemDeleteTool(),
  ];
}

export { schemaToJsonSchema };

/** Bytes a delete actually frees, so the storage budget tracks real usage. */
function freedBytes(target: string, stats: Stats, recursive: boolean): number {
  if (!stats.isDirectory()) return stats.size;
  if (!recursive) return 0;
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // Raced with another delete; nothing was freed by us.
        }
      }
    }
  }
  return total;
}
