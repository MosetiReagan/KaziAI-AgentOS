# Model providers

The runtime is not coupled to a vendor (spec §11, §12). Providers implement one
interface and return one normalised shape.

```typescript
interface ModelProvider {
  readonly id: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelChunk>;
}

interface ModelResponse {
  content: ContentBlock[];          // text and structured blocks
  toolCalls: ToolCallRequest[];
  usage?: TokenUsage;               // input, output, cached
  finishReason?: string;
  provider?: { id: string; model: string; metadata?: JsonObject };
}
```

`ModelGateway` resolves a chain of `{ provider, model }` targets, records the
attempt count, and reports whether it failed over. It calls `generate` and
normalises the result, so an adapter only has to speak HTTP.

## Adapters

| Provider | Configured by |
| --- | --- |
| `OpenAICompatibleProvider` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| `AnthropicProvider` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| `GeminiProvider` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `OllamaProvider` | `OLLAMA_BASE_URL` or `OLLAMA_HOST` |
| `CustomHttpProvider` | `KAZI_CUSTOM_PROVIDER_URL`, `KAZI_CUSTOM_PROVIDER_TOKEN` |
| `FakeModelProvider` | code, for deterministic tests |

`providersFromEnv()` registers exactly what is configured. A machine with no
credentials gets no providers, and the runtime fails loudly rather than inventing
a model (spec §77).

Anything speaking the OpenAI chat-completions API works through the
`openai-compatible` adapter, including local gateways: point `OPENAI_BASE_URL` at
it.

## Failover

```yaml
providers:
  primary:  { provider: openai-compatible, model: gpt-5.6 }
  fallback: [{ provider: ollama, model: qwen3:32b }]
```

Failover happens only for failures classified as retryable —
`provider_unavailable`, `provider_error`, timeouts and rate limits. An
authentication failure does not silently move to another vendor (spec §38).

Every failover is recorded: `model.failover` events carry the from/to pair, the
run's config gains `fallbackProviders`, and the trace shows the provider that
actually answered each step. A model switch is never invisible.

## Pricing and usage

Providers may declare per-model pricing (`pricingFromEnv`); the runtime estimates
cost from `TokenUsage` and accrues it against the run's `max_cost_usd`. When no
pricing is known the cost is `undefined` — reported as unknown rather than as
zero, because a run that looks free is a budget that does not work.

Usage is also emitted as a `model.usage`-shaped record on every step, which is
the hook an external cost system subscribes to. None is required: the runtime
does its own accounting (spec §60).

## Adding a provider

```typescript
const provider: ModelProvider = {
  id: 'my-gateway',
  async generate(request) {
    const response = await post(request);
    return {
      content: [{ type: 'text', text: response.text }],
      toolCalls: response.tool_calls.map(toToolCall),
      usage: { inputTokens: response.usage.in, outputTokens: response.usage.out },
      finishReason: response.finish_reason,
    };
  },
};

const os = await createAgentOS({ providers: [provider] });
```

Normalise at the edge. Everything downstream — context budgeting, cost, the
trace, the executor — depends on `ModelResponse` having the same shape whatever
answered.
