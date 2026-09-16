import type { JsonObject } from '../json.js';
import type { AgentError } from '../errors.js';
import type { Plan } from './plan.js';

export type RecoveryStrategy =
  | 'retry'
  | 'retry_with_backoff'
  | 'modify_arguments'
  | 'replan'
  | 'switch_tool'
  | 'switch_provider'
  | 'restore_checkpoint'
  | 'ask_human'
  | 'terminate'
  | 'skip_step';

export interface FailureClassification {
  /** Stable key used to look up a recovery policy, e.g. `tool_timeout`. */
  kind: string;
  category: string;
  retryable: boolean;
  idempotency: 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';
  terminal: boolean;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
}

export interface RecoveryContext {
  runId: string;
  attempt: number;
  error: AgentError;
  classification: FailureClassification;
  toolId?: string;
  stepId?: string;
  /** Whether the failed action already committed (journal tells us). */
  actionCommitted: boolean;
  plan?: Plan;
  budgetRemaining?: JsonObject;
  metadata?: JsonObject;
}

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  reason: string;
  /** Backoff delay before retrying. */
  delayMs?: number;
  /** Replacement arguments for `modify_arguments`. */
  arguments?: unknown;
  /** Replacement tool for `switch_tool`. */
  toolId?: string;
  /** Replacement provider for `switch_provider`. */
  provider?: { provider: string; model: string };
  checkpointId?: string;
  /** True when the runtime should stop the run. */
  terminal?: boolean;
}

export interface RecoveryResult {
  decision: RecoveryDecision;
  applied: boolean;
  detail?: JsonObject;
}

export interface RecoveryPolicy {
  kind: string;
  strategy: RecoveryStrategy;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RecoveryEngine {
  classify(error: AgentError): FailureClassification;
  decide(context: RecoveryContext): Promise<RecoveryDecision>;
  execute(decision: RecoveryDecision, context: RecoveryContext): Promise<RecoveryResult>;
}

export interface CircuitBreaker {
  readonly key: string;
  state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  isAllowed(): boolean;
  recordSuccess(): void;
  recordFailure(error?: unknown): void;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  openMs?: number;
  halfOpenMaxCalls?: number;
}

