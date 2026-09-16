import type { ChatMessage } from '@kazi-ai/agentos-core';

export interface TokenEstimator {
  estimate(text: string): number;
  estimateMessages(messages: ChatMessage[]): number;
}

/**
 * Cheap, provider-independent estimate (~4 characters per token). It only has
 * to be good enough to keep the prompt under a budget we already control, and
 * it must never require a network call.
 */
export class HeuristicTokenEstimator implements TokenEstimator {
  constructor(private readonly charsPerToken = 4) {}

  estimate(text: string): number {
    if (text.length === 0) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }

  estimateMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimate(message.content) + 4;
      if (message.metadata) total += this.estimate(JSON.stringify(message.metadata));
    }
    return total;
  }
}

