export * from './define-tool.js';
export * from './registry.js';
export * from './permissions.js';
export * from './path-guard.js';
export * from './workspace.js';
export * from './testing.js';

export * from './environment/index.js';
export * from './tools/filesystem.js';
export * from './tools/terminal.js';
export * from './tools/http.js';
export * from './tools/git.js';
export * from './tools/database.js';
export * from './drivers/postgres-driver.js';

import type { AgentTool } from '@kazi-ai/agentos-core';
import { createFilesystemTools, type FilesystemToolOptions } from './tools/filesystem.js';
import { createTerminalTools, type TerminalToolOptions } from './tools/terminal.js';
import { createHttpRequestTool, type HttpToolOptions } from './tools/http.js';
import { createGitTools, type GitToolOptions } from './tools/git.js';
import { createDatabaseTools, type DatabaseToolOptions } from './tools/database.js';

export interface BuiltinToolsOptions {
  filesystem?: FilesystemToolOptions;
  terminal?: TerminalToolOptions;
  http?: HttpToolOptions;
  git?: GitToolOptions;
  database?: DatabaseToolOptions;
}

/** Every built-in tool, in the order the runtime registers them. */
export async function createBuiltinTools(options: BuiltinToolsOptions = {}): Promise<AgentTool[]> {
  const httpTool = await createHttpRequestTool(options.http ?? {});
  return [
    ...createFilesystemTools(options.filesystem ?? {}),
    ...createTerminalTools(options.terminal ?? {}),
    httpTool,
    ...createGitTools(options.git ?? {}),
    ...createDatabaseTools(options.database ?? {}),
  ];
}
