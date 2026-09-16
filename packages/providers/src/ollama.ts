import {
  ProviderError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from '@kazi-ai/agentos-core';
import { httpRequest, joinUrl } from './http.js';
import { decodeToolName, encodeToolName } from './tool-names.js';
import { makeToolCall, providerMetadata, usageOf, withFallbackContent } from './normalize.js';
import { toOpenAIMessages } from './openai-compatible.js';

export interface OllamaOptions {
  id?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'ollama';

  constructor(private readonly options: OllamaOptions = {}) {
    this.id = options.id ?? 'ollama';
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: request.model,
      messages: toOllamaMessages(request.messages),
      stream: false,
      ...(request.tools && request.tools.length > 0 ? { tools: toOllamaTools(request.tools) } : {}),
      ...(request.temperature === undefined && !request.maxTokens
        ? {}
        : {
            options: {
              ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
              ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
            },
          }),
    };
    const response = await httpRequest({
      url: joinUrl(this.options.baseUrl ?? 'http://127.0.0.1:11434', '/api/chat'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs ?? 300_000,
      idempotent: true,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(response.body) as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(this.id, 'Ollama returned a non-JSON response', {
        code: 'provider.invalid_response',
        retryable: true,
        cause: error,
      });
    }
    const message = (payload['message'] ?? {}) as Record<string, unknown>;
    const text = typeof message['content'] === 'string' ? message['content'] : '';
    const rawCalls = Array.isArray(message['tool_calls']) ? (message['tool_calls'] as Array<Record<string, unknown>>) : [];
    const toolCalls: ToolCallRequest[] = [];
    for (const call of rawCalls) {
      const fn = (call['function'] ?? {}) as Record<string, unknown>;
      if (typeof fn['name'] !== 'string') continue;
      toolCalls.push(makeToolCall({ name: decodeToolName(fn['name']), arguments: fn['arguments'] }));
    }
    return withFallbackContent({
      content: text.length > 0 ? [{ type: 'text', text }] : [],
      toolCalls,
      usage: usageOf({
        inputTokens: numberOr(payload['prompt_eval_count']),
        outputTokens: numberOr(payload['eval_count']),
      }),
      ...(typeof payload['done_reason'] === 'string' ? { finishReason: payload['done_reason'] } : {}),
      provider: this.id,
      model: typeof payload['model'] === 'string' ? payload['model'] : request.model,
      providerMetadata: providerMetadata({}),
    });
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toOllamaTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: encodeToolName(tool.name), description: tool.description, parameters: tool.parameters },
  }));
}

function toOllamaMessages(messages: ModelRequest['messages']): Array<Record<string, unknown>> {
  return toOpenAIMessages(messages).map((message) => ({
    role: message.role,
    content: message.content ?? '',
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));
}

