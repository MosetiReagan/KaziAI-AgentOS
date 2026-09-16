import type { JsonValue } from './json.js';

export type ErrorCategory =
  | 'policy'
  | 'authorization'
  | 'budget'
  | 'tool'
  | 'provider'
  | 'environment'
  | 'validation'
  | 'memory'
  | 'state'
  | 'concurrency'
  | 'resource'
  | 'network'
  | 'human'
  | 'internal';

export type IdempotencyClass = 'idempotent' | 'retry-safe' | 'non-idempotent' | 'unknown';

export interface AgentErrorInit {
  code: string;
  message: string;
  category: ErrorCategory;
  retryable?: boolean;
  idempotency?: IdempotencyClass;
  details?: Record<string, JsonValue>;
  cause?: unknown;
  /** Terminal errors can never be recovered from; they end the run. */
  terminal?: boolean;
}

const SENSITIVE_KEY = /(authorization|api[-_]?key|password|secret|token|cookie)/i;

function safeDetails(details?: Record<string, JsonValue>): Record<string, JsonValue> {
  if (!details) return {};
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(details)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : value;
  }
  return out;
}

/** Base class for every error AgentOS produces. Classification is never lost. */
export class AgentError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly idempotency: IdempotencyClass;
  readonly details: Record<string, JsonValue>;
  readonly terminal: boolean;

  constructor(init: AgentErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.category = init.category;
    this.retryable = init.retryable ?? false;
    this.idempotency = init.idempotency ?? 'unknown';
    this.details = safeDetails(init.details);
    this.terminal = init.terminal ?? false;
  }

  toJSON(): Record<string, JsonValue> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      idempotency: this.idempotency,
      terminal: this.terminal,
      details: this.details,
    };
  }
}

type SubclassInit = Partial<Omit<AgentErrorInit, 'message' | 'category'>>;

export class PolicyDeniedError extends AgentError {
  constructor(message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'policy.denied',
      message,
      category: 'policy',
      retryable: false,
      terminal: false,
      idempotency: 'idempotent',
      details: details ?? {},
    });
  }
}

export class ApprovalRequiredError extends AgentError {
  readonly approvalId: string;
  constructor(approvalId: string, message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'policy.approval_required',
      message,
      category: 'human',
      retryable: false,
      idempotency: 'idempotent',
      details: details ?? {},
    });
    this.approvalId = approvalId;
  }
}

export class ApprovalDeniedError extends AgentError {
  constructor(approvalId: string, reason?: string) {
    super({
      code: 'policy.approval_denied',
      message: reason ? `Approval ${approvalId} denied: ${reason}` : `Approval ${approvalId} denied`,
      category: 'human',
      retryable: false,
      idempotency: 'idempotent',
      details: { approvalId },
    });
  }
}

export class ToolNotFoundError extends AgentError {
  constructor(toolId: string) {
    super({
      code: 'tool.not_found',
      message: `Unknown tool: ${toolId}`,
      category: 'tool',
      terminal: true,
      idempotency: 'idempotent',
      details: { toolId },
    });
  }
}

export class ToolExecutionError extends AgentError {
  constructor(toolId: string, message: string, init: SubclassInit = {}) {
    super({
      code: init.code ?? 'tool.execution_failed',
      message,
      category: 'tool',
      retryable: init.retryable ?? false,
      idempotency: init.idempotency ?? 'unknown',
      terminal: init.terminal ?? false,
      details: { toolId, ...(init.details ?? {}) },
      ...(init.cause !== undefined ? { cause: init.cause } : {}),
    });
  }
}

export class ToolInputError extends AgentError {
  constructor(toolId: string, message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'tool.invalid_input',
      message,
      category: 'validation',
      retryable: false,
      idempotency: 'idempotent',
      details: { toolId, ...(details ?? {}) },
    });
  }
}

export class ToolTimeoutError extends AgentError {
  constructor(toolId: string, timeoutMs: number) {
    super({
      code: 'tool.timeout',
      message: `Tool ${toolId} exceeded ${timeoutMs}ms`,
      category: 'tool',
      retryable: true,
      idempotency: 'unknown',
      details: { toolId, timeoutMs },
    });
  }
}

export class BudgetExceededError extends AgentError {
  constructor(dimension: string, limit: number, actual: number) {
    super({
      code: 'budget.exceeded',
      message: `Budget exceeded for ${dimension}: limit ${limit}, actual ${actual}`,
      category: 'budget',
      retryable: false,
      terminal: true,
      idempotency: 'idempotent',
      details: { dimension, limit, actual },
    });
  }
}

export class ProviderError extends AgentError {
  constructor(provider: string, message: string, init: SubclassInit = {}) {
    super({
      code: init.code ?? 'provider.error',
      message,
      category: 'provider',
      retryable: init.retryable ?? true,
      // Retryability is a property of the call, not the vendor: a provider call
      // that triggers billing or a write may be non-idempotent.
      idempotency: init.idempotency ?? 'retry-safe',
      details: { provider, ...(init.details ?? {}) },
      ...(init.cause !== undefined ? { cause: init.cause } : {}),
    });
  }
}

export class ValidationError extends AgentError {
  constructor(message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'validation.failed',
      message,
      category: 'validation',
      idempotency: 'idempotent',
      details: details ?? {},
    });
  }
}

export class InvalidTransitionError extends AgentError {
  constructor(from: string, to: string, trigger: string) {
    super({
      code: 'state.invalid_transition',
      message: `Invalid state transition ${from} -> ${to} via ${trigger}`,
      category: 'state',
      terminal: true,
      idempotency: 'idempotent',
      details: { from, to, trigger },
    });
  }
}

export class ConcurrencyError extends AgentError {
  constructor(message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'concurrency.conflict',
      message,
      category: 'concurrency',
      retryable: true,
      idempotency: 'retry-safe',
      details: details ?? {},
    });
  }
}

export class ResourceExhaustedError extends AgentError {
  constructor(message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'resource.exhausted',
      message,
      category: 'resource',
      retryable: true,
      idempotency: 'retry-safe',
      details: details ?? {},
    });
  }
}

export class EnvironmentError extends AgentError {
  constructor(message: string, init: SubclassInit = {}) {
    super({
      code: init.code ?? 'environment.error',
      message,
      category: 'environment',
      retryable: init.retryable ?? false,
      idempotency: init.idempotency ?? 'unknown',
      terminal: init.terminal ?? false,
      details: init.details ?? {},
      ...(init.cause !== undefined ? { cause: init.cause } : {}),
    });
  }
}

export class NotFoundError extends AgentError {
  constructor(kind: string, id: string) {
    super({
      code: `${kind}.not_found`,
      message: `${kind} not found: ${id}`,
      category: 'validation',
      terminal: true,
      idempotency: 'idempotent',
      details: { id },
    });
  }
}

export class ConfigurationError extends AgentError {
  constructor(message: string, details?: Record<string, JsonValue>) {
    super({
      code: 'configuration.invalid',
      message,
      category: 'validation',
      terminal: true,
      idempotency: 'idempotent',
      details: details ?? {},
    });
  }
}

export class CancelledError extends AgentError {
  constructor(message = 'Run cancelled') {
    super({
      code: 'run.cancelled',
      message,
      category: 'state',
      terminal: true,
      idempotency: 'idempotent',
    });
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}

/** Wrap any thrown value into an AgentError so nothing is ever swallowed unclassified. */
export function toAgentError(value: unknown, fallbackCode = 'internal.error'): AgentError {
  if (value instanceof AgentError) return value;
  if (value instanceof Error) {
    return new AgentError({
      code: fallbackCode,
      message: value.message,
      category: 'internal',
      details: { name: value.name },
      cause: value,
    });
  }
  return new AgentError({
    code: fallbackCode,
    message: typeof value === 'string' ? value : `Non-error thrown: ${String(value)}`,
    category: 'internal',
  });
}

export function normalizeAbortError(value: unknown, fallback = 'Operation aborted'): AgentError {
  const error = toAgentError(value);
  if (error.code === 'ABORT_ERR' || /abort/i.test(error.message)) {
    return new AgentError({
      code: 'operation.aborted',
      message: error.message || fallback,
      category: 'state',
      retryable: false,
      idempotency: 'unknown',
    });
  }
  return error;
}
