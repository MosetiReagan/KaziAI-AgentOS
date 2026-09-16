import type { ModelProvider } from '@kazi-ai/agentos-core';
import {
  AnthropicProvider,
  CustomHttpProvider,
  GeminiProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
} from '@kazi-ai/agentos-providers';

export interface ProviderEnvOptions {
  env?: Record<string, string | undefined>;
}

/**
 * Build providers from the environment (spec §77).
 *
 * Nothing is registered unless it is configured: a machine with only
 * `OPENAI_API_KEY` gets exactly one provider, and a machine with nothing gets
 * none — the runtime then fails loudly rather than inventing a model.
 */
export function providersFromEnv(options: ProviderEnvOptions = {}): ModelProvider[] {
  const env = options.env ?? process.env;
  const providers: ModelProvider[] = [];

  const openaiKey = env['OPENAI_API_KEY'];
  const openaiBaseUrl = env['OPENAI_BASE_URL'];
  if (openaiKey || openaiBaseUrl) {
    providers.push(
      new OpenAICompatibleProvider({
        id: env['KAZI_OPENAI_ID'] ?? 'openai',
        baseUrl: openaiBaseUrl ?? 'https://api.openai.com/v1',
        ...(openaiKey ? { apiKey: openaiKey } : {}),
        ...(env['OPENAI_MODEL'] ? { defaultModel: env['OPENAI_MODEL'] } : {}),
        ...(pricingFromEnv(env, 'OPENAI') ?? {}),
      }),
    );
  }

  const anthropicKey = env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    providers.push(
      new AnthropicProvider({
        id: 'anthropic',
        apiKey: anthropicKey,
        ...(env['ANTHROPIC_BASE_URL'] ? { baseUrl: env['ANTHROPIC_BASE_URL'] } : {}),
      }),
    );
  }

  const geminiKey = env['GEMINI_API_KEY'] ?? env['GOOGLE_API_KEY'];
  if (geminiKey) {
    providers.push(
      new GeminiProvider({
        id: 'gemini',
        apiKey: geminiKey,
        ...(env['GEMINI_BASE_URL'] ? { baseUrl: env['GEMINI_BASE_URL'] } : {}),
      }),
    );
  }

  const ollamaBaseUrl = env['OLLAMA_BASE_URL'] ?? env['OLLAMA_HOST'];
  if (ollamaBaseUrl && ollamaBaseUrl !== '0') {
    providers.push(
      new OllamaProvider({ id: 'ollama', baseUrl: normalizeOllamaUrl(ollamaBaseUrl) }),
    );
  }

  const customUrl = env['KAZI_CUSTOM_PROVIDER_URL'];
  if (customUrl) {
    providers.push(
      new CustomHttpProvider({
        id: env['KAZI_CUSTOM_PROVIDER_ID'] ?? 'custom',
        url: customUrl,
        ...(env['KAZI_CUSTOM_PROVIDER_TOKEN']
          ? { headers: { authorization: `Bearer ${env['KAZI_CUSTOM_PROVIDER_TOKEN']}` } }
          : {}),
      }),
    );
  }

  return providers;
}

function normalizeOllamaUrl(value: string): string {
  return value.startsWith('http://') || value.startsWith('https://') ? value : `http://${value}`;
}

function pricingFromEnv(
  env: Record<string, string | undefined>,
  prefix: string,
): { pricing: { inputPerMillion: number; outputPerMillion: number } } | undefined {
  const input = Number(env[`KAZI_${prefix}_INPUT_PRICE`]);
  const output = Number(env[`KAZI_${prefix}_OUTPUT_PRICE`]);
  if (!Number.isFinite(input) || !Number.isFinite(output) || (input === 0 && output === 0))
    return undefined;
  return { pricing: { inputPerMillion: input, outputPerMillion: output } };
}
