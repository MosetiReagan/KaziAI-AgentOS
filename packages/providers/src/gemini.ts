import {
  ProviderError,
  type ChatMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from '@kazi-ai/agentos-core';
import { httpRequest, joinUrl } from './http.js';
import { labelContent } from './messages.js';
import { makeToolCall, providerMetadata, usageOf, withFallbackContent } from './normalize.js';
import { decodeToolName, encodeToolName } from './tool-names.js';

export interface GeminiOptions {
  id?: string;
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'gemini';

  constructor(private readonly options: GeminiOptions) {
    this.id = options.id ?? 'gemini';
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const base = this.options.baseUrl ?? 'https://generativelanguage.googleapis.com';
    const url = `${joinUrl(base, `/v1beta/models/${request.model}:generateContent`)}?key=${encodeURIComponent(this.options.apiKey)}`;
    const body = {
      contents: toGeminiContents(request.messages),
      ...(request.tools && request.tools.length > 0
        ? { tools: [{ functionDeclarations: toGeminiTools(request.tools) }] }
        : {}),
      ...(request.temperature === undefined ? {} : { generationConfig: { temperature: request.temperature } }),
    };
    const response = await httpRequest({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      idempotent: true,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(response.body) as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(this.id, 'Gemini returned a non-JSON response', {
        code: 'provider.invalid_response',
        retryable: true,
        cause: error,
      });
    }

    const candidates = Array.isArray(payload['candidates']) ? (payload['candidates'] as Array<Record<string, unknown>>) : [];
    const candidate = candidates[0];
    if (!candidate) {
      throw new ProviderError(this.id, 'Gemini returned no candidates', {
        code: 'provider.empty_response',
        retryable: true,
      });
    }
    const contentNode = (candidate['content'] ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(contentNode['parts']) ? (contentNode['parts'] as Array<Record<string, unknown>>) : [];
    const content: ModelResponse['content'] = [];
    const toolCalls: ToolCallRequest[] = [];
    for (const part of parts) {
      if (typeof part['text'] === 'string') content.push({ type: 'text', text: part['text'] });
      const fn = part['functionCall'] as Record<string, unknown> | undefined;
      if (fn && typeof fn['name'] === 'string') {
        toolCalls.push(makeToolCall({ name: decodeToolName(fn['name']), arguments: fn['args'] }));
      }
    }
    const usage = payload['usageMetadata'] as Record<string, unknown> | undefined;
    return withFallbackContent({
      content,
      toolCalls,
      ...(usage
        ? {
            usage: usageOf({
              inputTokens: numberOr(usage['promptTokenCount']),
              outputTokens: numberOr(usage['candidatesTokenCount']),
              totalTokens: numberOr(usage['totalTokenCount']),
            }),
          }
        : {}),
      ...(typeof candidate['finishReason'] === 'string' ? { finishReason: candidate['finishReason'] } : {}),
      provider: this.id,
      model: request.model,
      providerMetadata: providerMetadata({}),
    });
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toGeminiTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: encodeToolName(tool.name),
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];
    if (message.role === 'tool') {
      parts.push({ functionResponse: { name: encodeToolName(message.toolName ?? 'tool'), response: { content: labelContent(message) } } });
    } else if (message.role === 'assistant' && message.toolName) {
      parts.push({ functionCall: { name: encodeToolName(message.toolName), args: message.metadata?.['arguments'] ?? {} } });
    } else {
      parts.push({ text: labelContent(message) });
    }
    const last = out[out.length - 1];
    if (last && last['role'] === role) (last['parts'] as Array<Record<string, unknown>>).push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

