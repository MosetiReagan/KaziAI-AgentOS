import { ValidationError, type RecoveryPolicy, type RecoveryStrategy } from '@kazi-ai/agentos-core';

const STRATEGIES: RecoveryStrategy[] = [
  'retry',
  'retry_with_backoff',
  'modify_arguments',
  'replan',
  'switch_tool',
  'switch_provider',
  'restore_checkpoint',
  'ask_human',
  'terminate',
  'skip_step',
];

/**
 * Default recovery behaviour per failure kind. These mirror the YAML in the
 * specification (§35) and can be overridden per organization or per agent.
 */
export const DEFAULT_RECOVERY_POLICIES: Record<string, RecoveryPolicy> = {
  tool_timeout: { kind: 'tool_timeout', strategy: 'retry_with_backoff', maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 },
  tool_failure: { kind: 'tool_failure', strategy: 'retry_with_backoff', maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 15_000 },
  tool_unavailable: { kind: 'tool_unavailable', strategy: 'switch_tool', maxAttempts: 1 },
  operation_timeout: { kind: 'operation_timeout', strategy: 'retry_with_backoff', maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 },
  invalid_arguments: { kind: 'invalid_arguments', strategy: 'replan', maxAttempts: 2 },
  provider_unavailable: { kind: 'provider_unavailable', strategy: 'switch_provider', maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 20_000 },
  provider_error: { kind: 'provider_error', strategy: 'retry_with_backoff', maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 20_000 },
  authentication_failure: { kind: 'authentication_failure', strategy: 'ask_human', maxAttempts: 1 },
  environment_failure: { kind: 'environment_failure', strategy: 'restore_checkpoint', maxAttempts: 2 },
  state_conflict: { kind: 'state_conflict', strategy: 'retry_with_backoff', maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 },
  verification_failed: { kind: 'verification_failed', strategy: 'replan', maxAttempts: 2 },
  resource_exhausted: { kind: 'resource_exhausted', strategy: 'retry_with_backoff', maxAttempts: 3, baseDelayMs: 2_000, maxDelayMs: 30_000 },
  budget_exceeded: { kind: 'budget_exceeded', strategy: 'terminate', maxAttempts: 0 },
  policy_denied: { kind: 'policy_denied', strategy: 'terminate', maxAttempts: 0 },
  approval_denied: { kind: 'approval_denied', strategy: 'skip_step', maxAttempts: 0 },
  cancelled: { kind: 'cancelled', strategy: 'terminate', maxAttempts: 0 },
  configuration_error: { kind: 'configuration_error', strategy: 'ask_human', maxAttempts: 1 },
  recovery_failure: { kind: 'recovery_failure', strategy: 'terminate', maxAttempts: 0 },
  unknown: { kind: 'unknown', strategy: 'replan', maxAttempts: 1 },
};

export type RecoveryPolicyMap = Record<string, RecoveryPolicy>;

/** Shape of the `recovery:` block as it appears in configuration files. */
export interface RecoveryPolicyDocument {
  recovery?: Record<string, unknown>;
}

interface RecoveryPolicyEntry {
  strategy?: unknown;
  max_attempts?: unknown;
  maxAttempts?: unknown;
  base_delay_ms?: unknown;
  baseDelayMs?: unknown;
  max_delay_ms?: unknown;
  maxDelayMs?: unknown;
}

/**
 * Parse the `recovery:` section of an agent definition. Unknown strategy names
 * are rejected rather than silently ignored, so a typo cannot disable recovery.
 */
export function parseRecoveryPolicies(document: RecoveryPolicyDocument | undefined): RecoveryPolicyMap {
  const entries = document?.recovery ?? {};
  const policies: RecoveryPolicyMap = {};
  for (const [kind, value] of Object.entries(entries)) {
    if (typeof value === 'string') {
      assertStrategy(value, kind);
      policies[kind] = { kind, strategy: value as RecoveryStrategy };
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError(`Recovery policy for "${kind}" must be a strategy name or a mapping`, { kind });
    }
    const entry = value as RecoveryPolicyEntry;
    assertStrategy(String(entry.strategy), kind);
    const strategy = entry.strategy as RecoveryStrategy;
    const policy: RecoveryPolicy = { kind, strategy };
    const maxAttempts = positiveInt(entry.maxAttempts ?? entry.max_attempts, `${kind}.max_attempts`);
    const baseDelayMs = positiveInt(entry.baseDelayMs ?? entry.base_delay_ms, `${kind}.base_delay_ms`);
    const maxDelayMs = positiveInt(entry.maxDelayMs ?? entry.max_delay_ms, `${kind}.max_delay_ms`);
    if (maxAttempts !== undefined) policy.maxAttempts = maxAttempts;
    if (baseDelayMs !== undefined) policy.baseDelayMs = baseDelayMs;
    if (maxDelayMs !== undefined) policy.maxDelayMs = maxDelayMs;
    policies[kind] = policy;
  }
  return policies;
}

function positiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, { field, value: String(value) });
  }
  return value;
}

function assertStrategy(strategy: string, kind: string): void {
  if (!STRATEGIES.includes(strategy as RecoveryStrategy)) {
    throw new ValidationError(`Unknown recovery strategy "${strategy}" for failure kind "${kind}"`, {
      kind,
      strategy,
      allowed: STRATEGIES,
    });
  }
}
