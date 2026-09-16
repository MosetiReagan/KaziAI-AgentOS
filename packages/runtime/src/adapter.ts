import {
  type ModelChunk,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type TokenUsage,
} from '@kazi-ai/agentos-core';
import type { ModelGatewayLike } from './model-step.js';

export interface GatewayProviderOptions {
  gateway: ModelGatewayLike;
  id?: string;
  /** Model to use when a caller does not pin one. */
  defaultModel?: string;
  estimateCost?(model: string, usage: TokenUsage): number | undefined;
}

/**
 * Presents the failover gateway as a single `ModelProvider`, so components that
 * need a provider (the LLM planner) still benefit from failover, circuit
 * breakers and provider accounting.
 */
export class GatewayProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'gateway';

  constructor(private readonly options: GatewayProviderOptions) {
    this.id = options.id ?? 'gateway';
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const result = await this.options.gateway.generate({
      ...request,
      model: request.model || this.options.defaultModel || 'default',
    });
    return { ...result.response, provider: result.provider, model: result.model };
  }

  stream?(request: ModelRequest): AsyncIterable<ModelChunk>;

  estimateCost(model: string, usage: TokenUsage): number | undefined {
    return this.options.estimateCost?.(model, usage);
  }
}
