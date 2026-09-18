import {
  ConfigurationError,
  ValidationError,
  loadConfig,
  type JsonObject,
} from '@kazi-ai/agentos-core';
import {
  flagBool,
  flagNumber,
  flagString,
  parseArgs,
  requireArg,
  type ParsedArgs,
} from './args.js';
import { Output } from './output.js';
import { resolve } from 'node:path';
import { buildContext, tenantScope, type CliContext } from './context.js';
import { initProject } from './commands/init.js';
import {
  evaluateAction,
  listAgents,
  listPolicies,
  listRuns,
  listTools,
  renderAgents,
  renderEvaluatedAction,
  renderPolicies,
  renderRuns,
  renderTools,
} from './commands/catalog.js';
import { doctor, renderDoctor } from './commands/doctor.js';
import { lifecycleCommand } from './commands/lifecycle.js';
import { inspectRun, renderEvents, renderInspect } from './commands/inspect.js';
import { eventLine, renderRunSummary, executeRun } from './commands/run.js';

export const CLI_VERSION = '0.1.0';

const HELP = `kazi-agent — the KaziAI AgentOS command line

Usage: kazi-agent <command> [options]

Run an agent:
  run <agent> --goal "<text>"    Execute goal with the named agent
      [--workspace <dir>]        Seed the run's workspace from a directory
  runs                           List runs
  inspect <run>                  Show a run's state, trace and timeline
  logs <run> [--follow]          Show the run's event stream

Control a run:
  pause <run> | resume <run> | cancel <run> | retry <run>
  checkpoint <run>               Checkpoint now
  fork <run> [--checkpoint <id>] [--goal "<text>"]
  replay <run> [--mode deterministic|approximate]

Inspect the deployment:
  agents | tools | policies | approvals
  policies --tool <id> [--args '<json>']

Set up and diagnose:
  init [--force]                 Create agentos.yaml and agents/developer.yaml
  doctor                         Check Node, Docker, Postgres, Redis, API, providers, MCP

Global options:
  --json --no-color --org <id> --project <id> --config <path> --verbose
`;

export interface CliIO {
  cwd?: string;
  env?: Record<string, string | undefined>;
  write?(text: string): void;
}

/** Runs the CLI end to end and returns the process exit code. */
export async function main(argv: string[], io: CliIO = {}): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const args = parseArgs(argv);
  const output = new Output(io.write ?? ((text) => process.stdout.write(text)), {
    json: flagBool(args, 'json'),
    color: !flagBool(args, 'no-color'),
  });

  if (flagBool(args, 'help') || args.command === undefined || args.command === 'help') {
    output.line(HELP);
    return 0;
  }
  if (flagBool(args, 'version')) {
    output.line(CLI_VERSION);
    return 0;
  }

  try {
    if (args.command === 'init') {
      initProject({ cwd, force: flagBool(args, 'force') }, output);
      return 0;
    }

    const { config } = loadConfig({
      cwd,
      ...(io.env ? { env: io.env } : {}),
      cli: configOverrides(args),
    });

    const context = await buildContext({ cwd, config });
    try {
      return await dispatch(args, context, output);
    } finally {
      await context.close();
    }
  } catch (error) {
    return fail(error, output);
  }
}

async function dispatch(args: ParsedArgs, context: CliContext, output: Output): Promise<number> {
  const scope = tenantScope({
    ...(flagString(args, 'org') ? { org: flagString(args, 'org') as string } : {}),
    ...(flagString(args, 'project') ? { project: flagString(args, 'project') as string } : {}),
  });

  switch (args.command) {
    case 'run': {
      const agent = requireArg(args.positionals[0], '<agent>');
      const goal = flagString(args, 'goal') ?? args.rest.join(' ');
      if (!goal || goal.trim() === '') {
        throw new ValidationError('A run needs a goal: `kazi-agent run <agent> --goal "..."`');
      }
      const limits = limitsFromFlags(args);
      const workspace = flagString(args, 'workspace');
      const { run, result, timeline } = await executeRun(context, {
        agent,
        goal,
        cwd: context.cwd,
        ...scope,
        ...(limits ? { limits } : {}),
        // `--workspace <dir>` puts an existing repository in front of the
        // agent instead of starting it on an empty directory (spec §70, §94).
        ...(workspace ? { workspace: resolve(context.cwd, workspace) } : {}),
      });
      if (output.json) {
        output.data({ run: run as unknown as JsonObject, result: result as unknown as JsonObject });
        return 0;
      }
      renderRunSummary(output, {
        run,
        result,
        timeline,
        model: `${run.config.provider}/${run.config.model}`,
      });
      return result.success ? 0 : 1;
    }

    case 'runs': {
      const runs = await listRuns(context, {
        ...(flagString(args, 'status') ? { status: flagString(args, 'status') as string } : {}),
        ...(flagString(args, 'agent') ? { agent: flagString(args, 'agent') as string } : {}),
        ...(flagNumber(args, 'limit') ? { limit: flagNumber(args, 'limit') as number } : {}),
      });
      if (output.json) output.data(runs as unknown as JsonObject);
      else renderRuns(output, runs);
      return 0;
    }

    case 'inspect': {
      const runId = requireArg(args.positionals[0], '<run>');
      const inspected = await inspectRun(context, runId);
      if (output.json) output.data(inspected as unknown as JsonObject);
      else renderInspect(output, inspected as never);
      return 0;
    }

    case 'logs': {
      const runId = requireArg(args.positionals[0], '<run>');
      const events = await context.os.store.events.list(runId);
      if (output.json) output.data(events as unknown as JsonObject);
      else renderEvents(output, events);
      if (flagBool(args, 'follow')) await follow(context, runId, output);
      return 0;
    }

    case 'pause':
    case 'resume':
    case 'cancel':
    case 'retry':
    case 'checkpoint': {
      const runId = requireArg(args.positionals[0], '<run>');
      const result = await lifecycleCommand(context, args.command, { runId }, output);
      if (output.json && result) output.data(result as JsonObject);
      return 0;
    }

    case 'fork': {
      const runId = requireArg(args.positionals[0], '<run>');
      const checkpointFlag = flagString(args, 'checkpoint');
      const goalFlag = flagString(args, 'goal');
      const forked = await context.os.runtime.fork(runId, {
        ...(checkpointFlag ? { checkpointId: checkpointFlag } : {}),
        ...(goalFlag ? { goal: goalFlag } : {}),
      });
      if (output.json) output.data(forked as unknown as JsonObject);
      else {
        output.ok(`Forked ${runId} → ${forked.id}`);
        output.keyValue('Goal:', forked.goal);
        output.keyValue('Status:', forked.status);
      }
      return 0;
    }

    case 'replay': {
      const runId = requireArg(args.positionals[0], '<run>');
      const mode = flagString(args, 'mode') ?? 'trace';
      if (mode !== 'trace' && mode !== 'deterministic' && mode !== 'simulate') {
        throw new ValidationError(
          `Unknown replay mode "${mode}"; use trace, deterministic or simulate`,
        );
      }
      const report = await context.os.runtime.replay(runId, { mode });
      if (output.json) output.data(report as unknown as JsonObject);
      else {
        output.title(`Replay of ${runId} (${report.mode})`);
        output.keyValue('Actions:', String(report.actions.length));
        output.keyValue('Matched:', String(report.matched));
        output.keyValue('Diverged:', String(report.diverged));
        output.keyValue('Skipped:', String(report.skipped));
        output.line();
        for (const action of report.actions) {
          output.line(
            `  ${String(action.sequence).padStart(4)}  ${action.status.padEnd(9)} ${action.toolId}`,
          );
        }
        if (!report.deterministic) {
          output.line();
          output.dim(
            'Reconstructed from recorded history: model generation is never replayed deterministically.',
          );
        }
      }
      return 0;
    }

    case 'tools': {
      const tools = listTools(context);
      if (output.json) output.data(tools as unknown as JsonObject);
      else renderTools(output, tools);
      return 0;
    }

    case 'agents': {
      const agents = await listAgents(context);
      if (output.json) output.data(agents as unknown as JsonObject);
      else renderAgents(output, agents);
      return 0;
    }

    case 'policies': {
      const tool = flagString(args, 'tool');
      if (tool) {
        const raw = flagString(args, 'args') ?? '{}';
        let parsed: JsonObject;
        try {
          parsed = JSON.parse(raw) as JsonObject;
        } catch (error) {
          throw new ValidationError(`--args must be JSON: ${(error as Error).message}`, {
            args: raw,
          });
        }
        const evaluated = await evaluateAction(context, { toolId: tool, arguments: parsed });
        if (output.json) output.data(evaluated as unknown as JsonObject);
        else renderEvaluatedAction(output, evaluated);
        return evaluated.outcome === 'DENY' ? 1 : 0;
      }
      const policies = listPolicies(context);
      if (output.json) output.data(policies as unknown as JsonObject);
      else renderPolicies(output, policies);
      return 0;
    }

    case 'approvals': {
      const approvals = await context.os.runtime.pendingApprovals(flagString(args, 'org'));
      if (output.json) output.data(approvals as unknown as JsonObject);
      else {
        output.table(
          approvals.map((approval) => ({
            APPROVAL: approval.id,
            RUN: approval.runId,
            STATUS: approval.status,
            RISK: approval.risk,
            SUMMARY: approval.summary.slice(0, 50),
          })),
          ['APPROVAL', 'RUN', 'STATUS', 'RISK', 'SUMMARY'],
        );
      }
      return 0;
    }

    case 'approve':
    case 'deny': {
      const approvalId = requireArg(args.positionals[0], '<approval>');
      const decided = await context.os.runtime.decideApproval({
        approvalId,
        decision: args.command === 'approve' ? 'approve' : 'deny',
        decidedBy: flagString(args, 'by') ?? process.env['USER'] ?? 'operator',
        ...(flagString(args, 'reason') ? { reason: flagString(args, 'reason') as string } : {}),
      });
      if (output.json) output.data(decided as unknown as JsonObject);
      else output.ok(`Approval ${decided.id}: ${decided.status}`);
      return 0;
    }

    case 'doctor': {
      const report = await doctor(context);
      if (output.json) output.data(report as unknown as JsonObject);
      else renderDoctor(output, report);
      return report.ok ? 0 : 1;
    }

    default:
      throw new ValidationError(`Unknown command: ${args.command}. Run \`kazi-agent --help\`.`);
  }
}

/** `--follow` keeps printing events as a long-running agent makes progress. */
async function follow(context: CliContext, runId: string, output: Output): Promise<void> {
  let last = (await context.os.store.events.list(runId)).length;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const events = await context.os.store.events.list(runId, { afterSequence: last });
    for (const event of events) {
      last = Math.max(last, event.sequence);
      const line = eventLine(event);
      if (line) output.line(`  ${line}`);
    }
    const run = await context.os.store.runs.get(runId);
    if (!run || ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(run.status)) return;
  }
}

function limitsFromFlags(args: ParsedArgs) {
  const limits = {
    ...(flagNumber(args, 'max-steps') === undefined
      ? {}
      : { maxSteps: flagNumber(args, 'max-steps') as number }),
    ...(flagNumber(args, 'max-cost') === undefined
      ? {}
      : { maxCostUsd: flagNumber(args, 'max-cost') as number }),
    ...(flagNumber(args, 'max-seconds') === undefined
      ? {}
      : { maxDurationSeconds: flagNumber(args, 'max-seconds') as number }),
    ...(flagNumber(args, 'max-tool-calls') === undefined
      ? {}
      : { maxToolCalls: flagNumber(args, 'max-tool-calls') as number }),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function configOverrides(args: ParsedArgs): Record<string, unknown> {
  const cli: Record<string, unknown> = {};
  const dataDir = flagString(args, 'data-dir');
  const port = flagNumber(args, 'port');
  const logLevel = flagString(args, 'log-level');
  if (dataDir) cli['storage'] = { dataDir };
  if (port !== undefined) cli['api'] = { port };
  if (logLevel) cli['logLevel'] = logLevel;
  if (flagBool(args, 'verbose')) cli['logLevel'] = 'debug';
  return cli;
}

function fail(error: unknown, output: Output): number {
  if (output.json) {
    const payload = {
      error: {
        name: (error as Error).name ?? 'Error',
        message: (error as Error).message ?? String(error),
        ...((error as { code?: string }).code ? { code: (error as { code: string }).code } : {}),
      },
    } satisfies JsonObject;
    output.data(payload);
    return 1;
  }
  if (error instanceof ValidationError || error instanceof ConfigurationError) {
    output.fail((error as Error).message);
    return 2;
  }
  output.fail((error as Error).message ?? String(error));
  if (process.env['KZ_DEBUG'] === '1' && error instanceof Error && error.stack) {
    output.dim(error.stack);
  }
  return 1;
}
