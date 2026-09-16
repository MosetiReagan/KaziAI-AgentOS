import {
  createEvent,
  type AgentEvent,
  type AgentEventType,
  type EventBus,
  type JsonObject,
  type Logger,
} from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';

export interface EventWriterOptions {
  store: AgentOSStore;
  bus?: EventBus;
  logger?: Logger;
}

/**
 * Appends every event to durable storage *and* fans it out to subscribers.
 * Persistence comes first: an event that only reached memory would be lost
 * exactly when it matters (spec §48, §103).
 */
export class EventWriter {
  constructor(private readonly options: EventWriterOptions) {}

  async emit(input: {
    type: AgentEventType;
    runId: string;
    organizationId: string;
    projectId: string;
    traceId?: string;
    data?: JsonObject;
  }): Promise<AgentEvent> {
    const sequence = await this.options.store.events.nextSequence(input.runId);
    const event = createEvent({
      type: input.type,
      runId: input.runId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      sequence,
      data: input.data ?? {},
      ...(input.traceId ? { traceId: input.traceId } : {}),
    });
    await this.options.store.events.append(event);
    await this.options.bus?.publish(event);
    this.options.logger?.debug('event', { type: input.type, runId: input.runId, sequence });
    return event;
  }
}
