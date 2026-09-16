import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import type { AgentRun, RunState } from '@kazi-ai/agentos-core';
import type { EventWriter } from './events.js';

/**
 * Move a run to a target state using only transitions the state machine
 * allows, emitting an event for every hop so the history is complete.
 */
export async function advanceRunTo(input: {
  store: AgentOSStore;
  events: EventWriter;
  run: AgentRun;
  target: RunState;
  reason: string;
}): Promise<AgentRun> {
  const { allowedTargets, nextStateFor } = await import('@kazi-ai/agentos-core');
  const triggers = [
    'queue',
    'initialize',
    'plan',
    'act',
    'observe',
    'verify',
    'recover',
    'await_approval',
    'pause',
    'resume',
    'complete',
    'fail',
    'cancel',
    'timeout',
    'retry',
  ] as const;
  const triggerFor = (from: RunState, to: RunState): (typeof triggers)[number] | undefined =>
    triggers.find((trigger) => nextStateFor(from, trigger) === to);

  const run_ = input.run;
  if (run_.status === input.target) return run_;

  const queue: Array<{ state: RunState; path: Array<{ from: RunState; to: RunState }> }> = [
    { state: run_.status, path: [] },
  ];
  const seen = new Set<RunState>([run_.status]);
  let path: Array<{ from: RunState; to: RunState }> | undefined;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const next of allowedTargets(current.state)) {
      if (seen.has(next)) continue;
      const candidate = [...current.path, { from: current.state, to: next }];
      if (next === input.target) {
        path = candidate;
        break;
      }
      seen.add(next);
      queue.push({ state: next, path: candidate });
    }
    if (path) break;
  }
  if (!path) return run_;

  for (const hop of path) {
    run_.status = hop.to;
    run_.stateVersion += 1;
    await input.store.runs.update(run_, run_.stateVersion - 1);
    await input.events.emit({
      type: 'state.transitioned',
      runId: run_.id,
      organizationId: run_.organizationId,
      projectId: run_.projectId,
      traceId: run_.traceId,
      data: { from: hop.from, to: hop.to, trigger: triggerFor(hop.from, hop.to) ?? 'act', reason: input.reason },
    });
    if (hop.to === 'PAUSED') {
      await input.events.emit({
        type: 'run.paused',
        runId: run_.id,
        organizationId: run_.organizationId,
        projectId: run_.projectId,
        traceId: run_.traceId,
        data: { reason: input.reason },
      });
    }
  }
  return run_;
}
