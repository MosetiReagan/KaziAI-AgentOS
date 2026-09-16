import {
  ProviderError,
  type JsonValue,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@kazi-ai/agentos-core';
import { httpRequest } from './http.js';
import { providerMetadata, usageOf, withFallbackContent } from './normalize.js';

export interface CustomHttpOptions {
  id: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Map the AgentOS request onto the endpoint's expected payload. */
  buildRequest?: (request: ModelRequest) => JsonValue;
  /** Map the endpoint's response onto the normalized AgentOS response. */
  parseResponse?: (payload: JsonValue, request: ModelRequest) => ModelResponse;
  fetchImpl?: typeof fetch;
}

/**
 * Escape hatch for self-hosted or bespoke endpoints. The default mapping assumes
 * an OpenAI-shaped body so most gateways work without extra code.
 */
export class CustomHttpProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'http';

  constructor(private readonly options: CustomHttpOptions) {
    this.id = options.id;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = this.options.buildRequest
      ? this.options.buildRequest(request)
      : {
          model: request.model,
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          tools: request.tools ?? [],
          temperature: request.temperature,
          max_tokens: request.maxTokens,
        };
    const response = await httpRequest({
      url: this.options.url,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.options.headers ?? {}) },
      body: JSON.stringify(body),
      timeoutMs: request.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      idempotent: true,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    });
    let payload: JsonValue;
    try {
      payload = JSON.parse(response.body) as JsonValue;
    } catch (error) {
      throw new ProviderError(this.id, 'Custom endpoint returned a non-JSON response', {
        code: 'provider.invalid_response',
        retryable: true,
        cause: error,
      });
    }
    if (this.options.parseResponse) {
      const parsed = this.options.parseResponse(payload, request);
      return withFallbackContent({ ...parsed, provider: this.id });
    }
    return withFallbackContent(defaultParse(payload, request, this.id));
  }
}

function defaultParse(payload: JsonValue, request: ModelRequest, providerId: string): ModelResponse {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, JsonValue>;
    const text = typeof record['text'] === 'string' ? record['text'] : undefined;
    const usage = record['usage'];
    if (text !== undefined) {
      return {
        content: [{ type: 'text', text }],
        toolCalls: [],
        ...(usage && typeof usage === 'object' && !Array.isArray(usage)
          ? {
              usage: usageOf({
                inputTokens: numberOr((usage as Record<string, JsonValue>)['inputTokens']),
                outputTokens: numberOr((usage as Record<string, JsonValue>)['outputTokens']),
              }),
            }
          : {}),
        provider: providerId,
        model: request.model,
        providerMetadata: providerMetadata({}),
      };
    }
  }
  throw new ProviderError(providerId, 'Custom endpoint response could not be normalized; provide parseResponse', {
    code: 'provider.unmappable_response',
    retryable: false,
  });
}

function numberOr(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

