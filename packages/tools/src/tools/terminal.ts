import { z } from 'zod';
import {
  ToolExecutionError,
  toAgentError,
  toolResult,
  type AgentTool,
  type JsonValue,
  type ToolContext,
} from '@kazi-ai/agentos-core';
import { canExecuteTerminal } from '../permissions.js';

const execInput = z.object({
  command: z.string().min(1).describe('Executable to run, e.g. "npm" or "node"'),
  args: z.array(z.string()).default([]).describe('Arguments passed without shell interpolation'),
  cwd: z.string().optional().describe('Workspace-relative working directory'),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
  timeout_ms: z.number().int().positive().max(1_800_000).optional(),
  /** Declare the command safe to repeat; defaults to unknown, which forces recovery to verify first. */
  idempotent: z.boolean().default(false),
});

export interface TerminalToolOptions {
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

/**
 * Runs a command inside the run's execution environment. The executable and its
 * arguments are passed separately so no shell interpolation happens by default,
 * which removes the classic command-injection path.
 */
export function createTerminalExecTool(options: TerminalToolOptions = {}): AgentTool {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const maxTimeoutMs = options.maxTimeoutMs ?? 1_800_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 256 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 128 * 1024;

  return {
    id: 'terminal.exec',
    description:
      'Execute a command inside the sandboxed run workspace. Commands run without a shell unless explicitly requested, and are subject to timeout, output, and permission limits.',
    kind: 'builtin',
    risk: 'MEDIUM',
    timeoutMs: maxTimeoutMs,
    inputSchema: execInput,
    permissions: { terminal: { execute: true } },
    sandbox: { workspaceConfined: true, requiresIsolation: true },
    async execute(input: unknown, context: ToolContext): Promise<ReturnType<typeof toolResult>> {
      const args = execInput.parse(input);
      const check = canExecuteTerminal(context.permissions, args.command);
      if (!check.allowed) {
        throw new ToolExecutionError('terminal.exec', check.reason ?? 'terminal execution denied', {
          code: 'tool.permission_denied',
          retryable: false,
          idempotency: 'unknown',
          details: { command: args.command },
        });
      }
      const timeoutMs = Math.min(args.timeout_ms ?? defaultTimeoutMs, maxTimeoutMs);
      const command = {
        command: args.command,
        args: args.args,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
        ...(args.env === undefined ? {} : { env: args.env }),
        ...(args.stdin === undefined ? {} : { stdin: args.stdin }),
      };
      try {
        const result = await context.environment.execute(command, {
          timeoutMs,
          maxStdoutBytes,
          maxStderrBytes,
          idempotency: args.idempotent ? 'idempotent' : 'unknown',
          signal: context.signal,
        });
        const idempotency = args.idempotent ? 'idempotent' : 'unknown';
        const output: JsonValue = {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          timed_out: result.timedOut,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
        };
        if (result.timedOut) {
          return toolResult({
            success: false,
            output,
            error: {
              code: 'tool.timeout',
              message: `Command exceeded ${timeoutMs}ms and was killed`,
              category: 'tool',
              retryable: true,
              idempotency,
            },
            durationMs: result.durationMs,
            idempotency,
          });
        }
        return toolResult({
          success: result.exitCode === 0,
          output,
          ...(result.exitCode === 0
            ? {}
            : {
                error: {
                  code: 'tool.command_failed',
                  message: `Command exited with code ${result.exitCode}`,
                  category: 'tool',
                  retryable: false,
                  idempotency,
                },
              }),
          durationMs: result.durationMs,
          idempotency,
        });
      } catch (error) {
        const agentError = toAgentError(error);
        throw new ToolExecutionError('terminal.exec', agentError.message, {
          code: agentError.code,
          retryable: agentError.retryable,
          idempotency: agentError.idempotency,
          cause: error,
          details: { command: args.command },
        });
      }
    },
  };
}

export function createTerminalTools(options: TerminalToolOptions = {}): AgentTool[] {
  return [createTerminalExecTool(options)];
}

