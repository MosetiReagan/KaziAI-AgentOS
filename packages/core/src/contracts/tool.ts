import type { IdempotencyClass } from '../errors.js';
import type { JsonObject, JsonValue } from '../json.js';
import type { RunId } from '../ids.js';
import type { Logger } from '../logger.js';
import type { Clock } from '../clock.js';

export type ToolKind = 'builtin' | 'http' | 'mcp' | 'database' | 'custom';

/** Permission surface a tool may request from the runtime. */
export interface ToolPermissions {
  filesystem?: { read?: boolean; write?: boolean; delete?: boolean; roots?: string[] };
  terminal?: {
    execute?: boolean;
    allowCommands?: string[];
    denyCommands?: string[];
    /**
     * Run commands that declare `sandbox.requiresIsolation` even when the
     * environment is not an isolation boundary. This is a deliberate, recorded
     * acceptance that agent commands run as the host user; it appears in the
     * run's configuration snapshot and in the policy decision that allowed it.
     */
    allowUnisolated?: boolean;
  };
  network?: { enabled?: boolean; allowedHosts?: string[]; methods?: string[] };
  git?: { read?: boolean; commit?: boolean; push?: boolean };
  database?: { read?: boolean; write?: boolean; connections?: string[] };
}

export interface ToolSandboxRequirements {
  /** Filesystem access must stay inside the run workspace. */
  workspaceConfined?: boolean;
  /** Tool requires an isolated environment (container) rather than the host. */
  requiresIsolation?: boolean;
}

export interface ToolContext {
  runId: RunId;
  organizationId: string;
  projectId: string;
  workspaceDir: string;
  /** Resolved permissions for this run, already intersected with agent config. */
  permissions: ToolPermissions;
  logger: Logger;
  clock: Clock;
  signal: AbortSignal;
  /** Resolve `secret://name` references. Never returns raw secrets to the tool author. */
  secrets: SecretResolver;
  environment: ToolEnvironment;
  /** Record an artifact produced by this tool call. */
  artifacts: ArtifactSink;
  /** Metadata about the current step, useful for tracing. */
  step?: { id: string; index: number };
}

export interface SecretResolver {
  resolve(reference: string): Promise<string>;
  has(reference: string): Promise<boolean>;
}

export interface ArtifactSink {
  write(input: { name: string; data: Buffer | string; mimeType?: string }): Promise<{ artifactId: string; sha256: string; size: number }>;
}

export interface ToolEnvironment {
  /** Execute a command in the run's execution environment. */
  execute(command: ShellCommand, options?: ShellExecutionOptions): Promise<ShellResult>;
  /** Directory the environment maps the workspace to. */
  workspaceDir(): string;
}

export interface ShellCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export interface ShellExecutionOptions {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Declares whether repeating the command is safe. */
  idempotency?: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  signal?: AbortSignal;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface ToolErrorInfo {
  code: string;
  message: string;
  category: string;
  retryable: boolean;
  idempotency: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  details?: JsonObject;
}

export interface ToolResult {
  success: boolean;
  output: JsonValue;
  error?: ToolErrorInfo;
  metadata?: JsonObject;
  /** Declared so the runtime knows whether the action may be replayed on recovery. */
  idempotency?: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  durationMs?: number;
}

/** Zod-like schema interface; kept structural so tools can use any validator. */
export interface InputSchema {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { message: string; issues?: unknown } };
  toJsonSchema?(): JsonObject;
}

export interface AgentTool<Input = unknown, Output = JsonValue> {
  id: string;
  description: string;
  inputSchema: InputSchema;
  kind?: ToolKind;
  permissions?: ToolPermissions;
  sandbox?: ToolSandboxRequirements;
  /** Risk hint used by the policy engine before execution. */
  risk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /**
   * Idempotency the tool declares for its own operations, when it can classify
   * them statically (e.g. an MCP server that annotates a tool read-only). The
   * runtime uses it instead of guessing from the tool id, which decides whether
   * a crashed call may be retried (spec §32).
   */
  defaultIdempotency?: IdempotencyClass;
  timeoutMs?: number;
  execute(input: Input, context: ToolContext): Promise<ToolResult & { output: Output }>;
}

export function toolResult(input: {
  success: boolean;
  output: JsonValue;
  error?: ToolErrorInfo;
  metadata?: JsonObject;
  idempotency?: ToolResult['idempotency'];
  durationMs?: number;
}): ToolResult {
  return {
    success: input.success,
    output: input.output,
    ...(input.error ? { error: input.error } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.idempotency ? { idempotency: input.idempotency } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

