import {
  AgentError,
  ProviderError,
  ToolExecutionError,
  ToolTimeoutError,
  toJsonValue,
  type AgentRun,
  type AgentTool,
  type JsonValue,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunLimits,
  type ToolResult,
} from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';

/**
 * Deterministic fault injection for the chaos suite (spec §88).
 *
 * The runtime is supposed to stay *consistent* under failure, not to pretend
 * failures do not happen. This injector tears the dependencies the runtime
 * talks to — tools, the model provider, the durable store — and records exactly
 * what it broke so a test can assert the run either completed anyway or stopped
 * cleanly with the reason persisted.
 *
 * Every decision comes from a seeded generator, so a failing seed reproduces.
 */

export type ChaosFaultKind =
  | 'tool_timeout'
  | 'tool_error'
  | 'network_error'
  | 'invalid_tool_output'
  | 'provider_timeout'
  | 'provider_error'
  | 'invalid_provider_output'
  | 'store_failure';

export interface ChaosFaultSpec {
  kind: ChaosFaultKind;
  /** Restrict the fault to one tool id. */
  toolId?: string;
  /** How many calls it affects before the dependency recovers. Default 1. */
  times?: number;
  /** Which store surface a `store_failure` hits. Default `events`. */
  surface?: StoreSurface;
}

export type StoreSurface =
  | 'runs'
  | 'events'
  | 'steps'
  | 'actions'
  | 'checkpoints'
  | 'states'
  | 'memory'
  | 'approvals'
  | 'artifacts'
  | 'usage'
  | 'counters'
  | 'failures'
  | 'recoveries'
  | 'invocations'
  | 'policyDecisions';

export interface ChaosOptions {
  /** Anything not supplied is off. */
  faults?: ChaosFaultSpec[];
  /** Probability [0,1] that a candidate fault fires at an opportunity. Default 1. */
  rate?: number;
  seed?: number;
  now?: () => number;
}

export interface ChaosRecord {
  kind: ChaosFaultKind;
  target: string;
  at: number;
  detail: Record<string, JsonValue>;
}

/** mulberry32: small, fast, and the same sequence for the same seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOL_KINDS = new Set<ChaosFaultKind>([
  'tool_timeout',
  'tool_error',
  'network_error',
  'invalid_tool_output',
]);
const PROVIDER_KINDS = new Set<ChaosFaultKind>([
  'provider_timeout',
  'provider_error',
  'invalid_provider_output',
]);

export class Chaos {
  readonly records: ChaosRecord[] = [];
  private readonly rng: () => number;
  private readonly rate: number;
  private readonly now: () => number;
  private readonly remaining = new Map<ChaosFaultSpec, number>();

  constructor(private readonly options: ChaosOptions = {}) {
    this.rng = seeded(options.seed ?? 1);
    this.rate = options.rate ?? 1;
    this.now = options.now ?? (() => Date.now());
    for (const fault of options.faults ?? []) this.remaining.set(fault, fault.times ?? 1);
  }

  /** Faults that actually fired, in order. */
  get fired(): ChaosRecord[] {
    return [...this.records];
  }

  firedOf(kind: ChaosFaultKind): ChaosRecord[] {
    return this.records.filter((record) => record.kind === kind);
  }

  /** Wrap a tool so the injector can time it out, break it or corrupt it. */
  tool<T extends AgentTool>(tool: T): T {
    const chaos = this;
    return {
      ...tool,
      // A shorter declared timeout is what turns `tool_timeout` into a real
      // abort rather than a test that hangs.
      timeoutMs: Math.min(tool.timeoutMs ?? 5_000, 400),
      async execute(input: never, context): Promise<ToolResult> {
        const fault = chaos.take(TOOL_KINDS, tool.id);
        if (!fault) return tool.execute(input, context);
        switch (fault.kind) {
          case 'tool_timeout':
            return chaos.hang(context.signal, tool.id) as Promise<ToolResult>;
          case 'tool_error':
            throw new ToolExecutionError(tool.id, 'injected tool failure', {
              code: 'tool.execution_failed',
              retryable: true,
              idempotency: 'retry-safe',
              cause: new Error('injected'),
            });
          case 'network_error':
            throw new ToolExecutionError(tool.id, 'injected ECONNREFUSED', {
              code: 'tool.execution_failed',
              retryable: true,
              idempotency: 'idempotent',
              cause: new Error('connect ECONNREFUSED 127.0.0.1:9'),
            });
          case 'invalid_tool_output':
            // A buggy (or hostile) tool returning something that is not JSON.
            // The trust boundary has to contain this (spec §105).
            return {
              success: true,
              output: { total: 7n } as unknown as JsonValue,
            };
          default:
            return tool.execute(input, context);
        }
      },
    } as T;
  }

  /** Wrap a provider so the injector can time it out, break it or corrupt it. */
  provider(provider: ModelProvider): ModelProvider {
    const chaos = this;
    const wrapper: ModelProvider = {
      id: provider.id,
      kind: provider.kind,
      async generate(request: ModelRequest): Promise<ModelResponse> {
        const fault = chaos.take(PROVIDER_KINDS, provider.id);
        if (!fault) return provider.generate(request);
        switch (fault.kind) {
          case 'provider_timeout':
            throw new ProviderError(provider.id, 'injected provider timeout', {
              code: 'provider.timeout',
              retryable: true,
            });
          case 'provider_error':
            throw new ProviderError(provider.id, 'injected provider failure', {
              code: 'provider.error',
              retryable: true,
            });
          case 'invalid_provider_output':
            // A provider that answers with a tool call whose arguments are not
            // an object. The runtime must reject it, not pass it to a tool.
            return {
              content: [{ type: 'text', text: '' }],
              toolCalls: [
                {
                  id: 'call_corrupt',
                  name: 'filesystem.write',
                  arguments: 'not-an-object' as unknown as Record<string, JsonValue>,
                },
              ],
            };
          default:
            return provider.generate(request);
        }
      },
    };
    if (provider.stream) wrapper.stream = (request) => provider.stream!(request);
    if (provider.estimateCost) wrapper.estimateCost = (model, usage) => provider.estimateCost!(model, usage);
    return wrapper;
  }

  /**
   * Wrap a store so individual surfaces fail the way an unavailable database
   * does: the call rejects, it does not silently return stale data.
   */
  store(store: AgentOSStore): AgentOSStore {
    const chaos = this;
    return new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof property !== 'string' || !value || typeof value !== 'object') {
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        }
        return new Proxy(value as object, {
          get(surface, method, surfaceReceiver) {
            const fn = Reflect.get(surface, method, surfaceReceiver) as unknown;
            if (typeof fn !== 'function') return fn;
            return (...args: unknown[]) => {
              const fault = chaos.take(new Set<ChaosFaultKind>(['store_failure']), property, {
                surfaces: [property as StoreSurface],
                method: String(method),
              });
              if (fault) {
                return Promise.reject(
                  new AgentError({
                    code: 'storage.unavailable',
                    message: `injected storage outage on ${property}.${String(method)}`,
                    category: 'internal',
                    retryable: true,
                    idempotency: 'idempotent',
                    details: { surface: property, method: String(method) },
                  }),
                );
              }
              return (fn as (...inner: unknown[]) => unknown).apply(surface, args);
            };
          },
        });
      },
    });
  }

  /** Never resolves on its own; only the tool's abort signal ends it. */
  private hang(signal: AbortSignal, toolId: string): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const finish = (): void => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new ToolTimeoutError(toolId, 400),
        );
      };
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  private take(
    kinds: Set<ChaosFaultKind>,
    target: string,
    filter: { surfaces?: StoreSurface[]; method?: string } = {},
  ): ChaosFaultSpec | undefined {
    const candidates = (this.options.faults ?? []).filter((fault) => {
      if (!kinds.has(fault.kind)) return false;
      if ((this.remaining.get(fault) ?? 0) <= 0) return false;
      if (fault.toolId !== undefined && fault.toolId !== target) return false;
      if (fault.surface !== undefined && !(filter.surfaces ?? []).includes(fault.surface)) return false;
      return true;
    });
    if (candidates.length === 0) return undefined;
    if (this.rate < 1 && this.rng() > this.rate) return undefined;
    const chosen = candidates[Math.floor(this.rng() * candidates.length) % candidates.length]!;
    this.remaining.set(chosen, (this.remaining.get(chosen) ?? 1) - 1);
    this.records.push({
      kind: chosen.kind,
      target,
      at: this.now(),
      detail: {
        ...(filter.method ? { method: filter.method } : {}),
        ...(chosen.toolId ? { toolId: chosen.toolId } : {}),
        ...(chosen.surface ? { surface: chosen.surface } : {}),
      },
    });
    return chosen;
  }
}

/**
 * A durable run is consistent regardless of which faults fired:
 *
 * - it reached a resting state, not a half-written one
 * - its journal never committed the same idempotency key twice
 * - every intent is either committed or visibly pending (never silently lost)
 * - event sequences are strictly increasing (the trace can be replayed)
 * - the limits it declared were never exceeded
 */
export interface ConsistencyReport {
  status: AgentRun['status'];
  terminal: boolean;
  journalEntries: number;
  pendingActions: number;
  duplicateCommits: string[];
  eventSequencesMonotonic: boolean;
  budgetRespected: boolean;
  failureCoded: boolean;
}

export interface ConsistencyInput {
  run: AgentRun;
  journal: Awaited<ReturnType<AgentOSStore['actions']['list']>>;
  pending: Awaited<ReturnType<AgentOSStore['actions']['pending']>>;
  events: Awaited<ReturnType<AgentOSStore['events']['list']>>;
  limits?: RunLimits;
}

export function consistencyReport(input: ConsistencyInput): ConsistencyReport {
  const committed = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of input.journal) {
    if (entry.status === 'executing' || entry.status === 'pending') continue;
    if (committed.has(entry.idempotencyKey)) duplicates.push(entry.idempotencyKey);
    committed.add(entry.idempotencyKey);
  }

  let monotonic = true;
  let previous = -1;
  for (const event of input.events) {
    if (event.sequence <= previous) monotonic = false;
    previous = event.sequence;
  }

  const limits = input.limits ?? {};
  const usage = input.run.usage;
  const budgetRespected =
    (limits.maxSteps === undefined || usage.steps <= limits.maxSteps) &&
    (limits.maxToolCalls === undefined || usage.toolCalls <= limits.maxToolCalls) &&
    (limits.maxTokens === undefined || usage.tokens.totalTokens <= limits.maxTokens) &&
    (limits.maxCostUsd === undefined || usage.costUsd <= limits.maxCostUsd) &&
    (limits.maxDurationSeconds === undefined ||
      (usage.durationMs ?? 0) <= limits.maxDurationSeconds * 1_000);

  return {
    status: input.run.status,
    terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(input.run.status),
    journalEntries: input.journal.length,
    pendingActions: input.pending.length,
    duplicateCommits: duplicates,
    eventSequencesMonotonic: monotonic,
    budgetRespected,
    failureCoded: input.run.error !== undefined,
  };
}

/** Normalize any value the way the runtime should before it is persisted. */
export function safeJson(value: unknown): JsonValue {
  return toJsonValue(value);
}
