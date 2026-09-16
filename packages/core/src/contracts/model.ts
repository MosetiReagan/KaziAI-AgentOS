import type { JsonObject, JsonValue } from '../json.js';

/** A single block of model output. Providers normalize into these. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'json'; value: JsonValue }
  | { type: 'refusal'; reason: string }
  | { type: 'reasoning_summary'; summary: string };

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Provenance is mandatory: untrusted content must be distinguishable from instructions. */
  trust: TrustLevel;
  /** Set when the message came from a tool result. */
  toolCallId?: string;
  toolName?: string;
  name?: string;
  metadata?: JsonObject;
}

export type TrustLevel = 'trusted-system' | 'trusted-developer' | 'trusted-policy' | 'user' | 'agent' | 'untrusted-tool' | 'untrusted-external';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema as produced from the tool's Zod schema. */
  parameters: JsonObject;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  /** Ask the provider for a JSON object response when supported. */
  responseFormat?: 'text' | 'json';
  metadata?: JsonObject;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ToolCallRequest {
  id: string;
  /** Namespaced tool id, e.g. `filesystem.read` or `mcp.github.create_issue`. */
  name: string;
  arguments: JsonValue;
  /** Raw text arguments as emitted by the provider, retained for auditing. */
  rawArguments?: string;
}

export interface ModelResponse {
  content: ContentBlock[];
  toolCalls: ToolCallRequest[];
  usage?: TokenUsage;
  finishReason?: string;
  /** Normalized cost in USD when the provider reports it. */
  costUsd?: number;
  /** Which concrete provider/model actually answered (may differ from the request after failover). */
  provider?: string;
  model?: string;
  providerMetadata?: JsonObject;
}

export interface ModelChunk {
  type: 'text_delta' | 'tool_call_delta' | 'usage' | 'done' | 'error';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  argumentsDelta?: string;
  usage?: TokenUsage;
  error?: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly kind: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelChunk>;
  /** Best-effort pricing hook used for accounting. */
  estimateCost?(model: string, usage: TokenUsage): number | undefined;
}

export interface ProviderHealth {
  healthy: boolean;
  checkedAt: number;
  detail?: string;
}

export function textOf(response: ModelResponse): string {
  return response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

