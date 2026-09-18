import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import {
  ConcurrencyError,
  ValidationError,
  isTerminalState,
  type AgentRun,
  type Logger,
} from '@kazi-ai/agentos-core';
import type { DispatchAction, DispatchContext, RunDispatcher } from '@kazi-ai/agentos-runtime';

export interface QueuedRun extends DispatchContext {
  /** Monotonic attempt counter, incremented every time a worker claims it. */
  attempt: number;
  /** When the claim was written; used to detect a worker that died. */
  claimedAt: number;
  claimedBy?: string;
}

export interface RunQueue {
  /** Make a run available for a worker to claim. */
  enqueue(context: DispatchContext): Promise<void>;
  /** Claim one run, or nothing when there is none. */
  claim(): Promise<QueuedRun | undefined>;
  /** Put a claimed run back without executing it. */
  release(item: QueuedRun): Promise<void>;
  /** Best-effort depth of the queue, used for backpressure. */
  depth(): Promise<number>;
  /** Return claimed runs whose worker disappeared to the queue. */
  reclaimStale?(options: { olderThanMs: number }): Promise<string[]>;
  close?(): Promise<void>;
}

export interface StoreRunQueueOptions {
  store: AgentOSStore;
  /** Identifies this worker in the claim record. */
  workerId: string;
  logger?: Logger;
  /** Only claim runs for these organizations. */
  organizationId?: string;
  now?: () => number;
}

/**
 * Runs in these states are eligible for execution.
 *
 * Not just CREATED/QUEUED: the whole point of a durable queue is that a worker
 * can die *while executing* and another worker takes the run over. Such a run
 * sits in INITIALIZING/EXECUTING/RECOVERING, and if it were not claimable the
 * crash would strand it forever (spec §31, §44, §114).
 *
 * `WAITING` is deliberately absent: a run paused for a human decision is not
 * on the queue, it advances when the approval is decided.
 */
const CLAIMABLE = new Set([
  'CREATED',
  'QUEUED',
  'INITIALIZING',
  'PLANNING',
  'EXECUTING',
  'OBSERVING',
  'VERIFYING',
  'RECOVERING',
]);

const CLAIM_KEY = 'kazi.claim';

interface ClaimMarker {
  workerId: string;
  at: number;
  attempt: number;
  action: DispatchAction;
}

/**
 * A durable queue built on the run store itself (spec §42, §43).
 *
 * There is no separate queue record to keep in sync with the run: a run is
 * queued because of its status, and a claim is written onto the run with an
 * optimistic version check. Two workers cannot claim the same run, and a
 * worker that dies leaves its claim behind where a surviving worker can see it
 * and take over.
 */
export class StoreRunQueue implements RunQueue {
  private readonly now: () => number;

  constructor(private readonly options: StoreRunQueueOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  async enqueue(context: DispatchContext): Promise<void> {
    const run = await this.options.store.runs.get(context.runId);
    if (!run) throw new ValidationError(`Cannot enqueue unknown run ${context.runId}`);
    if (isTerminalState(run.status)) return;
    const marker: ClaimMarker = {
      workerId: 'queue',
      at: 0,
      attempt: 0,
      action: context.action,
    };
    await this.write(run, marker);
  }

  async claim(): Promise<QueuedRun | undefined> {
    const page = await this.options.store.runs.list({
      ...(this.options.organizationId ? { organizationId: this.options.organizationId } : {}),
      status: [...CLAIMABLE, 'PAUSED'],
      orderBy: 'createdAt',
      direction: 'asc',
      limit: 50,
    });
    for (const run of page.items) {
      if (isTerminalState(run.status)) continue;
      const existing = claimOf(run);
      // A claimed run is claimed, by this worker or another one. An abandoned
      // claim stays claimed until `reclaimStale` deliberately releases it -
      // otherwise a lost run would be executed by two workers at once.
      if (existing && existing.at > 0) continue;
      // Only a run that has never started is *started*. Everything else —
      // PAUSED by an operator, or left in an in-flight state by a worker that
      // died — is *resumed*, so the runtime reloads the committed state and
      // continues instead of restarting the work (spec §31, §114).
      const action: DispatchAction =
        run.status === 'CREATED' || run.status === 'QUEUED' ? 'start' : 'resume';
      const marker: ClaimMarker = {
        workerId: this.options.workerId,
        at: this.now(),
        attempt: (existing?.attempt ?? 0) + 1,
        action,
      };
      try {
        const claimed = await this.write(run, marker);
        return {
          runId: claimed.id,
          organizationId: claimed.organizationId,
          projectId: claimed.projectId,
          action,
          attempt: marker.attempt,
          claimedAt: marker.at,
          claimedBy: this.options.workerId,
        };
      } catch (error) {
        if (error instanceof ConcurrencyError) continue;
        throw error;
      }
    }
    return undefined;
  }

  /** Return a run to the queue; another worker (or this one) can retry it. */
  async release(item: QueuedRun): Promise<void> {
    const run = await this.options.store.runs.get(item.runId);
    if (!run) return;
    try {
      await this.write(run, {
        workerId: 'queue',
        at: 0,
        attempt: item.attempt,
        action: item.action,
      });
    } catch (error) {
      if (!(error instanceof ConcurrencyError)) throw error;
    }
  }

  async depth(): Promise<number> {
    const page = await this.options.store.runs.list({
      ...(this.options.organizationId ? { organizationId: this.options.organizationId } : {}),
      status: ['CREATED', 'QUEUED'],
      limit: 1_000,
    });
    return page.total;
  }

  /**
   * Release claims whose worker stopped heart-beating. The run is not reset:
   * the runtime resumes it from its latest checkpoint (spec §31).
   */
  async reclaimStale(options: { olderThanMs: number }): Promise<string[]> {
    const cutoff = this.now() - options.olderThanMs;
    const page = await this.options.store.runs.list({
      status: [...CLAIMABLE, 'PAUSED'],
      limit: 1_000,
    });
    const released: string[] = [];
    for (const run of page.items) {
      const claim = claimOf(run);
      if (!claim || claim.at === 0 || claim.at > cutoff) continue;
      if (claim.workerId === this.options.workerId) continue;
      try {
        await this.write(run, { ...claim, workerId: 'queue', at: 0 });
        released.push(run.id);
      } catch (error) {
        if (!(error instanceof ConcurrencyError)) throw error;
      }
    }
    return released;
  }

  /** Persist a claim, bumping the version so only one writer can win. */
  private async write(run: AgentRun, marker: ClaimMarker): Promise<AgentRun> {
    const updated: AgentRun = {
      ...run,
      stateVersion: run.stateVersion + 1,
      metadata: { ...(run.metadata ?? {}), [CLAIM_KEY]: marker as unknown as never },
    };
    return this.options.store.runs.update(updated, run.stateVersion);
  }
}

export function claimOf(run: AgentRun): ClaimMarker | undefined {
  const raw = run.metadata?.[CLAIM_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const marker = raw as unknown as ClaimMarker;
  return typeof marker.workerId === 'string' ? marker : undefined;
}

/**
 * A `RunDispatcher` for a store-backed queue: the run is already durable, so
 * dispatching means recording that it is intended to run. Nothing executes in
 * this process - a worker will claim it.
 */
export class StoreQueueDispatcher implements RunDispatcher {
  constructor(private readonly queue: RunQueue) {}

  async dispatch(context: DispatchContext): Promise<void> {
    await this.queue.enqueue(context);
  }

  async depth(): Promise<number> {
    return this.queue.depth();
  }

  async close(): Promise<void> {
    await this.queue.close?.();
  }
}
