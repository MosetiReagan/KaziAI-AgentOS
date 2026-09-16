import { ValidationError, hashObject, type JsonObject, type JsonValue } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { ToolRegistry } from '@kazi-ai/agentos-tools';
import type { ToolContext } from '@kazi-ai/agentos-core';
import { buildTrace, type TraceInput } from '@kazi-ai/agentos-tracing';

export type ReplayMode = 'trace' | 'deterministic' | 'simulate';

export interface ReplayOptions {
  mode?: ReplayMode;
  /** Stop after this many recorded actions. */
  limit?: number;
}

export interface ReplayedAction {
  sequence: number;
  toolId: string;
  actionId: string;
  argumentsHash: string;
  status: 'matched' | 'diverged' | 'skipped' | 'failed';
  recordedResult?: JsonValue;
  replayedResult?: JsonValue;
  note?: string;
  durationMs: number;
}

export interface ReplayReport {
  runId: string;
  mode: ReplayMode;
  actions: ReplayedAction[];
  matched: number;
  diverged: number;
  skipped: number;
  summary: JsonObject;
  /**
   * `true` when the replay executed real tools, `false` when it only
   * reconstructed the recorded history. Model generation is never deterministic
   * and is never claimed to be (spec §57).
   */
  deterministic: boolean;
}

export interface ReplayDependencies {
  store: AgentOSStore;
  registry: ToolRegistry;
  createToolContext(action: { toolId: string; runId: string }): Promise<ToolContext | undefined>;
}

/**
 * Replays a run.
 *
 * - `trace`: rebuild the execution history from durable records. Always available.
 * - `deterministic`: re-execute the recorded tool calls with their recorded
 *   arguments and compare results, to detect drift in tools or environment.
 * - `simulate`: like deterministic but only for idempotent reads, so nothing
 *   destructive can happen during an experiment.
 */
export async function replayRun(runId: string, dependencies: ReplayDependencies, options: ReplayOptions = {}): Promise<ReplayReport> {
  const mode = options.mode ?? 'trace';
  const run = await dependencies.store.runs.get(runId);
  if (!run) throw new ValidationError(`Cannot replay unknown run ${runId}`, { runId });

  if (mode === 'trace') {
    const trace = buildTrace(await traceInput(dependencies, runId));
    return {
      runId,
      mode,
      actions: [],
      matched: 0,
      diverged: 0,
      skipped: 0,
      deterministic: false,
      summary: {
        nodes: trace.nodes.length,
        steps: trace.summary.steps,
        toolCalls: trace.summary.toolCalls,
        note: 'trace replay reconstructs recorded history; it does not re-run the model',
      },
    };
  }

  const journal = await dependencies.store.actions.list(runId);
  // The journal is append-only: the intent carries the arguments, the commit
  // carries the outcome. Joining them is what makes a replay possible.
  const argumentsByKey = new Map<string, JsonValue>();
  for (const entry of journal) {
    if (entry.status !== 'executing') continue;
    argumentsByKey.set(entry.idempotencyKey, (entry.arguments ?? null) as JsonValue);
  }
  const recorded = journal
    .filter((entry) => entry.status === 'succeeded' || entry.status === 'failed')
    .map((entry) => ({
      ...entry,
      arguments: (entry.arguments ?? argumentsByKey.get(entry.idempotencyKey) ?? null) as JsonValue,
    }));
  const limited = options.limit === undefined ? recorded : recorded.slice(0, options.limit);
  const actions: ReplayedAction[] = [];

  for (const entry of limited) {
    const started = Date.now();
    if (mode === 'simulate' && !isReadOnly(entry.toolId)) {
      actions.push({
        sequence: entry.sequence,
        toolId: entry.toolId,
        actionId: entry.actionId,
        argumentsHash: entry.argumentsHash,
        status: 'skipped',
        durationMs: 0,
        note: 'non-read-only tool skipped in simulate mode',
      });
      continue;
    }
    const tool = dependencies.registry.get(entry.toolId);
    if (!tool) {
      actions.push({
        sequence: entry.sequence,
        toolId: entry.toolId,
        actionId: entry.actionId,
        argumentsHash: entry.argumentsHash,
        status: 'skipped',
        durationMs: Date.now() - started,
        note: 'tool is no longer registered',
      });
      continue;
    }
    const context = await dependencies.createToolContext({ toolId: entry.toolId, runId });
    if (!context) {
      actions.push({
        sequence: entry.sequence,
        toolId: entry.toolId,
        actionId: entry.actionId,
        argumentsHash: entry.argumentsHash,
        status: 'skipped',
        durationMs: Date.now() - started,
        note: 'no environment available for replay',
      });
      continue;
    }
    try {
      const parsed = tool.inputSchema.safeParse(entry.arguments);
      if (!parsed.success) {
        actions.push({
          sequence: entry.sequence,
          toolId: entry.toolId,
          actionId: entry.actionId,
          argumentsHash: entry.argumentsHash,
          status: 'diverged',
          durationMs: Date.now() - started,
          note: `recorded arguments no longer validate: ${parsed.error.message}`,
        });
        continue;
      }
      const result = await tool.execute(parsed.data, context);
      const recordedHash = entry.result === undefined ? undefined : hashObject(entry.result);
      const replayedHash = result.success ? hashObject(result.output) : undefined;
      const matched = recordedHash !== undefined && replayedHash !== undefined && recordedHash === replayedHash;
      actions.push({
        sequence: entry.sequence,
        toolId: entry.toolId,
        actionId: entry.actionId,
        argumentsHash: entry.argumentsHash,
        status: matched ? 'matched' : result.success ? 'diverged' : 'failed',
        ...(entry.result === undefined ? {} : { recordedResult: entry.result }),
        replayedResult: result.output,
        ...(matched ? {} : { note: 'output differs from the recorded run' }),
        durationMs: Date.now() - started,
      });
    } catch (error) {
      actions.push({
        sequence: entry.sequence,
        toolId: entry.toolId,
        actionId: entry.actionId,
        argumentsHash: entry.argumentsHash,
        status: 'failed',
        durationMs: Date.now() - started,
        note: (error as Error).message,
      });
    }
  }

  const matched = actions.filter((action) => action.status === 'matched').length;
  const diverged = actions.filter((action) => action.status === 'diverged' || action.status === 'failed').length;
  const skipped = actions.filter((action) => action.status === 'skipped').length;
  return {
    runId,
    mode,
    actions,
    matched,
    diverged,
    skipped,
    deterministic: true,
    summary: {
      replayed: actions.length,
      matched,
      diverged,
      skipped,
      note:
        mode === 'simulate'
          ? 'simulate replay only re-runs read-only tools'
          : 'deterministic replay re-runs recorded tool calls; model generation is not replayed',
    },
  };
}

async function traceInput(dependencies: ReplayDependencies, runId: string): Promise<TraceInput> {
  const run = await dependencies.store.runs.get(runId);
  if (!run) throw new ValidationError(`Cannot replay unknown run ${runId}`, { runId });
  const [events, steps, invocations, checkpoints, recoveries] = await Promise.all([
    dependencies.store.events.list(runId),
    dependencies.store.steps.list(runId),
    dependencies.store.invocations.list(runId),
    dependencies.store.checkpoints.list(runId),
    dependencies.store.recoveries.list(runId),
  ]);
  return {
    run,
    events,
    steps,
    invocations,
    checkpoints: checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      runId: checkpoint.runId,
      sequence: checkpoint.sequence,
      createdAt: checkpoint.createdAt,
      stateVersion: checkpoint.stateVersion,
    })),
    recoveries: recoveries.map((recovery) => ({
      id: recovery.id,
      attempt: recovery.attempt,
      strategy: recovery.strategy,
      success: recovery.success,
      at: recovery.at,
    })),
  };
}

const READ_ONLY_TOOLS = new Set(['filesystem.read', 'filesystem.list', 'filesystem.search', 'database.query']);

function isReadOnly(toolId: string): boolean {
  return READ_ONLY_TOOLS.has(toolId);
}
