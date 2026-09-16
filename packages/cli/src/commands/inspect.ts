import { NotFoundError, type AgentEvent, type Checkpoint, type Trace } from '@kazi-ai/agentos-core';
import { Output, formatCost, formatDuration } from '../output.js';
import type { CliContext } from '../context.js';
import { describeTimeline } from './run.js';

export interface InspectResult {
  run: unknown;
  state: unknown;
  trace: Trace;
  timeline: string[];
  approvals: unknown[];
  checkpoints: Checkpoint[];
}

/** `inspect`: one run's durable picture, including what it is waiting on. */
export async function inspectRun(context: CliContext, runId: string): Promise<InspectResult> {
  const run = await context.os.runtime.getRun(runId);
  if (!run) throw new NotFoundError('run', runId);
  const [state, trace, timeline, approvals, checkpoints] = await Promise.all([
    context.os.runtime.getState(runId),
    context.os.runtime.getTrace(runId),
    describeTimeline(context.os, runId),
    context.os.store.approvals.list({ runId }),
    context.os.store.checkpoints.list(runId),
  ]);
  return { run, state, trace, timeline, approvals, checkpoints };
}

export function renderInspect(
  output: Output,
  input: InspectResult & { run: { id: string; status: string; goal: string } },
): void {
  output.title(`RUN ${input.run.id}`);
  output.keyValue('Status:', input.run.status);
  output.keyValue('Goal:', input.run.goal);
  output.line();
  output.title('Timeline');
  for (const line of input.timeline) output.line(line);
  output.line();
  output.title('Trace');
  for (const node of input.trace.nodes) {
    output.line(`  ${node.kind.padEnd(12)} ${node.label}${node.status ? ` [${node.status}]` : ''}`);
    for (const child of node.children ?? []) {
      output.line(
        `    ${child.kind.padEnd(10)} ${child.label}${child.durationMs ? ` (${formatDuration(child.durationMs)})` : ''}`,
      );
    }
  }
  output.line();
  const summary = input.trace.summary;
  output.title('Summary');
  output.keyValue('Steps:', String(summary.steps));
  output.keyValue('Tool calls:', String(summary.toolCalls));
  output.keyValue('Failures:', String(summary.failures));
  output.keyValue('Recoveries:', String(summary.recoveries));
  output.keyValue('Checkpoints:', String(summary.checkpoints));
  output.keyValue('Duration:', formatDuration(summary.durationMs));
  output.keyValue('Cost:', formatCost(summary.costUsd));
  if (input.approvals.length > 0) {
    output.line();
    output.title('Approvals');
    for (const approval of input.approvals as Array<Record<string, unknown>>) {
      output.line(
        `  ${String(approval['id'])} ${String(approval['status'])}: ${String(approval['summary'])}`,
      );
    }
  }
}

/** `logs`: the append-only event stream, oldest first. */
export function renderEvents(output: Output, events: AgentEvent[]): void {
  for (const event of events) {
    const time = new Date(event.at).toISOString().slice(11, 23);
    output.line(
      `${time}  ${String(event.sequence).padStart(4)}  ${event.type.padEnd(22)} ${summarizeEvent(event)}`,
    );
  }
}

function summarizeEvent(event: AgentEvent): string {
  const data = event.data;
  const parts: string[] = [];
  for (const key of [
    'toolId',
    'strategy',
    'reason',
    'message',
    'code',
    'sequence',
    'passed',
    'status',
  ]) {
    if (data[key] !== undefined) parts.push(`${key}=${JSON.stringify(data[key])}`);
  }
  return parts.join(' ');
}
