import {
  NullLogger,
  SystemClock,
  newRunId,
  type ToolContext,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';

/**
 * A ToolContext good enough to invoke an MCP tool directly, without pulling in
 * the whole tool runtime. The execution environment refuses to run anything:
 * MCP tools must reach the outside world through their server, not through the
 * host.
 */
export function testContext(permissions: ToolPermissions = {}): ToolContext {
  return {
    runId: newRunId(),
    organizationId: 'org_test',
    projectId: 'prj_test',
    workspaceDir: '/tmp/kazi-mcp-test',
    permissions,
    logger: new NullLogger(),
    clock: new SystemClock(),
    signal: new AbortController().signal,
    secrets: {
      resolve: async (reference: string) => `value-of:${reference}`,
      has: async () => true,
    },
    environment: {
      execute: async () => {
        throw new Error('the MCP test context cannot execute commands');
      },
      workspaceDir: () => '/tmp/kazi-mcp-test',
    },
    artifacts: {
      write: async () => ({ artifactId: 'art_test', sha256: '0'.repeat(64), size: 0 }),
    },
  };
}
