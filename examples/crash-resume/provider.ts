/**
 * The deterministic model used by the crash-and-resume example (spec §87).
 *
 * A real model has no cursor: it answers the conversation it is handed. This
 * provider behaves the same way, picking its next turn from the number of tool
 * results already in the request. That is what keeps the example honest — after
 * a restart the worker rebuilds the conversation from durable state, so the
 * model continues from where it stopped instead of starting the task over.
 */
import type { JsonValue, ModelProvider, ModelRequest, ModelResponse } from '@kazi-ai/agentos-core';

export interface ScriptedTurn {
  text?: string;
  delayMs?: number;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export class ContinuationProvider implements ModelProvider {
  readonly kind = 'replay';
  readonly id: string;

  constructor(
    private readonly turns: ScriptedTurn[],
    id = 'replay',
  ) {
    this.id = id;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const done = countToolResults(request);
    const turn = this.turnAt(done);
    if (turn.delayMs !== undefined && turn.delayMs > 0) await pause(turn.delayMs, request.signal);
    const toolCalls = (turn.toolCalls ?? []).map((call, index) => ({
      id: `call_${done}_${index}`,
      name: call.name,
      arguments: call.arguments as JsonValue,
    }));
    return {
      content: [{ type: 'text', text: turn.text ?? '' }],
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      provider: this.id,
      model: request.model,
    };
  }

  private turnAt(index: number): ScriptedTurn {
    const clamped = Math.min(index, this.turns.length - 1);
    return this.turns[clamped] ?? { text: 'Done.' };
  }
}

function countToolResults(request: ModelRequest): number {
  return request.messages.filter((message) => message.role === 'tool').length;
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
}
