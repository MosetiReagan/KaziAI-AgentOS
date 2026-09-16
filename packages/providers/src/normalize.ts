import {
  ProviderError,
  toJsonValue,
  type ContentBlock,
  type JsonObject,
  type JsonValue,
  type ModelResponse,
  type TokenUsage,
  type ToolCallRequest,
} from '@kazi-ai/agentos-core';

export function usageOf(input: {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}): TokenUsage {
  const inputTokens = input.inputTokens ?? 0;
  const outputTokens = input.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    ...(input.cachedInputTokens === undefined ? {} : { cachedInputTokens: input.cachedInputTokens }),
    ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
    totalTokens: input.totalTokens ?? inputTokens + outputTokens,
  };
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

/** Tool arguments arrive as a JSON object or a JSON-encoded string; normalize both. */
export function parseToolArguments(raw: unknown, toolName: string): JsonValue {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return {};
    try {
      return toJsonValue(JSON.parse(trimmed));
    } catch (error) {
      throw new ProviderError('normalize', `Tool call ${toolName} returned malformed JSON arguments`, {
        code: 'provider.malformed_tool_arguments',
        retryable: true,
        details: { toolName, preview: trimmed.slice(0, 200) },
        cause: error,
      });
    }
  }
  return toJsonValue(raw);
}

export function makeToolCall(input: { id?: string; name: string; arguments: unknown; rawArguments?: string }): ToolCallRequest {
  return {
    id: input.id ?? `call_${input.name}_${Math.random().toString(36).slice(2, 10)}`,
    name: input.name,
    arguments: parseToolArguments(input.arguments, input.name),
    ...(input.rawArguments === undefined ? {} : { rawArguments: input.rawArguments }),
  };
}

/** Ensure a response always has a content block so downstream code can render something. */
export function withFallbackContent(response: ModelResponse): ModelResponse {
  if (response.content.length > 0) return response;
  if (response.toolCalls.length > 0) return response;
  return {
    ...response,
    content: [{ type: 'text', text: '' }],
  };
}

export function providerMetadata(entries: Record<string, unknown>): JsonObject {
  return toJsonValue(entries) as JsonObject;
}

