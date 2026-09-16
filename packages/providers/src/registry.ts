import {
  ProviderError,
  type CircuitBreaker,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@kazi-ai/agentos-core';
import { DefaultCircuitBreaker } from '@kazi-ai/agentos-core';

export interface ProviderRegistration {
  provider: ModelProvider;
  /** Extra models this provider can serve, with optional pricing hints. */
  models?: string[];
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): void {
    this.providers.delete(id);
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  require(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderError(id, `Provider is not registered: ${id}`, {
        code: 'provider.not_registered',
        retryable: false,
      });
    }
    return provider;
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  describe(): Array<{ id: string; kind: string; supportsStreaming: boolean }> {
    return this.list().map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      supportsStreaming: typeof provider.stream === 'function',
    }));
  }
}

export interface ModelTarget {
  provider: string;
  model: string;
}

export interface FailoverEvent {
  type: 'attempt' | 'failover' | 'success' | 'exhausted' | 'circuit_open';
  provider: string;
  model: string;
  attempt: number;
  reason?: string;
}

export interface ModelGatewayOptions {
  registry: ModelProviderRegistry;
  /** Ordered targets: the first is primary, the rest are fallbacks. */
  chain: ModelTarget[];
  breakers?: Map<string, CircuitBreaker>;
  onEvent?: (event: FailoverEvent) => void;
  failureThreshold?: number;
  openMs?: number;
}

export interface GatewayResult {
  response: ModelResponse;
  attempts: number;
  provider: string;
  model: string;
  /** True when the answer did not come from the primary target. */
  failedOver: boolean;
}

/**
 * Tries providers in order. Failover happens only for errors the provider
 * classified as retryable; anything else propagates so the caller can recover
 * deliberately. Every switch is reported so it appears in the run trace.
 */
export class ModelGateway {
  private readonly breakers: Map<string, CircuitBreaker>;

  constructor(private readonly options: ModelGatewayOptions) {
    this.breakers = options.breakers ?? new Map();
  }

  private breakerFor(target: ModelTarget): CircuitBreaker {
    const key = `${target.provider}:${target.model}`;
    const existing = this.breakers.get(key);
    if (existing) return existing;
    const breaker = new DefaultCircuitBreaker(key, {
      failureThreshold: this.options.failureThreshold ?? 5,
      openMs: this.options.openMs ?? 30_000,
    });
    this.breakers.set(key, breaker);
    return breaker;
  }

  async generate(request: ModelRequest): Promise<GatewayResult> {
    const chain = this.options.chain;
    if (chain.length === 0) {
      throw new ProviderError('gateway', 'No model targets configured', {
        code: 'provider.no_targets',
        retryable: false,
      });
    }
    let lastError: unknown;
    for (let index = 0; index < chain.length; index += 1) {
      const target = chain[index] as ModelTarget;
      const breaker = this.breakerFor(target);
      if (!breaker.isAllowed()) {
        this.options.onEvent?.({
          type: 'circuit_open',
          provider: target.provider,
          model: target.model,
          attempt: index + 1,
        });
        continue;
      }
      const provider = this.options.registry.get(target.provider);
      if (!provider) {
        this.options.onEvent?.({
          type: 'circuit_open',
          provider: target.provider,
          model: target.model,
          attempt: index + 1,
          reason: 'not registered',
        });
        continue;
      }
      this.options.onEvent?.({
        type: index === 0 ? 'attempt' : 'failover',
        provider: target.provider,
        model: target.model,
        attempt: index + 1,
      });
      try {
        const response = await provider.generate({ ...request, model: target.model });
        breaker.recordSuccess();
        this.options.onEvent?.({
          type: 'success',
          provider: target.provider,
          model: response.model ?? target.model,
          attempt: index + 1,
        });
        return {
          response: { ...response, provider: target.provider, model: response.model ?? target.model },
          attempts: index + 1,
          provider: target.provider,
          model: response.model ?? target.model,
          failedOver: index > 0,
        };
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError ? error.retryable : false;
        breaker.recordFailure();
        if (!retryable || index === chain.length - 1) break;
      }
    }
    this.options.onEvent?.({
      type: 'exhausted',
      provider: chain[0]?.provider ?? 'none',
      model: chain[0]?.model ?? 'none',
      attempt: chain.length,
      ...(lastError instanceof Error ? { reason: lastError.message } : {}),
    });
    throw lastError ?? new ProviderError('gateway', 'All model targets failed', { code: 'provider.all_failed' });
  }

  circuitStates(): Array<{ key: string; state: string }> {
    return [...this.breakers.values()].map((breaker) => ({ key: breaker.key, state: breaker.state() }));
  }
}

