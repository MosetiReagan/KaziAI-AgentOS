import type { Logger } from '@kazi-ai/agentos-core';
import type { AgentOSRuntime } from '@kazi-ai/agentos-runtime';

export type DispatchAction = 'start' | 'resume' | 'retry';

export interface DispatchContext {
  runId: string;
  organizationId: string;
  projectId: string;
  /** Which lifecycle command the executor should replay for this run. */
  action: DispatchAction;
}

/**
 * How an accepted run is handed to an executor. The API never assumes the
 * execution happens in its own process: the worker app supplies a queue-backed
 * dispatcher, and the default one executes inline (spec §43, §44).
 */
export interface RunDispatcher {
  dispatch(context: DispatchContext): Promise<void>;
  /** Resolve when everything dispatched here has reached a resting point. */
  drain?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Executes runs in this process. The HTTP response is not held open: the run
 * continues in the background and every result is durable, so a client that
 * disconnects loses nothing (spec §41).
 */
export class InProcessDispatcher implements RunDispatcher {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly runtime: AgentOSRuntime,
    private readonly logger?: Logger,
  ) {}

  dispatch(context: DispatchContext): Promise<void> {
    const execute =
      context.action === 'resume'
        ? this.runtime.resume(context.runId)
        : context.action === 'retry'
          ? this.runtime.retry(context.runId)
          : this.runtime.start(context.runId);
    const promise = execute
      .catch((error: unknown) => {
        this.logger?.error('inline run failed', {
          runId: context.runId,
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.pending.delete(promise);
      });
    this.pending.add(promise);
    return Promise.resolve();
  }

  /** Wait for every in-flight run. Used by tests, shutdown and `doctor`. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  get active(): number {
    return this.pending.size;
  }
}

/** Records dispatches without executing them; used by API tests. */
export class RecordingDispatcher implements RunDispatcher {
  readonly dispatched: DispatchContext[] = [];

  dispatch(context: DispatchContext): Promise<void> {
    this.dispatched.push(context);
    return Promise.resolve();
  }
}
