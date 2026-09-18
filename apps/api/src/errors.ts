import {
  AgentError,
  ApprovalDeniedError,
  ApprovalRequiredError,
  BudgetExceededError,
  CancelledError,
  ConcurrencyError,
  ConfigurationError,
  InvalidTransitionError,
  NotFoundError,
  PolicyDeniedError,
  ProviderError,
  ResourceExhaustedError,
  ToolExecutionError,
  ToolInputError,
  ToolNotFoundError,
  ToolTimeoutError,
  ValidationError,
  toJsonValue,
  type JsonValue,
} from '@kazi-ai/agentos-core';

/** An error carrying the HTTP status and machine-readable code clients switch on. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly detail?: JsonValue,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string, detail?: JsonValue): ApiError {
  return new ApiError(400, 'INVALID_REQUEST', message, detail);
}

export function unauthorized(message = 'Authentication is required'): ApiError {
  return new ApiError(401, 'UNAUTHENTICATED', message);
}

export function forbidden(message: string, detail?: JsonValue): ApiError {
  return new ApiError(403, 'FORBIDDEN', message, detail);
}

export function conflict(message: string, detail?: JsonValue): ApiError {
  return new ApiError(409, 'CONFLICT', message, detail);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}

/**
 * Map any thrown value onto a response. Unknown errors become 500s: an
 * exception must never be swallowed, and it must never leak internals either
 * (spec §104).
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ValidationError) return new ApiError(400, 'INVALID_REQUEST', error.message);
  if (error instanceof ToolInputError) return new ApiError(400, 'INVALID_TOOL_INPUT', error.message);
  if (error instanceof ToolNotFoundError) return new ApiError(404, 'TOOL_NOT_FOUND', error.message);
  if (error instanceof NotFoundError) return new ApiError(404, 'NOT_FOUND', error.message);
  if (error instanceof PolicyDeniedError) return new ApiError(403, 'POLICY_DENIED', error.message);
  if (error instanceof ApprovalDeniedError) return new ApiError(403, 'APPROVAL_DENIED', error.message);
  if (error instanceof ApprovalRequiredError) {
    return new ApiError(409, 'APPROVAL_REQUIRED', error.message);
  }
  if (error instanceof BudgetExceededError) return new ApiError(409, 'BUDGET_EXCEEDED', error.message);
  if (error instanceof ResourceExhaustedError) {
    return new ApiError(429, 'RESOURCE_EXHAUSTED', error.message);
  }
  if (error instanceof ConcurrencyError) return new ApiError(409, 'CONFLICT', error.message);
  if (error instanceof InvalidTransitionError) return new ApiError(409, 'CONFLICT', error.message);
  if (error instanceof CancelledError) return new ApiError(409, 'CANCELLED', error.message);
  if (error instanceof ToolTimeoutError) return new ApiError(504, 'TOOL_TIMEOUT', error.message);
  if (error instanceof ToolExecutionError) return new ApiError(502, 'TOOL_FAILED', error.message);
  if (error instanceof ProviderError) return new ApiError(502, 'PROVIDER_ERROR', error.message);
  if (error instanceof ConfigurationError) {
    return new ApiError(500, 'CONFIGURATION_ERROR', error.message);
  }
  if (error instanceof AgentError) return new ApiError(500, 'AGENT_ERROR', error.message);
  const message = error instanceof Error ? error.message : String(error);
  return new ApiError(500, 'INTERNAL_ERROR', message);
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    detail?: JsonValue;
  };
}

export function errorBody(error: ApiError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: toJsonValue(error.detail) }),
    },
  };
}
