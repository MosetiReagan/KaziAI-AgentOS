import {
  ProviderError,
  toJsonValue,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from '@kazi-ai/agentos-core';
import { httpRequest, joinUrl } from './http.js';
import { decodeToolName, encodeToolName } from './tool-names.js';
import { labelContent } from './messages.js';
import { makeToolCall, providerMetadata, usageOf, withFallbackContent } from './normalize.js';

export interface OpenAICompatibleOptions {
  id?: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Optional per-million-token pricing used for local accounting. */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  fetchImpl?: typeof fetch;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Works with OpenAI and any OpenAI-compatible endpoint (vLLM, Groq, llama.cpp, ...). */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'openai-compatible';

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id ?? 'openai-compatible';
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...(this.options.headers ?? {}),
    };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: request.model || this.options.defaultModel,
      messages: toOpenAIMessages(request.messages),
      ...(request.tools && request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
      ...(request.toolChoice ? { tool_choice: toOpenAIToolChoice(request.toolChoice) } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.stop ? { stop: request.stop } : {}),
      ...(request.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {}),
    };

    const response = await httpRequest({
      url: joinUrl(this.options.baseUrl, '/chat/completions'),
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      // Model calls are not safely retryable when tools may have side effects,
      // but the HTTP layer only retries on transport and 429/5xx.
      idempotent: true,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(response.body) as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(this.id, 'Provider returned a non-JSON response', {
        code: 'provider.invalid_response',
        retryable: true,
        details: { preview: response.body.slice(0, 300) },
        cause: error,
      });
    }

    const choices = payload['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new ProviderError(this.id, 'Provider returned no choices', {
        code: 'provider.empty_response',
        retryable: true,
        details: { payload: toJsonValue(payload) as never },
      });
    }
    const choice = choices[0] as Record<string, unknown>;
    const message = (choice['message'] ?? {}) as Record<string, unknown>;
    const content = typeof message['content'] === 'string' ? message['content'] : '';
    const toolCalls = parseToolCalls(message['tool_calls']);
    const usage = payload['usage'] as Record<string, unknown> | undefined;

    return withFallbackContent({
      content: content.length > 0 ? [{ type: 'text', text: content }] : [],
      toolCalls,
      ...(usage
        ? {
            usage: usageOf({
              inputTokens: numberOr(usage['prompt_tokens']),
              outputTokens: numberOr(usage['completion_tokens']),
              cachedInputTokens: numberOr((usage['prompt_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens']),
              reasoningTokens: numberOr((usage['completion_tokens_details'] as Record<string, unknown> | undefined)?.['reasoning_tokens']),
              totalTokens: numberOr(usage['total_tokens']),
            }),
          }
        : {}),
      ...(typeof choice['finish_reason'] === 'string' ? { finishReason: choice['finish_reason'] } : {}),
      provider: this.id,
      model: typeof payload['model'] === 'string' ? payload['model'] : request.model,
      providerMetadata: providerMetadata({ id: payload['id'] }),
    });
  }

  estimateCost(model: string, usage: { inputTokens: number; outputTokens: number }): number | undefined {
    void model;
    if (!this.options.pricing) return undefined;
    return (
      (usage.inputTokens / 1_000_000) * this.options.pricing.inputPerMillion +
      (usage.outputTokens / 1_000_000) * this.options.pricing.outputPerMillion
    );
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function toOpenAITools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: encodeToolName(tool.name),
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function toOpenAIToolChoice(choice: NonNullable<ModelRequest['toolChoice']>): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: encodeToolName(choice.name) } };
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        content: labelContent(message),
        tool_call_id: message.toolCallId ?? 'unknown',
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolName) {
      out.push({
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: [
          {
            id: message.toolCallId ?? 'unknown',
            type: 'function',
            function: { name: encodeToolName(message.toolName), arguments: message.metadata?.['arguments'] ? JSON.stringify(message.metadata['arguments']) : '{}' },
          },
        ],
      });
      continue;
    }
    const role = message.role === 'developer' ? 'system' : message.role;
    out.push({ role: role as OpenAIMessage['role'], content: labelContent(message) });
  }
  return out;
}

export function parseToolCalls(raw: unknown): ToolCallRequest[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallRequest[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const call = item as Record<string, unknown>;
    const fn = (call['function'] ?? {}) as Record<string, unknown>;
    const name = typeof fn['name'] === 'string' ? fn['name'] : undefined;
    if (!name) continue;
    const rawArguments = typeof fn['arguments'] === 'string' ? fn['arguments'] : undefined;
    out.push(
      makeToolCall({
        id: typeof call['id'] === 'string' ? call['id'] : undefined,
        name: decodeToolName(name),
        arguments: rawArguments ?? fn['arguments'],
        ...(rawArguments === undefined ? {} : { rawArguments }),
      }),
    );
  }
  return out;
}

