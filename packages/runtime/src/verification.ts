import { readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  ValidationError,
  type ExecutionEnvironment,
  type JsonObject,
  type Observation,
  type Plan,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';

export interface VerificationContext {
  runId: string;
  objective: string;
  plan?: Plan;
  observations: Observation[];
  environment?: ExecutionEnvironment;
  permissions: ToolPermissions;
  /** What to check. Verifiers ignore the parts they do not understand. */
  commands?: string[];
  signal?: AbortSignal;
  stepId?: string;
  metadata?: JsonObject;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  summary: string;
  durationMs: number;
}

export interface VerificationResult {
  passed: boolean;
  summary: string;
  checks: VerificationCheck[];
  at: number;
  detail?: JsonObject;
}

/** Verification is independent of the model: it inspects the real world. */
export interface ProgressVerifier {
  readonly id: string;
  verify(context: VerificationContext): Promise<VerificationResult>;
}

const SHELL_METACHARACTERS = /[|&;<>$`\\\n]/;

/** Split a configured command such as `pnpm test --silent` without a shell. */
export function parseVerificationCommand(command: string): { command: string; args: string[] } {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new ValidationError('Verification command is empty');
  if (SHELL_METACHARACTERS.test(trimmed)) {
    throw new ValidationError(
      `Verification command "${command}" contains shell metacharacters; run a program directly instead`,
      { command },
    );
  }
  const [program, ...args] = trimmed.split(/\s+/);
  if (!program) throw new ValidationError('Verification command is empty');
  return { command: program, args };
}

export interface CommandVerifierOptions {
  commands: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Runs real commands (test suites, linters, build steps) in the run's
 * environment and reports whether they succeeded.
 */
export class CommandVerifier implements ProgressVerifier {
  readonly id = 'command-verifier';

  constructor(private readonly options: CommandVerifierOptions) {}

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const commands = this.options.commands;
    if (commands.length === 0) {
      return { passed: true, summary: 'No verification commands configured', checks: [], at: Date.now() };
    }
    if (!context.environment) {
      return {
        passed: false,
        summary: 'Verification requires an execution environment',
        checks: commands.map((command) => ({ name: command, passed: false, summary: 'no environment', durationMs: 0 })),
        at: Date.now(),
      };
    }
    if (context.permissions.terminal?.execute !== true) {
      return {
        passed: false,
        summary: 'Verification commands are not permitted for this run',
        checks: commands.map((command) => ({ name: command, passed: false, summary: 'terminal permission denied', durationMs: 0 })),
        at: Date.now(),
      };
    }

    const checks: VerificationCheck[] = [];
    for (const command of commands) {
      const parsed = parseVerificationCommand(command);
      const started = Date.now();
      const result = await context.environment.execute(
        { command: parsed.command, args: parsed.args },
        {
          timeoutMs: this.options.timeoutMs ?? 300_000,
          maxStdoutBytes: this.options.maxOutputBytes ?? 64 * 1024,
          maxStderrBytes: this.options.maxOutputBytes ?? 64 * 1024,
          idempotency: 'idempotent',
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
      const passed = result.exitCode === 0 && !result.timedOut;
      checks.push({
        name: command,
        passed,
        summary: passed
          ? `exit code 0 in ${result.durationMs}ms`
          : result.timedOut
            ? `timed out after ${result.durationMs}ms`
            : `exit code ${result.exitCode}: ${truncate(result.stderr || result.stdout, 400)}`,
        durationMs: Date.now() - started,
      });
      if (!passed) break;
    }

    const failed = checks.filter((check) => !check.passed);
    return {
      passed: failed.length === 0,
      summary:
        failed.length === 0
          ? `All ${checks.length} verification command(s) passed`
          : `${failed.length} of ${checks.length} verification command(s) failed: ${failed[0]?.name ?? ''}`,
      checks,
      at: Date.now(),
      detail: {
        commands: checks.map((check) => ({ name: check.name, passed: check.passed, summary: check.summary })),
      },
    };
  }
}

export interface FilesystemVerifierOptions {
  checks: Array<{ path: string; exists?: boolean; contains?: string }>;
}

/** Verifies claims about the workspace instead of trusting the model's summary. */
export class FilesystemVerifier implements ProgressVerifier {
  readonly id = 'filesystem-verifier';

  constructor(
    private readonly options: FilesystemVerifierOptions,
    /** Defaults to reading from the run's workspace through its environment. */
    private readonly readFile?: (path: string) => string | undefined,
  ) {}

  async verify(context: VerificationContext = { runId: '', objective: '', observations: [], permissions: {} }): Promise<VerificationResult> {
    const read = this.readFile ?? readerFor(context);
    const checks: VerificationCheck[] = this.options.checks.map((check) => {
      const contents = read(check.path);
      const exists = contents !== undefined;
      const passed =
        check.exists === false
          ? !exists
          : exists && (check.contains === undefined || contents.includes(check.contains));
      return {
        name: check.path,
        passed,
        summary: exists ? (check.contains ? 'content check' : 'file exists') : 'file missing',
        durationMs: 0,
      };
    });
    const failed = checks.filter((check) => !check.passed);
    return {
      passed: failed.length === 0,
      summary: failed.length === 0 ? 'Filesystem checks passed' : `Missing or incorrect: ${failed.map((check) => check.name).join(', ')}`,
      checks,
      at: Date.now(),
    };
  }
}

/** Runs several verifiers; the result passes only when all of them pass. */
export class CompositeVerifier implements ProgressVerifier {
  readonly id = 'composite-verifier';

  constructor(private readonly verifiers: ProgressVerifier[]) {}

  async verify(context: VerificationContext): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const details: JsonObject[] = [];
    for (const verifier of this.verifiers) {
      const result = await verifier.verify(context);
      checks.push(...result.checks);
      details.push({ verifier: verifier.id, passed: result.passed, summary: result.summary });
    }
    const failed = details.filter((detail) => detail['passed'] === false);
    return {
      passed: failed.length === 0,
      summary:
        failed.length === 0
          ? `All ${this.verifiers.length} verifier(s) passed`
          : `${failed.length} verifier(s) failed: ${failed.map((detail) => String(detail['verifier'])).join(', ')}`,
      checks,
      at: Date.now(),
      detail: { verifiers: details },
    };
  }
}

/** Reads workspace-relative paths, refusing to escape the workspace. */
function readerFor(context: VerificationContext): (path: string) => string | undefined {
  const workspaceDir = context.environment?.workspaceDir() ?? process.cwd();
  const root = resolve(workspaceDir);
  return (path: string) => {
    const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
    if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return undefined;
    }
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
