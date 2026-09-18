import {
  ProviderError,
  ToolNotFoundError,
  emptyUsage,
  textOf,
  type AgentAction,
  type AgentRun,
  type AgentState,
  type JsonObject,
  type MemoryEntry,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type Observation,
  type Plan,
  type ToolDefinition,
  type TokenUsage,
} from '@kazi-ai/agentos-core';
import type { ContextManager } from '@kazi-ai/agentos-context';
import type { MemoryManager } from '@kazi-ai/agentos-memory';
import type { ToolRegistry } from '@kazi-ai/agentos-tools';
import { actionFromToolCall } from './support.js';

/** Narrow port the runtime needs from a model gateway; `ModelGateway` satisfies it. */
export interface ModelGatewayLike {
  generate(request: ModelRequest): Promise<{
    response: ModelResponse;
    attempts: number;
    provider: string;
    model: string;
    failedOver: boolean;
  }>;
}

export interface ModelStepInput {
  run: AgentRun;
  state: AgentState;
  systemPrompt: string;
  tools: ToolDefinition[];
  stepId?: string;
  stepIndex: number;
  attempt: number;
  signal: AbortSignal;
  timeoutMs?: number;
  verification?: { passed: boolean; summary: string };
}

export interface ModelStepResult {
  actions: AgentAction[];
  text: string;
  /** The model produced no tool calls, so it believes the work is done. */
  finished: boolean;
  usage: TokenUsage;
  costUsd: number;
  durationMs: number;
  provider: string;
  model: string;
  attempts: number;
  failedOver: boolean;
  compressedContext: boolean;
  estimatedTokens: number;
  toolCallsRequested: number;
  /** Structured reflection metadata extracted from the response, if any. */
  reflection?: JsonObject;
}

export interface ModelStepOptions {
  gateway: ModelGatewayLike;
  registry: ToolRegistry;
  context: ContextManager;
  memory?: MemoryManager;
  /** Pricing hook, resolved from the provider registry by the runtime. */
  estimateCost?(model: string, usage: TokenUsage): number | undefined;
  now?: () => number;
  /** Cap on tool calls honoured from a single model response. */
  maxToolCallsPerStep?: number;
}

/**
 * The "determine next action" phase of the execution loop: assemble context,
 * ask the model, and translate its tool calls into actions the executor can
 * authorize and run. The model never executes anything directly.
 */
export class ModelStep {
  constructor(private readonly options: ModelStepOptions) {}

  async run(input: ModelStepInput): Promise<ModelStepResult> {
    const started = this.now();
    const memory = await this.recallMemory(input);
    const built = await this.options.context.build({
      systemPrompt: input.systemPrompt,
      goal: input.run.goal,
      ...(input.state.plan ? { plan: input.state.plan } : {}),
      observations: input.state.observations,
      memory,
      ...(input.verification ? { verification: input.verification } : {}),
      ...(input.stepId ? { currentStep: input.stepId } : {}),
    });

    const response = await this.options.gateway.generate({
      model: input.run.config.model,
      messages: built.messages,
      tools: input.tools,
      toolChoice: input.tools.length > 0 ? 'auto' : 'none',
      metadata: {
        runId: input.run.id,
        agentId: input.run.agentId,
        step: input.stepIndex,
      },
      signal: input.signal,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });

    const usage = response.response.usage ?? emptyUsage().tokens;
    const costUsd = response.response.costUsd ?? this.options.estimateCost?.(response.model, usage) ?? 0;
    const requested = response.response.toolCalls ?? [];
    const limited = requested.slice(0, this.options.maxToolCallsPerStep ?? 8);
    const actions = limited.map((toolCall) => {
      const tool = this.options.registry.get(toolCall.name) ?? this.options.registry.get(decode(toolCall.name));
      if (!tool) {
        // The tool list is authoritative: a model asking for something it was
        // never given is a protocol error that recovery must classify, not a
        // request the runtime quietly drops.
        throw new ToolNotFoundError(toolCall.name);
      }
      return actionFromToolCall({
        run: input.run,
        toolCall,
        tool: {
          id: tool.id,
          ...(tool.defaultIdempotency ? { defaultIdempotency: tool.defaultIdempotency } : {}),
          ...(tool.sandbox ? { sandbox: tool.sandbox } : {}),
        },
        ...(input.stepId ? { stepId: input.stepId } : {}),
        stepIndex: input.stepIndex,
        attempt: input.attempt,
      });
    });

    const text = textOf(response.response);
    const reflection = extractReflection(response.response);
    return {
      actions,
      text,
      finished: actions.length === 0,
      usage,
      costUsd,
      durationMs: this.now() - started,
      provider: response.provider,
      model: response.model,
      attempts: response.attempts,
      failedOver: response.failedOver,
      compressedContext: built.compressed,
      estimatedTokens: built.estimatedTokens,
      toolCallsRequested: requested.length,
      ...(reflection ? { reflection } : {}),
    };
  }

  private async recallMemory(input: ModelStepInput): Promise<MemoryEntry[]> {
    if (!this.options.memory || !input.run.config.memoryEnabled) return [];
    try {
      return await this.options.memory.recallScoped({
        scope: {
          organizationId: input.run.organizationId,
          projectId: input.run.projectId,
          ...(input.run.config.memoryEnabled ? { runId: input.run.id } : {}),
        },
        text: input.run.goal,
        limit: 8,
        fallbackToBroaderScopes: true,
      });
    } catch {
      // Memory is an optimisation, never a correctness requirement.
      return [];
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function decode(name: string): string {
  return name.split('__').join('.');
}

/**
 * Structured reflection is operational metadata, never private reasoning:
 * the model may report status, the issue it observed, the next action it
 * intends and its confidence (spec §40).
 */
export function extractReflection(response: ModelResponse): JsonObject | undefined {
  const value = response.providerMetadata?.['reflection'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const reflection: JsonObject = {};
  for (const key of ['status', 'observed_issue', 'next_action']) {
    const entry = record[key];
    if (typeof entry === 'string') reflection[key] = entry;
  }
  const confidence = record['confidence'];
  if (typeof confidence === 'number') reflection['confidence'] = Math.min(1, Math.max(0, confidence));
  return Object.keys(reflection).length === 0 ? undefined : reflection;
}

export type { Plan, Observation, ProviderError, ModelProvider };
