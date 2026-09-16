import { NotFoundError } from '@kazi-ai/agentos-core';
import type { AgentRun } from '@kazi-ai/agentos-core';
import { Output, formatCost, formatDuration } from '../output.js';
import type { CliContext } from '../context.js';

export interface LifecycleFlags {
  runId: string;
  checkpointId?: string;
  goal?: string;
}

/** `pause`, `resume`, `cancel`, `retry`: thin, explicit lifecycle verbs. */
export async function lifecycleCommand(
  context: CliContext,
  action: 'pause' | 'resume' | 'cancel' | 'retry' | 'checkpoint',
  flags: LifecycleFlags,
  output: Output,
): Promise<unknown> {
  const before = await context.os.store.runs.get(flags.runId);
  if (!before) throw new NotFoundError('run', flags.runId);

  switch (action) {
    case 'pause':
      await context.os.runtime.pause(flags.runId);
      break;
    case 'resume':
      await context.os.runtime.resume(flags.runId);
      break;
    case 'cancel':
      await context.os.runtime.cancel(flags.runId);
      break;
    case 'retry':
      await context.os.runtime.retry(flags.runId);
      break;
    case 'checkpoint': {
      const checkpoint = await context.os.runtime.checkpoint(flags.runId);
      if (output.json) return checkpoint;
      output.ok(`Checkpoint #${checkpoint.sequence} created: ${checkpoint.id}`);
      return checkpoint;
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`Unhandled lifecycle action ${String(exhaustive)}`);
    }
  }

  const after = await context.os.store.runs.get(flags.runId);
  if (output.json) return after;
  output.ok(`${flags.runId}: ${before.status} → ${(after as AgentRun).status}`);
  return after;
}

export function renderRun(output: Output, run: AgentRun): void {
  output.keyValue('Run:', run.id);
  output.keyValue('Status:', run.status);
  output.keyValue('Agent:', run.agentId);
  output.keyValue('Goal:', run.goal);
  output.keyValue('Model:', `${run.config.provider}/${run.config.model}`);
  output.keyValue('Created:', new Date(run.createdAt).toISOString());
  output.keyValue('Steps:', String(run.usage.steps));
  output.keyValue('Tool calls:', String(run.usage.toolCalls));
  output.keyValue('Recoveries:', String(run.usage.recoveryCount));
  output.keyValue('Duration:', formatDuration(run.usage.durationMs));
  output.keyValue('Cost:', formatCost(run.usage.costUsd));
  output.keyValue('Trace:', run.traceId);
  output.keyValue('Workspace:', run.workspaceDir);
  if (run.error) output.keyValue('Error:', `${run.error.code}: ${run.error.message}`);
}
