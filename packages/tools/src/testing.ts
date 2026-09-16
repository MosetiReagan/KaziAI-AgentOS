import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NullLogger,
  SystemClock,
  newRunId,
  type AgentTool,
  type RunId,
  type SecretResolver,
  type ToolContext,
  type ToolPermissions,
  type ToolResult,
  type JsonValue,
} from '@kazi-ai/agentos-core';
import { LocalExecutionEnvironment } from './environment/local.js';

export interface TestToolContextOptions {
  workspaceDir?: string;
  permissions?: ToolPermissions;
  environment?: ToolContext['environment'];
  secrets?: Record<string, string>;
  runId?: string;
  organizationId?: string;
  projectId?: string;
}

/** Build a fully-formed tool context for unit tests and examples. */
export async function createTestToolContext(options: TestToolContextOptions = {}): Promise<ToolContext & { workspaceDir: string }> {
  const workspaceDir = options.workspaceDir ?? mkdtempSync(join(tmpdir(), 'kazi-ws-'));
  const environment =
    options.environment ??
    (await (async () => {
      const env = new LocalExecutionEnvironment({ workspaceDir });
      await env.create();
      return env;
    })());
  const secrets: SecretResolver = {
    resolve: async (reference: string) => {
      const value = options.secrets?.[reference];
      if (value === undefined) throw new Error(`Secret not found: ${reference}`);
      return value;
    },
    has: async (reference: string) => options.secrets?.[reference] !== undefined,
  };
  return {
    runId: (options.runId ?? newRunId()) as RunId,
    organizationId: options.organizationId ?? 'org_test',
    projectId: options.projectId ?? 'prj_test',
    workspaceDir,
    permissions: options.permissions ?? {},
    logger: new NullLogger(),
    clock: new SystemClock(),
    signal: new AbortController().signal,
    secrets,
    environment,
    artifacts: {
      write: async () => ({ artifactId: 'art_test', sha256: '0'.repeat(64), size: 0 }),
    },
  };
}

/** Invoke a tool and return its raw result, throwing on validation errors. */
export async function invokeTool(tool: AgentTool, input: unknown, context: ToolContext): Promise<ToolResult> {
  return tool.execute(input, context);
}

export function json<T extends JsonValue>(value: T): T {
  return value;
}

