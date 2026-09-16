export * from './define-tool.js';
export * from './registry.js';
export * from './permissions.js';
export * from './path-guard.js';
export * from './workspace.js';
export * from './testing.js';

export * from './environment/index.js';
export * from './tools/filesystem.js';
export * from './tools/terminal.js';

import type { AgentTool } from '@kazi-ai/agentos-core';
import { createFilesystemTools, type FilesystemToolOptions } from './tools/filesystem.js';
import { createTerminalTools, type TerminalToolOptions } from './tools/terminal.js';

export interface BuiltinToolsOptions {
  filesystem?: FilesystemToolOptions;
  terminal?: TerminalToolOptions;
}

/** Every built-in tool, in the order the runtime registers them. */
export async function createBuiltinTools(options: BuiltinToolsOptions = {}): Promise<AgentTool[]> {
  return [...createFilesystemTools(options.filesystem ?? {}), ...createTerminalTools(options.terminal ?? {})];
}
