import { AgentError, type FailureClassification } from '@kazi-ai/agentos-core';

export interface FailureRule {
  /** Error code (exact or `prefix.*`) this rule matches. */
  code: string;
  kind: string;
  risk?: FailureClassification['risk'];
}

/**
 * Error-code → failure-kind map. Classification is deliberately explicit: the
 * runtime never guesses whether an error is safe to retry (spec §37).
 */
export const DEFAULT_FAILURE_RULES: FailureRule[] = [
  { code: 'tool.timeout', kind: 'tool_timeout', risk: 'LOW' },
  { code: 'tool.invalid_input', kind: 'invalid_arguments', risk: 'LOW' },
  { code: 'tool.not_found', kind: 'tool_unavailable', risk: 'MEDIUM' },
  { code: 'tool.command_failed', kind: 'tool_failure', risk: 'MEDIUM' },
  { code: 'tool.execution_failed', kind: 'tool_failure', risk: 'MEDIUM' },
  { code: 'tool.failed', kind: 'tool_failure', risk: 'MEDIUM' },
  { code: 'tool.*', kind: 'tool_failure', risk: 'MEDIUM' },
  { code: 'provider.authentication', kind: 'authentication_failure', risk: 'HIGH' },
  { code: 'provider.rate_limit', kind: 'provider_unavailable', risk: 'LOW' },
  { code: 'provider.timeout', kind: 'provider_unavailable', risk: 'LOW' },
  { code: 'provider.overloaded', kind: 'provider_unavailable', risk: 'LOW' },
  { code: 'provider.unavailable', kind: 'provider_unavailable', risk: 'LOW' },
  { code: 'provider.*', kind: 'provider_error', risk: 'MEDIUM' },
  { code: 'environment.*', kind: 'environment_failure', risk: 'HIGH' },
  { code: 'verification.failed', kind: 'verification_failed', risk: 'LOW' },
  { code: 'workspace.*', kind: 'environment_failure', risk: 'MEDIUM' },
  { code: 'timeout', kind: 'operation_timeout', risk: 'LOW' },
  { code: 'budget.exceeded', kind: 'budget_exceeded', risk: 'MEDIUM' },
  { code: 'policy.denied', kind: 'policy_denied', risk: 'HIGH' },
  { code: 'policy.approval_denied', kind: 'approval_denied', risk: 'HIGH' },
  { code: 'validation.*', kind: 'invalid_arguments', risk: 'LOW' },
  { code: 'state.invalid_transition', kind: 'state_conflict', risk: 'MEDIUM' },
  { code: 'concurrency.conflict', kind: 'state_conflict', risk: 'MEDIUM' },
  { code: 'resource.exhausted', kind: 'resource_exhausted', risk: 'MEDIUM' },
  // The durable store being unavailable is an infrastructure outage, not a
  // reason to change the plan: back off and let the dependency come back
  // (spec §31, §43). The worker releases the run if the outage outlasts the
  // recovery attempts, so a healthy worker resumes it from its checkpoint.
  { code: 'storage.*', kind: 'resource_exhausted', risk: 'MEDIUM' },
  { code: 'run.cancelled', kind: 'cancelled', risk: 'LOW' },
  { code: 'operation.aborted', kind: 'cancelled', risk: 'LOW' },
  { code: 'configuration.*', kind: 'configuration_error', risk: 'MEDIUM' },
  { code: 'recovery.*', kind: 'recovery_failure', risk: 'MEDIUM' },
];

/**
 * Determines *what kind of failure* happened. The classification feeds the
 * recovery policy map, so it drives everything downstream.
 */
export class FailureClassifier {
  private rules: FailureRule[];

  constructor(rules: FailureRule[] = DEFAULT_FAILURE_RULES) {
    this.rules = [...rules];
  }

  register(rule: FailureRule): void {
    this.rules.unshift(rule);
  }

  list(): FailureRule[] {
    return [...this.rules];
  }

  classify(error: AgentError | Error): FailureClassification {
    const agentError = error instanceof AgentError ? error : undefined;
    const code = agentError?.code ?? classifyUnknownCode(error);
    const rule = this.rules.find((candidate) => matchesCode(candidate.code, code));
    const kind = rule?.kind ?? 'unknown';
    return {
      kind,
      category: agentError?.category ?? 'internal',
      // An unclassified error is never assumed safe to retry.
      retryable: agentError?.retryable ?? false,
      idempotency: agentError?.idempotency ?? 'unknown',
      terminal: agentError?.terminal ?? false,
      risk: rule?.risk ?? 'MEDIUM',
      message: agentError?.message ?? error.message,
    };
  }
}

function classifyUnknownCode(error: Error): string {
  if (error.name === 'AbortError') return 'operation.aborted';
  return 'unknown';
}

export function matchesCode(pattern: string, code: string): boolean {
  if (pattern === '*') return true;
  if (pattern === code) return true;
  if (pattern.endsWith('.*')) return code.startsWith(`${pattern.slice(0, -1)}`);
  return false;
}

/** Classifications the runtime treats as terminal without consulting policy. */
export const TERMINAL_KINDS = new Set(['budget_exceeded', 'policy_denied', 'cancelled']);
