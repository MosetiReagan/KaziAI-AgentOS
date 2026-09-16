import { ResourceExhaustedError, type Logger } from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';

export interface BackpressureLimits {
  /** Runs executing concurrently across the whole runtime. */
  maxConcurrentRuns: number;
  /** Active runs per organization. */
  maxRunsPerOrganization: number;
  /** Refuse to queue more than this many runs awaiting execution. */
  maxQueueDepth: number;
}

export const DEFAULT_BACKPRESSURE: BackpressureLimits = {
  maxConcurrentRuns: 8,
  maxRunsPerOrganization: 32,
  maxQueueDepth: 1_000,
};

export interface BackpressureDecision {
  allowed: boolean
  reason?: string;
  detail?: Record<string, number | string>;
}

/**
 * Refuses work before it is accepted. Returning `RESOURCE_EXHAUSTED` is far
 * better than letting the system grow until it dies (spec §83).
 */
export class Backpressure {
  private readonly limits: BackpressureLimits;
  private running = 0;

  constructor(
    options: Partial<BackpressureLimits> = {},
    private readonly store?: AgentOSStore,
    private readonly logger?: Logger,
  ) {
    this.limits = { ...DEFAULT_BACKPRESSURE, ...options };
  }

  get active(): number {
    return this.running;
  }

  get maximum(): BackpressureLimits {
    return { ...this.limits };
  }

  /** Reserve a slot for a run that is about to execute. */
  reserve(): void {
    if (this.running >= this.limits.maxConcurrentRuns) {
      throw new ResourceExhaustedError(
        `Cannot start another run: ${this.running} of ${this.limits.maxConcurrentRuns} execution slots are in use`,
        { dimension: 'concurrent_runs', limit: this.limits.maxConcurrentRuns, running: this.running },
      );
    }
    this.running += 1;
  }

  release(): void {
    this.running = Math.max(0, this.running - 1);
  }

  async check(input: { organizationId: string; queueDepth?: number }): Promise<BackpressureDecision> {
    if (this.running >= this.limits.maxConcurrentRuns) {
      return {
        allowed: false,
        reason: `the runtime is already executing ${this.running} runs`,
        detail: { running: this.running, maxConcurrentRuns: this.limits.maxConcurrentRuns },
      };
    }
    if (this.store) {
      const active = await this.store.runs.countActive(input.organizationId);
      if (active >= this.limits.maxRunsPerOrganization) {
        return {
          allowed: false,
          reason: `organization ${input.organizationId} already has ${active} active runs`,
          detail: { active, maxRunsPerOrganization: this.limits.maxRunsPerOrganization },
        };
      }
    }
    if (input.queueDepth !== undefined && input.queueDepth >= this.limits.maxQueueDepth) {
      return {
        allowed: false,
        reason: `the run queue is full (${input.queueDepth})`,
        detail: { queueDepth: input.queueDepth, maxQueueDepth: this.limits.maxQueueDepth },
      };
    }
    return { allowed: true };
  }

  /** Throwing variant used by `createRun`. */
  async assertAccepting(input: { organizationId: string; queueDepth?: number }): Promise<void> {
    const decision = await this.check(input);
    if (decision.allowed) return;
    this.logger?.warn('backpressure rejected a run', { organizationId: input.organizationId, reason: decision.reason });
    throw new ResourceExhaustedError(`Refusing to accept the run: ${decision.reason ?? 'capacity exhausted'}`, {
      dimension: 'run_capacity',
      limit: this.limits.maxConcurrentRuns,
      running: this.running,
      ...(decision.detail ?? {}),
    });
  }
}
