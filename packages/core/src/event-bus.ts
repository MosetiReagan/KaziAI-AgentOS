import { newEventId } from './ids.js';
import { EVENT_VERSION, type AgentEvent, type AgentEventType, type EventBus, type EventListener, type EventSubscriptionOptions } from './contracts/events.js';
import type { JsonObject } from './json.js';

export interface EmitInput {
  type: AgentEventType;
  runId: string;
  organizationId: string;
  projectId: string;
  sequence: number;
  data?: JsonObject;
  traceId?: string;
  at?: number;
}

export function createEvent(input: EmitInput): AgentEvent {
  return {
    id: newEventId(input.at),
    type: input.type,
    version: EVENT_VERSION,
    runId: input.runId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    sequence: input.sequence,
    at: input.at ?? Date.now(),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    data: input.data ?? {},
  };
}

interface Subscription {
  listener: EventListener;
  options: EventSubscriptionOptions;
}

/** Fan-out bus used by the in-process runtime and the API's SSE stream. */
export class InMemoryEventBus implements EventBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly history: AgentEvent[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit = 5_000) {
    this.historyLimit = historyLimit;
  }

  async publish(event: AgentEvent): Promise<void> {
    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    for (const subscription of [...this.subscriptions]) {
      if (!matches(event, subscription.options)) continue;
      try {
        subscription.listener(event);
      } catch {
        // A misbehaving subscriber must not break event delivery to others.
      }
    }
  }

  subscribe(listener: EventListener, options: EventSubscriptionOptions = {}): () => void {
    const subscription: Subscription = { listener, options };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Replay already-emitted events, used to prime SSE clients. */
  replay(options: EventSubscriptionOptions = {}): AgentEvent[] {
    return this.history.filter((event) => matches(event, options));
  }

  subscriberCount(): number {
    return this.subscriptions.size;
  }
}

function matches(event: AgentEvent, options: EventSubscriptionOptions): boolean {
  if (options.runId && event.runId !== options.runId) return false;
  if (options.organizationId && event.organizationId !== options.organizationId) return false;
  if (options.types && options.types.length > 0 && !options.types.includes(event.type)) return false;
  return true;
}

