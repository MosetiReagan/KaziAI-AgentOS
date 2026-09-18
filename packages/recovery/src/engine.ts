import {
  SystemClock,
  type AgentError,
  type Checkpoint,
  type CircuitBreaker,
  type Clock,
  type FailureClassification,
  type JsonObject,
  type ModelRef,
  type RecoveryContext,
  type RecoveryDecision,
  type RecoveryEngine,
  type RecoveryPolicy,
  type RecoveryResult,
} from '@kazi-ai/agentos-core';
import { FailureClassifier, TERMINAL_KINDS } from './classify.js';
import { DEFAULT_RECOVERY_POLICIES, type RecoveryPolicyMap } from './policies.js';
import { RetryEngine } from './retry-engine.js';

const RETRY_STRATEGIES = new Set(['retry', 'retry_with_backoff']);

export interface CheckpointLookup {
  get(checkpointId: string): Promise<Checkpoint | undefined>;
  latest(runId: string): Promise<Checkpoint | undefined>;
}

export interface ProviderSwitchRequest {
  runId: string;
  /** Provider that failed, when known. */
  failed?: ModelRef;
  /** Provider the runtime should move to. */
  to?: ModelRef;
  reason: string;
}

export interface HumanInterventionRequest {
  runId: string;
  summary: string;
  reason: string;
  classification: FailureClassification;
  metadata?: JsonObject;
}

export interface RecoveryEngineOptions {
  policies?: RecoveryPolicyMap;
  classifier?: FailureClassifier;
  retry?: RetryEngine;
  clock?: Clock;
  checkpoints?: CheckpointLookup;
  /**
   * Resolve the next configured provider without activating it. Must be free of
   * side effects: `decide` calls it, `execute` calls it again when needed.
   */
  failover?(input: ProviderSwitchRequest): Promise<ModelRef | undefined>;
  /** Activate a provider switch and return the provider now in use. */
  switchProvider?(input: ProviderSwitchRequest & { to: ModelRef }): Promise<ModelRef | undefined>;
  /** Create a durable human intervention request and park the run. */
  requestHuman?(input: HumanInterventionRequest): Promise<{ approvalId?: string } | undefined>;
  /**
   * Recovery policies that depend on the run rather than the deployment, e.g.
   * the `recovery:` block of the agent definition executing it (spec §35).
   * Resolved per decision, so two runs on one worker can recover differently.
   */
  policiesFor?(runId: string): RecoveryPolicyMap | undefined | Promise<RecoveryPolicyMap | undefined>;
  circuitBreakers?: { get(key: string): CircuitBreaker };
  /** Wait out the backoff inside `execute` before the runtime retries. */
  awaitBackoff?: boolean;
}

/**
 * Decides how to recover from a failure and applies the parts of the decision
 * the executor cannot apply on its own: checkpoint restore, provider failover,
 * human escalation and backoff (spec §34-§38).
 */
export class DefaultRecoveryEngine implements RecoveryEngine {
  private readonly policies: RecoveryPolicyMap;
  private readonly classifier: FailureClassifier;
  private readonly retry: RetryEngine;
  private readonly clock: Clock;
  private readonly options: RecoveryEngineOptions;

  constructor(options: RecoveryEngineOptions = {}) {
    this.options = options;
    this.policies = { ...DEFAULT_RECOVERY_POLICIES, ...(options.policies ?? {}) };
    this.classifier = options.classifier ?? new FailureClassifier();
    this.retry = options.retry ?? new RetryEngine({ classifier: this.classifier });
    this.clock = options.clock ?? new SystemClock();
  }

  classify(error: AgentError): FailureClassification {
    return this.classifier.classify(error);
  }

  policyFor(kind: string): RecoveryPolicy {
    return this.policies[kind] ?? this.policies['unknown'] ?? DEFAULT_RECOVERY_POLICIES['unknown']!;
  }

  /**
   * The policy that applies to this run: the agent definition's own entry for
   * the failure kind wins over the deployment default.
   */
  async policyForRun(kind: string, runId: string): Promise<RecoveryPolicy> {
    const overrides = await this.options.policiesFor?.(runId);
    return overrides?.[kind] ?? this.policyFor(kind);
  }

  async decide(context: RecoveryContext): Promise<RecoveryDecision> {
    const classification = context.classification;
    const policy = await this.policyForRun(classification.kind, context.runId);
    const maxAttempts = policy.maxAttempts ?? 1;

    if (classification.terminal || TERMINAL_KINDS.has(classification.kind)) {
      return this.decision(policy, context, `failure "${classification.kind}" is terminal`, { terminal: true });
    }

    // A non-idempotent action with a journaled intent but no commit may or may
    // not have landed. Never guess: escalate to a human (spec §32).
    const journalPending = context.metadata?.['journalPending'] === true;
    if (journalPending && (classification.idempotency === 'non-idempotent' || RETRY_STRATEGIES.has(policy.strategy))) {
      return this.decision({ ...policy, strategy: 'ask_human' }, context, 'the previous attempt is uncommitted and cannot be safely repeated');
    }
    if (classification.idempotency === 'non-idempotent' && context.actionCommitted) {
      return this.decision(
        { ...policy, strategy: 'skip_step' },
        context,
        'the action already committed; repeating it would duplicate its side effects',
      );
    }

    const dependency = this.dependencyOf(context);
    const circuitOpen = dependency !== undefined && this.isCircuitOpen(dependency);
    if (circuitOpen && dependency) {
      const alternative = await this.probeFailover(context, `dependency "${dependency}" has an open circuit breaker`);
      if (alternative) return alternative;
      if (RETRY_STRATEGIES.has(policy.strategy)) {
        return this.decision(
          { ...policy, strategy: 'ask_human' },
          context,
          `dependency "${dependency}" has an open circuit breaker; retrying would hammer a failing service`,
        );
      }
    }

    // An error that declares itself non-retryable must not be retried, whatever
    // the policy map says: repeating it cannot succeed and only burns budget
    // (spec §37). Recovery must change the approach instead.
    if (classification.retryable === false && RETRY_STRATEGIES.has(policy.strategy)) {
      return this.decision(
        { ...policy, strategy: 'replan' },
        context,
        `failure "${classification.kind}" is not retryable; re-planning instead of repeating it`,
      );
    }

    if (context.attempt >= maxAttempts && policy.strategy !== 'ask_human') {
      return this.decision(policy, context, `recovery attempts exhausted (${context.attempt}/${maxAttempts})`, { terminal: true });
    }

    if (policy.strategy === 'switch_provider') {
      const switched = await this.probeFailover(context, `policy for "${classification.kind}": switch_provider`);
      if (switched) return switched;
      return this.decision(
        { ...policy, strategy: classification.retryable ? 'retry_with_backoff' : 'ask_human' },
        context,
        'no fallback provider is configured for this failure',
      );
    }

    return this.decision(policy, context, `policy for "${classification.kind}": ${policy.strategy}`);
  }

  async execute(decision: RecoveryDecision, context: RecoveryContext): Promise<RecoveryResult> {
    switch (decision.strategy) {
      case 'retry':
      case 'replan':
      case 'skip_step':
      case 'terminate':
      case 'switch_tool':
        return { decision, applied: true, detail: { strategy: decision.strategy } };

      case 'modify_arguments':
        return {
          decision,
          applied: decision.arguments !== undefined,
          detail: decision.arguments === undefined ? { reason: 'no replacement arguments supplied' } : { strategy: 'modify_arguments' },
        };

      case 'retry_with_backoff': {
        const delayMs = decision.delayMs ?? 0;
        const awaited = delayMs > 0 && this.options.awaitBackoff !== false;
        if (awaited) await this.clock.sleep(delayMs);
        return { decision, applied: true, detail: { delayMs, awaited } };
      }

      case 'switch_provider': {
        const request = this.switchRequest(context, decision);
        const target = decision.provider ?? (await this.options.failover?.(request));
        if (!target) return { decision, applied: false, detail: { reason: 'no fallback provider available' } };
        const switched = this.options.switchProvider
          ? await this.options.switchProvider({ ...request, to: target })
          : target;
        return switched
          ? { decision, applied: true, detail: { provider: switched.provider, model: switched.model } }
          : { decision, applied: false, detail: { reason: 'provider switch rejected' } };
      }

      case 'restore_checkpoint': {
        const lookup = this.options.checkpoints;
        if (!lookup) return { decision, applied: false, detail: { reason: 'no checkpoint store configured' } };
        const checkpoint = decision.checkpointId
          ? await lookup.get(decision.checkpointId)
          : await lookup.latest(context.runId);
        if (!checkpoint) {
          return { decision, applied: false, detail: { reason: 'no checkpoint available for this run' } };
        }
        return {
          decision,
          applied: true,
          detail: {
            checkpointId: checkpoint.id,
            sequence: checkpoint.sequence,
            stateVersion: checkpoint.stateVersion,
          },
        };
      }

      case 'ask_human': {
        const requestHuman = this.options.requestHuman;
        if (!requestHuman) {
          return { decision, applied: false, detail: { reason: 'no human intervention channel configured' } };
        }
        const result = await requestHuman({
          runId: context.runId,
          summary: `Recovery needs a human decision: ${context.classification.message}`,
          reason: decision.reason,
          classification: context.classification,
          ...(context.metadata ? { metadata: context.metadata } : {}),
        });
        return {
          decision,
          applied: true,
          detail: { ...(result?.approvalId ? { approvalId: result.approvalId } : {}), status: 'waiting' },
        };
      }

      default: {
        const exhaustive: never = decision.strategy;
        return { decision, applied: false, detail: { reason: `unsupported strategy ${String(exhaustive)}` } };
      }
    }
  }

  private async probeFailover(context: RecoveryContext, reason: string): Promise<RecoveryDecision | undefined> {
    if (!this.options.failover) return undefined;
    const target = await this.options.failover(this.switchRequest(context, { strategy: 'switch_provider', reason }));
    if (!target) return undefined;
    return {
      strategy: 'switch_provider',
      reason,
      provider: target,
    };
  }

  private decision(
    policy: RecoveryPolicy,
    context: RecoveryContext,
    reason: string,
    extra: Partial<RecoveryDecision> = {},
  ): RecoveryDecision {
    const decision: RecoveryDecision = { strategy: policy.strategy, reason, ...extra };
    // A terminal decision always reads as `terminate` so callers never have to
    // inspect two fields to learn that the run is over.
    if (decision.terminal) decision.strategy = 'terminate';
    if (policy.strategy === 'retry_with_backoff') {
      decision.delayMs = this.retry.delayFor(context.attempt + 1, {
        ...(policy.baseDelayMs === undefined ? {} : { baseDelayMs: policy.baseDelayMs }),
        ...(policy.maxDelayMs === undefined ? {} : { maxDelayMs: policy.maxDelayMs }),
      });
    }
    return decision;
  }

  private dependencyOf(context: RecoveryContext): string | undefined {
    const explicit = context.metadata?.['dependency'];
    if (typeof explicit === 'string') return explicit;
    if (context.toolId) return `tool:${context.toolId}`;
    return undefined;
  }

  private isCircuitOpen(key: string): boolean {
    const breaker = this.options.circuitBreakers?.get(key);
    return breaker ? !breaker.isAllowed() : false;
  }

  private switchRequest(context: RecoveryContext, decision: RecoveryDecision): ProviderSwitchRequest {
    const provider = context.metadata?.['provider'];
    const failed =
      provider !== null && typeof provider === 'object' && !Array.isArray(provider)
        ? readModelRef(provider as Record<string, unknown>)
        : undefined;
    return {
      runId: context.runId,
      ...(failed ? { failed } : {}),
      ...(decision.provider ? { to: decision.provider } : {}),
      reason: decision.reason,
    };
  }
}

function readModelRef(value: Record<string, unknown>): ModelRef | undefined {
  const provider = value['provider'];
  const model = value['model'];
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  return { provider, model };
}
