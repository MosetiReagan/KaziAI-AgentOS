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
import { encodeToolName, decodeToolName } from './tool-names.js';

export interface AnthropicOptions {
  id?: string;
  baseUrl?: string;
  apiKey: string;
  version?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'anthropic';

  constructor(private readonly options: AnthropicOptions) {
    this.id = options.id ?? 'anthropic';
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const body = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4_096,
      messages,
      ...(system ? { system } : {}),
      ...(request.tools && request.tools.length > 0 ? { tools: toAnthropicTools(request.tools) } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.stop ? { stop_sequences: request.stop } : {}),
    };
    const response = await httpRequest({
      url: joinUrl(this.options.baseUrl ?? 'https://api.anthropic.com', '/v1/messages'),
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': this.options.version ?? '2023-06-01',
      },
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
      throw new ProviderError(this.id, 'Anthropic returned a non-JSON response', {
        code: 'provider.invalid_response',
        retryable: true,
        cause: error,
      });
    }

    const blocks = Array.isArray(payload['content']) ? (payload['content'] as Array<Record<string, unknown>>) : [];
    const content: ModelResponse['content'] = [];
    const toolCalls: ToolCallRequest[] = [];
    for (const block of blocks) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        content.push({ type: 'text', text: block['text'] });
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        toolCalls.push(
          makeToolCall({
            id: typeof block['id'] === 'string' ? block['id'] : undefined,
            name: decodeToolName(block['name']),
            arguments: block['input'],
          }),
        );
      } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
        // Never surface raw chain-of-thought; only a summary is retained.
        content.push({ type: 'reasoning_summary', summary: 'provider reported internal reasoning (not stored)' });
      }
    }

    const usage = payload['usage'] as Record<string, unknown> | undefined;
    return withFallbackContent({
      content,
      toolCalls,
      ...(usage
        ? {
            usage: usageOf({
              inputTokens: numberOr(usage['input_tokens']),
              outputTokens: numberOr(usage['output_tokens']),
              cachedInputTokens: numberOr(usage['cache_read_input_tokens']),
            }),
          }
        : {}),
      ...(typeof payload['stop_reason'] === 'string' ? { finishReason: payload['stop_reason'] } : {}),
      provider: this.id,
      model: typeof payload['model'] === 'string' ? payload['model'] : request.model,
      providerMetadata: providerMetadata({ id: payload['id'] }),
    });
  }
}

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: encodeToolName(tool.name),
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** Anthropic keeps system prompts out of the message list and merges consecutive roles. */
export function toAnthropicMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      systemParts.push(labelContent(message));
      continue;
    }
    if (message.role === 'tool') {
      const text = labelContent(message);
      const last = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: message.toolCallId ?? 'unknown', content: text };
      if (last && last.role === 'user') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.role === 'assistant' && message.toolName) {
      const block = {
        type: 'tool_use',
        id: message.toolCallId ?? 'unknown',
        name: encodeToolName(message.toolName),
        input: message.metadata?.['arguments'] ?? {},
      };
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') last.content.push(block);
      else out.push({ role: 'assistant', content: [block] });
      continue;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const block = { type: 'text', text: labelContent(message) };
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  }
  return { ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}), messages: out };
}

