import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ValidationError,
  type AgentEvent,
  type AgentRun,
  type RunLimits,
  type ToolPermissions,
} from '@kazi-ai/agentos-core';
import type { AgentOS } from '@kazi-ai/agentos';
import type { AgentDefinition } from '@kazi-ai/agentos-agent';
import type { AgentRunResult } from '@kazi-ai/agentos-core';
import type { CliContext } from '../context.js';
import { findAgentDefinition } from '../context.js';
import { formatCost, formatDuration, Output } from '../output.js';

export interface RunCommandOptions {
  agent: string;
  goal: string;
  cwd: string;
  organizationId: string;
  projectId: string;
  limits?: RunLimits;
  permissions?: ToolPermissions;
  /** Host directory copied into the run's workspace before it starts. */
  workspace?: string;
  /** Print the timeline as the run progresses. */
  live?: boolean;
  labels?: Record<string, string>;
}

export interface RunCommandResult {
  run: AgentRun;
  result: AgentRunResult;
  timeline: string[];
}

/**
 * `kazi-agent run <agent> --goal "..."`.
 *
 * The timeline printed to the operator is read back from durable records, so
 * what is shown is exactly what the runtime persisted — not a separate
 * in-memory narration.
 */
export async function executeRun(
  context: CliContext,
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const definition = await requireDefinition(context, options);
  const agent = context.os.agent({
    ...definition,
    organizationId: options.organizationId,
    projectId: options.projectId,
  });
  // One run, created and then started: `run()` would create a second one, and
  // the operator asked for exactly one durable unit of work.
  const run = await agent.createRun({
    goal: options.goal,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}),
    ...(options.labels ? { labels: options.labels } : {}),
    ...(options.workspace
      ? { workspace: { copyFrom: options.workspace, ignore: ['node_modules', '.git', 'dist'] } }
      : {}),
  });
  await agent.start(run.id);
  const [result, timeline, finished] = await Promise.all([
    agent.result(run.id),
    describeTimeline(context.os, run.id),
    agent.getRun(run.id),
  ]);
  return { run: finished, result, timeline };
}

/**
 * The operator-facing timeline. It is assembled from the append-only event log
 * and the tool invocation journal, so it shows what the runtime actually
 * persisted — including tool ids (spec §48, §51, §111).
 */
export async function describeTimeline(os: AgentOS, runId: string): Promise<string[]> {
  const [events, invocations] = await Promise.all([
    os.store.events.list(runId),
    os.store.invocations.list(runId),
  ]);

  // Grouped by phase, then in time order within each group: checkpoints happen
  // constantly and would otherwise drown out the work.
  const order = { plan: 0, tool: 1, verify: 2, approval: 3, recovery: 4, checkpoint: 5 } as const;
  const entries: Array<{ rank: number; at: number; text: string }> = [];
  for (const event of events) {
    if (event.type === 'plan.created') {
      entries.push({ rank: order.plan, at: event.at, text: 'Planning' });
    } else if (event.type === 'verification.started') {
      entries.push({ rank: order.verify, at: event.at, text: 'Verification' });
    } else if (event.type === 'approval.requested') {
      entries.push({
        rank: order.approval,
        at: event.at,
        text: `Approval requested: ${String(event.data['toolId'] ?? 'action')}`,
      });
    } else if (event.type === 'recovery.started') {
      entries.push({
        rank: order.recovery,
        at: event.at,
        text: `Recovery (${String(event.data['strategy'])})`,
      });
    } else if (event.type === 'checkpoint.created') {
      entries.push({
        rank: order.checkpoint,
        at: event.at,
        text: `Checkpoint #${String(event.data['sequence'])}`,
      });
    }
  }
  for (const invocation of invocations) {
    entries.push({ rank: order.tool, at: invocation.at, text: invocation.toolId });
  }

  return entries
    .sort((left, right) => left.rank - right.rank || left.at - right.at)
    .map((entry, index) => `[${String(index + 1).padStart(2, '0')}] ${entry.text}`);
}

async function requireDefinition(
  context: CliContext,
  options: RunCommandOptions,
): Promise<AgentDefinition> {
  const fromFiles = findAgentDefinition(options.cwd, options.agent);
  if (fromFiles) return fromFiles;
  // A path to a YAML/JSON definition is also accepted.
  const asPath = resolve(options.cwd, options.agent);
  if (existsSync(asPath)) {
    const { parseAgentDefinitionYaml } = await import('@kazi-ai/agentos-agent');
    const { readFileSync } = await import('node:fs');
    return parseAgentDefinitionYaml(readFileSync(asPath, 'utf8'));
  }
  const known = await context.os.store.agentDefinitions.list(
    options.organizationId,
    options.projectId,
  );
  if (known.length > 0) {
    const record = known.find(
      (entry) => entry.id === options.agent || entry.name === options.agent,
    );
    if (record) return record.definition as unknown as AgentDefinition;
  }
  throw new ValidationError(
    `Unknown agent "${options.agent}". Run \`kazi-agent agents\` to list the agents in this project.`,
    { agent: options.agent },
  );
}

/** Print the run in the format the README documents (spec §111). */
export function renderRunSummary(
  output: Output,
  input: {
    run: AgentRun;
    result: AgentRunResult;
    timeline: string[];
    model: string;
    verified?: string;
  },
): void {
  output.title('KaziAI AgentOS');
  output.line();
  output.keyValue('Run:', input.run.id);
  output.keyValue('Agent:', input.run.agentId);
  output.keyValue('Model:', input.model);
  output.line();
  output.title('Goal:');
  output.line(input.run.goal);
  output.line();
  for (const line of input.timeline) output.line(line);
  output.line();
  if (input.verified) {
    output.title('Verification:');
    output.line(`${input.verified}`);
    output.line();
  }
  output.title('Result:');
  output.line(input.result.status);
  output.line();
  output.keyValue('Steps:', String(input.result.steps));
  output.keyValue('Tool calls:', String(input.result.toolCalls));
  output.keyValue('Recovery:', String(input.result.recoveryCount));
  output.keyValue('Duration:', formatDuration(input.result.durationMs));
  output.keyValue('Cost:', formatCost(input.result.costUsd));
}

export function eventLine(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'run.created':
      return 'run created';
    case 'plan.created':
      return `plan created (${String(event.data['steps'])} steps)`;
    case 'tool.requested':
      return `requested ${String(event.data['toolId'])}`;
    case 'tool.denied':
      return `DENIED ${String(event.data['toolId'])}: ${String(event.data['reason'])}`;
    case 'tool.completed':
      return `${String(event.data['toolId'])} completed`;
    case 'verification.completed':
      return `verification ${event.data['passed'] === true ? 'passed' : 'failed'}`;
    case 'recovery.started':
      return `recovering: ${String(event.data['strategy'])}`;
    case 'checkpoint.created':
      return `checkpoint #${String(event.data['sequence'])}`;
    case 'approval.requested':
      return `approval requested for ${String(event.data['toolId'] ?? 'an action')}`;
    case 'run.completed':
      return 'run completed';
    case 'run.failed':
      return `run failed: ${String(event.data['message'] ?? event.data['code'])}`;
    case 'run.cancelled':
      return 'run cancelled';
    default:
      return undefined;
  }
}
