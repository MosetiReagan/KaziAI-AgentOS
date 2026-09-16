import {
  ProviderError,
  type ModelChunk,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCallRequest,
  type JsonValue,
} from '@kazi-ai/agentos-core';
import { usageOf, withFallbackContent } from './normalize.js';

export interface FakeTurn {
  /** Text the model "says" this turn. */
  text?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  /** Throw a classified error instead of responding. */
  fail?: { code?: string; message?: string; retryable?: boolean; times?: number };
  /** Reported cost of this call, so budget enforcement can be exercised. */
  costUsd?: number;
  /** Artificial latency, useful for cancellation and timeout tests. */
  delayMs?: number;
}

export interface FakeProviderOptions {
  id?: string;
  turns: FakeTurn[];
  /** What to do once the scripted turns are exhausted. */
  onExhausted?: 'repeat-last' | 'empty' | { text: string };
}

/**
 * Deterministic provider used by tests. It exercises the real runtime path —
 * planning, tool dispatch, verification, recovery — without a live model, so
 * core behaviour is testable and reproducible.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id: string;
  readonly kind = 'fake';
  readonly requests: ModelRequest[] = [];
  private cursor = 0;
  private readonly failures = new Map<number, number>();

  constructor(private readonly options: FakeProviderOptions) {
    this.id = options.id ?? 'fake';
  }

  get calls(): number {
    return this.requests.length;
  }

  reset(): void {
    this.cursor = 0;
    this.failures.clear();
    this.requests.length = 0;
  }

  /** Queue an extra scripted turn at runtime. */
  push(turn: FakeTurn): void {
    this.options.turns.push(turn);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const turn = this.peekTurn();
    if (turn.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, turn.delayMs);
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(request.signal?.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    }
    // A turn blocks until its scripted failures are exhausted, so `times: 2`
    // means "fail twice, then answer" regardless of call ordering.
    if (turn.fail && this.consumeFailure(turn)) {
      throw new ProviderError(this.id, turn.fail.message ?? 'simulated provider failure', {
        code: turn.fail.code ?? 'provider.simulated_failure',
        retryable: turn.fail.retryable ?? true,
      });
    }
    this.cursor += 1;
    return this.respond(turn, request);
  }

  /** Returns true when this call should fail. */
  private consumeFailure(turn: FakeTurn): boolean {
    if (!turn.fail) return false;
    const remaining = this.failures.get(this.cursor) ?? turn.fail.times ?? 1;
    if (remaining <= 0) return false;
    this.failures.set(this.cursor, remaining - 1);
    return true;
  }

  private peekTurn(): FakeTurn {
    const turns = this.options.turns;
    if (this.cursor < turns.length) return turns[this.cursor] as FakeTurn;
    const exhausted = this.options.onExhausted ?? 'empty';
    if (exhausted === 'repeat-last' && turns.length > 0) return turns[turns.length - 1] as FakeTurn;
    if (typeof exhausted === 'object') return { text: exhausted.text };
    return { text: '' };
  }

  private respond(turn: FakeTurn, request: ModelRequest): ModelResponse {
    const toolCalls: ToolCallRequest[] = (turn.toolCalls ?? []).map((call, index) => ({
      id: call.id ?? `call_${this.cursor}_${index}`,
      name: call.name,
      arguments: call.arguments as JsonValue,
    }));
    return withFallbackContent({
      content: turn.text === undefined ? [] : [{ type: 'text', text: turn.text }],
      toolCalls,
      usage: usageOf({
        inputTokens: turn.usage?.inputTokens ?? estimateTokens(request),
        outputTokens: turn.usage?.outputTokens ?? estimateTokens({ content: turn.text ?? '' }),
      }),
      finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      provider: this.id,
      model: request.model,
    });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const response = await this.generate(request);
    for (const block of response.content) {
      if (block.type === 'text') {
        for (const word of block.text.split(/(\s+)/)) {
          if (word) yield { type: 'text_delta', text: word };
        }
      }
    }
    for (const call of response.toolCalls) {
      yield {
        type: 'tool_call_delta',
        toolCallId: call.id,
        toolName: call.name,
        argumentsDelta: JSON.stringify(call.arguments),
      };
    }
    if (response.usage) yield { type: 'usage', usage: response.usage };
    yield { type: 'done' };
  }
}

function estimateTokens(input: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(input).length / 4));
}
