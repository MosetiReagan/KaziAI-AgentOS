import { z } from 'zod';
import { ToolExecutionError, ToolInputError, toolResult, type AgentTool, type JsonValue, type ToolContext } from '@kazi-ai/agentos-core';
import { canUseGit } from '../permissions.js';

const gitInput = z.object({
  operation: z.enum(['status', 'diff', 'log', 'branch', 'checkout', 'add', 'commit', 'push', 'show', 'rev_parse']),
  path: z.string().optional(),
  args: z.array(z.string()).default([]),
  message: z.string().optional(),
  remote: z.string().default('origin'),
  branch: z.string().optional(),
  max_commits: z.number().int().positive().max(200).default(20),
});

export interface GitToolOptions {
  gitBin?: string;
  /** Pushing is disabled unless the run's permissions explicitly allow it. */
  allowPush?: boolean;
}

export function createGitTool(options: GitToolOptions = {}): AgentTool {
  const gitBin = options.gitBin ?? 'git';
  return {
    id: 'git',
    description:
      'Inspect and modify the git repository inside the run workspace. Push is refused unless the run explicitly permits it.',
    kind: 'builtin',
    risk: 'MEDIUM',
    timeoutMs: 120_000,
    inputSchema: gitInput,
    // The capabilities this tool can use. Push is listed because the tool does
    // push when the run grants `git.push` and policy approves it; the executor
    // restricts these against the run's grant, which stays authoritative.
    permissions: { git: { read: true, commit: true, push: true } },
    sandbox: { workspaceConfined: true },
    async execute(input: unknown, context: ToolContext) {
      const args = gitInput.parse(input);
      const permission = requiredPermission(args.operation);
      const check = canUseGit(context.permissions, permission);
      if (!check.allowed || (permission === 'push' && options.allowPush === false)) {
        throw new ToolExecutionError('git', check.reason ?? 'git operation denied', {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency: 'idempotent',
          details: { operation: args.operation },
        });
      }
      const argv = buildArgv(args);
      const result = await context.environment.execute(
        {
          command: gitBin,
          args: argv,
          env: {
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: 'echo',
            GIT_COMMITTER_NAME: 'KaziAI AgentOS',
            GIT_COMMITTER_EMAIL: 'agentos@localhost',
          },
        },
        { timeoutMs: 60_000, signal: context.signal, idempotency: permission === 'read' ? 'idempotent' : 'retry-safe' },
      );
      const output: JsonValue = {
        operation: args.operation,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      const idempotency = permission === 'read' ? 'idempotent' : 'retry-safe';
      if (result.exitCode !== 0) {
        return toolResult({
          success: false,
          output,
          error: {
            code: 'tool.git_failed',
            message: `git ${args.operation} failed with code ${result.exitCode}`,
            category: 'tool',
            retryable: false,
            idempotency,
          },
          idempotency,
        });
      }
      return toolResult({ success: true, output, idempotency, durationMs: result.durationMs });
    },
  };
}

function requiredPermission(operation: string): 'read' | 'commit' | 'push' {
  if (operation === 'push') return 'push';
  if (operation === 'commit' || operation === 'add' || operation === 'checkout') return 'commit';
  return 'read';
}

function buildArgv(args: z.infer<typeof gitInput>): string[] {
  switch (args.operation) {
    case 'status':
      return ['status', '--porcelain=v1', '--branch', ...(args.path ? ['--', args.path] : [])];
    case 'diff':
      return ['diff', ...(args.path ? ['--', args.path] : [])];
    case 'log':
      return ['log', `-n${args.max_commits}`, '--pretty=format:%H%x09%an%x09%ad%x09%s', ...(args.path ? ['--', args.path] : [])];
    case 'branch':
      return ['branch', '--all', ...args.args];
    case 'checkout':
      if (!args.branch) throw new ToolInputError('git', 'checkout requires a branch');
      return ['checkout', args.branch, ...args.args];
    case 'add':
      return ['add', '--', args.path ?? '.'];
    case 'commit':
      if (!args.message) throw new ToolInputError('git', 'commit requires a message');
      return ['commit', '-m', args.message, ...args.args];
    case 'push':
      return ['push', args.remote, ...(args.branch ? [args.branch] : [])];
    case 'show':
      return ['show', '--stat', ...(args.args.length > 0 ? args.args : ['HEAD'])];
    case 'rev_parse':
      return ['rev-parse', ...(args.args.length > 0 ? args.args : ['HEAD'])];
    default:
      throw new ToolInputError('git', `Unsupported operation: ${String(args.operation)}`);
  }
}

export function createGitTools(options: GitToolOptions = {}): AgentTool[] {
  return [createGitTool(options)];
}

