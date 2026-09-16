import {
  ValidationError,
  type ChatMessage,
  type ContextSnapshot,
  type JsonObject,
  type JsonValue,
  type Logger,
  type MemoryEntry,
  type Observation,
  type Plan,
  type RunConfigSnapshot,
  type RunUsage,
} from '@kazi-ai/agentos-core';
import { HeuristicTokenEstimator, type TokenEstimator } from './tokens.js';

export interface ContextBudget {
  maxInputTokens: number;
  /** Fraction of the budget at which compression starts. */
  compressAtRatio: number;
  /** How many recent observations are always kept verbatim. */
  keepRecentObservations: number;
  /** Maximum characters retained per tool output before compression. */
  maxObservationChars: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxInputTokens: 24_000,
  compressAtRatio: 0.75,
  keepRecentObservations: 12,
  maxObservationChars: 4_000,
};

export interface Summarizer {
  /** Deterministic or model-backed summary of compressed content. */
  summarize(input: { observations: Observation[]; objective: string }): Promise<string>;
}

/**
 * Deterministic summarizer used by default. It keeps facts (tool, status, size)
 * rather than rewriting them, so nothing important disappears silently.
 */
export class ExtractiveSummarizer implements Summarizer {
  async summarize(input: { observations: Observation[]; objective: string }): Promise<string> {
    const lines = input.observations.map((observation) => {
      const tool = observation.toolId ? `${observation.toolId}: ` : '';
      return `- ${tool}${observation.summary}`;
    });
    return [`Earlier activity (compressed, ${input.observations.length} observations):`, ...lines].join('\n');
  }
}

export interface CompressionRecord {
  at: number;
  reason: string;
  observationsCompressed: number;
  tokensBefore: number;
  tokensAfter: number;
  summary: string;
  /** Identifiers of the retained memory entries, so references never vanish silently. */
  retainedMemoryRefs: string[];
}

export interface BuildContextInput {
  systemPrompt: string;
  goal: string;
  plan?: Plan;
  observations: Observation[];
  memory: MemoryEntry[];
  verification?: { passed: boolean; summary: string };
  /** Additional trusted messages, e.g. policy notices. */
  extraMessages?: ChatMessage[];
  currentStep?: string;
}

export interface BuiltContext {
  messages: ChatMessage[];
  estimatedTokens: number;
  compressed: boolean;
  compression?: CompressionRecord;
}

export interface ContextManagerOptions {
  budget?: Partial<ContextBudget>;
  estimator?: TokenEstimator;
  summarizer?: Summarizer;
  logger?: Logger;
}

/**
 * Assembles the model prompt and keeps it inside the token budget without
 * silently discarding state: anything dropped is replaced by a compression
 * record that is persisted with the run.
 */
export class ContextManager {
  private readonly budget: ContextBudget;
  private readonly estimator: TokenEstimator;
  private readonly summarizer: Summarizer;
  private readonly compressions: CompressionRecord[] = [];

  constructor(private readonly options: ContextManagerOptions = {}) {
    this.budget = { ...DEFAULT_CONTEXT_BUDGET, ...(options.budget ?? {}) };
    this.estimator = options.estimator ?? new HeuristicTokenEstimator();
    this.summarizer = options.summarizer ?? new ExtractiveSummarizer();
  }

  get compressionHistory(): CompressionRecord[] {
    return [...this.compressions];
  }

  estimate(text: string): number {
    return this.estimator.estimate(text);
  }

  async build(input: BuildContextInput): Promise<BuiltContext> {
    if (!input.systemPrompt.trim()) {
      throw new ValidationError('A system prompt is required to build model context');
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: input.systemPrompt, trust: 'trusted-system' },
    ];
    for (const extra of input.extraMessages ?? []) messages.push(extra);
    messages.push({ role: 'user', content: renderObjective(input), trust: 'user' });

    const memoryBlock = renderMemory(input.memory);
    if (memoryBlock) {
      messages.push({ role: 'user', content: memoryBlock, trust: 'user' });
    }

    const observationMessages = this.renderObservations(input.observations);
    messages.push(...observationMessages);

    let estimated = this.estimator.estimateMessages(messages);
    const threshold = this.budget.maxInputTokens * this.budget.compressAtRatio;
    if (estimated <= threshold) {
      return { messages, estimatedTokens: estimated, compressed: false };
    }

    // Compress the oldest observations while preserving recency and any
    // observation that carries verification or recovery outcome.
    const { kept, compressed: dropped } = this.splitObservations(input.observations);
    if (dropped.length === 0) {
      return { messages, estimatedTokens: estimated, compressed: false };
    }
    const summary = await this.summarizer.summarize({ observations: dropped, objective: input.goal });
    const rebuilt: ChatMessage[] = [
      messages[0] as ChatMessage,
      ...(input.extraMessages ?? []),
      { role: 'user', content: renderObjective(input), trust: 'user' },
    ];
    if (memoryBlock) rebuilt.push({ role: 'user', content: memoryBlock, trust: 'user' });
    rebuilt.push({ role: 'user', content: summary, trust: 'agent' });
    rebuilt.push(...this.renderObservations(kept));
    estimated = this.estimator.estimateMessages(rebuilt);

    const record: CompressionRecord = {
      at: Date.now(),
      reason: `context exceeded ${Math.floor(threshold)} tokens`,
      observationsCompressed: dropped.length,
      tokensBefore: this.estimator.estimateMessages(messages),
      tokensAfter: estimated,
      summary,
      retainedMemoryRefs: input.memory.map((entry) => entry.id),
    };
    this.compressions.push(record);
    this.options.logger?.debug('context compressed', {
      compressed: dropped.length,
      tokensBefore: record.tokensBefore,
      tokensAfter: estimated,
    });

    if (estimated > this.budget.maxInputTokens) {
      // Hard ceiling: trim the oldest kept observations' detail, never the goal,
      // plan, memory references, or verification state.
      const trimmed = this.hardTrim(rebuilt);
      estimated = this.estimator.estimateMessages(trimmed);
      return { messages: trimmed, estimatedTokens: estimated, compressed: true, compression: record };
    }
    return { messages: rebuilt, estimatedTokens: estimated, compressed: true, compression: record };
  }

  private splitObservations(observations: Observation[]): { kept: Observation[]; compressed: Observation[] } {
    const keep = this.budget.keepRecentObservations;
    if (observations.length <= keep) return { kept: observations, compressed: [] };
    const boundary = observations.length - keep;
    const older = observations.slice(0, boundary);
    const newer = observations.slice(boundary);
    // Observations recording verification or recovery are never compressed away.
    const mustKeep = older.filter((observation) => observation.source === 'verification' || observation.source === 'recovery');
    const droppable = older.filter((observation) => !mustKeep.includes(observation));
    return { kept: [...mustKeep, ...newer], compressed: droppable };
  }

  private renderObservations(observations: Observation[]): ChatMessage[] {
    return observations.map((observation) => ({
      role: 'tool' as const,
      content: truncate(observation.detail === undefined ? observation.summary : `${observation.summary}\n${safeStringify(observation.detail)}`, this.budget.maxObservationChars),
      // Tool output is never trusted as an instruction.
      trust: observation.trust === 'trusted-system' ? ('trusted-system' as const) : ('untrusted-tool' as const),
      ...(observation.toolId ? { toolName: observation.toolId } : {}),
      metadata: { observationId: observation.id, source: observation.source },
    }));
  }

  private hardTrim(messages: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const message of messages) {
      if (message.trust === 'trusted-system' || message.trust === 'trusted-policy') {
        out.push(message);
        continue;
      }
      if (message.role === 'tool') {
        out.push({ ...message, content: truncate(message.content, 600) });
        continue;
      }
      out.push({ ...message, content: truncate(message.content, 8_000) });
    }
    return out;
  }

  /** Build the snapshot persisted with every checkpoint. */
  snapshot(input: {
    objective: string;
    plan?: Plan;
    observations: Observation[];
    verification?: { passed: boolean; summary: string };
    memoryRefs?: string[];
  }): ContextSnapshot {
    return {
      objective: input.objective,
      ...(input.plan ? { plan: input.plan } : {}),
      completedSteps: (input.plan?.steps ?? []).filter((step) => step.status === 'completed').map((step) => step.id),
      pendingSteps: (input.plan?.steps ?? []).filter((step) => step.status === 'pending').map((step) => step.id),
      observations: input.observations.slice(-this.budget.keepRecentObservations),
      memoryRefs: input.memoryRefs ?? [],
      ...(input.verification ? { verification: { ...input.verification, at: Date.now() } } : {}),
    };
  }

  usageSnapshot(usage: RunUsage): JsonObject {
    return {
      steps: usage.steps,
      toolCalls: usage.toolCalls,
      tokens: usage.tokens.totalTokens,
      costUsd: usage.costUsd,
      recoveryCount: usage.recoveryCount,
      checkpointCount: usage.checkpointCount,
    };
  }

  configSnapshot(config: RunConfigSnapshot): JsonObject {
    return JSON.parse(JSON.stringify(config)) as JsonObject;
  }
}

function renderObjective(input: BuildContextInput): string {
  const lines = [`Objective: ${input.goal}`];
  if (input.currentStep) lines.push(`Current step: ${input.currentStep}`);
  if (input.plan) {
    lines.push(`Plan (version ${input.plan.version}):`);
    for (const step of input.plan.steps) {
      lines.push(`  [${step.status}] ${step.index + 1}. ${step.description}${step.toolId ? ` (tool: ${step.toolId})` : ''}`);
    }
  }
  if (input.verification) {
    lines.push(`Verification: ${input.verification.passed ? 'passed' : 'failed'} — ${input.verification.summary}`);
  }
  return lines.join('\n');
}

function renderMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = ['Relevant memory (may be stale; verify before relying on it):'];
  for (const entry of entries) {
    lines.push(`- [${entry.type}, confidence ${entry.confidence.toFixed(2)}] ${entry.content}`);
  }
  return lines.join('\n');
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`;
}

function safeStringify(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

