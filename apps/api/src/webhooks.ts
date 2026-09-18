import { createHmac, randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventType, EventBus, Logger, JsonObject } from '@kazi-ai/agentos-core';
import type { AgentOSStore, WebhookSubscriptionRecord } from '@kazi-ai/agentos-persistence';

export interface WebhookDispatcherOptions {
  store: AgentOSStore;
  bus: EventBus;
  logger?: Logger;
  /** Attempts per delivery before it is recorded as failed. */
  maxAttempts?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Base delay for exponential backoff, in milliseconds. */
  backoffMs?: number;
  /** Injectable for tests: replaces the real HTTP call. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryOutcome {
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_BACKOFF_MS = 250;

/**
 * Sign a delivery. The signature covers the timestamp as well as the body, so
 * a captured request cannot be replayed later (spec §98).
 */
export function signPayload(input: {
  secret: string;
  timestamp: number;
  body: string;
}): string {
  return createHmac('sha256', input.secret)
    .update(`${input.timestamp}.${input.body}`)
    .digest('hex');
}

/** The parts of an event a delivery needs; a test ping is one of these too. */
export interface WebhookEventRef {
  id: string;
  /** Event type, or `webhook.test` for a synthetic ping. */
  type: AgentEventType | 'webhook.test';
  runId: string;
  organizationId: string;
  projectId: string;
}

/** The headers a receiver needs to verify a delivery. */
export function deliveryHeaders(input: {
  secret: string;
  event: Pick<WebhookEventRef, 'id' | 'type' | 'runId'>;
  deliveryId: string;
  timestamp: number;
  body: string;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'user-agent': 'kazi-agentos-webhooks/1',
    'x-kazi-event': input.event.type,
    'x-kazi-event-id': input.event.id,
    'x-kazi-run-id': input.event.runId,
    'x-kazi-delivery': input.deliveryId,
    'x-kazi-timestamp': String(input.timestamp),
    'x-kazi-signature': `sha256=${signPayload({ secret: input.secret, timestamp: input.timestamp, body: input.body })}`,
  };
}

/**
 * Delivers run events to subscribed endpoints, with HMAC signatures, retries
 * and a durable delivery log.
 *
 * Subscriptions and enabled state live in the store, so a delivery that fails
 * while the API is down is not lost: the receiver can be replayed from the
 * event log, and every attempt is recorded.
 */
export class WebhookDispatcher {
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private unsubscribe?: () => void;
  private started = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: WebhookDispatcherOptions) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.options.bus.subscribe((event) => {
      const delivery = this.handle(event).catch((error: unknown) => {
        this.options.logger?.error('webhook delivery failed unexpectedly', {
          eventId: event.id,
          error: (error as Error).message,
        });
      });
      this.inFlight.add(delivery);
      void delivery.finally(() => this.inFlight.delete(delivery));
    });
  }

  /** Wait for deliveries triggered so far. Used by tests and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.started = false;
    await this.drain();
  }

  /** Deliver one event to every subscription that asked for it. */
  async handle(event: AgentEvent): Promise<void> {
    const subscriptions = await this.options.store.webhooks.list({
      organizationId: event.organizationId,
      active: true,
    });
    const matching = subscriptions.filter(
      (subscription) =>
        subscription.projectId === event.projectId &&
        (subscription.events.length === 0 ||
          subscription.events.includes(event.type as AgentEventType)),
    );
    for (const subscription of matching) {
      await this.deliver(subscription, {
        id: event.id,
        type: event.type,
        runId: event.runId,
        organizationId: event.organizationId,
        projectId: event.projectId,
      }, JSON.stringify(event));
    }
  }

  /** Send a synthetic event, so an operator can prove an endpoint works. */
  async test(subscription: WebhookSubscriptionRecord): Promise<DeliveryOutcome> {
    const body = JSON.stringify({
      id: `evt_test_${randomUUID()}`,
      type: 'webhook.test',
      version: 1,
      runId: 'run_test',
      organizationId: subscription.organizationId,
      projectId: subscription.projectId,
      sequence: 0,
      at: this.now(),
      data: { message: 'KaziAI AgentOS webhook test' } as JsonObject,
    });
    return this.post(subscription, {
      id: 'evt_test',
      type: 'webhook.test',
      runId: 'run_test',
      organizationId: subscription.organizationId,
      projectId: subscription.projectId,
    }, body, 1);
  }

  private async deliver(
    subscription: WebhookSubscriptionRecord,
    event: WebhookEventRef,
    body: string,
  ): Promise<void> {
    const started = this.now();
    let last: DeliveryOutcome = { delivered: false, attempts: 0 };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      last = await this.post(subscription, event, body, attempt);
      if (last.delivered) break;
      if (attempt < this.maxAttempts) {
        // Exponential backoff with jitter: a hundred failing receivers must not
        // retry in lockstep.
        const base = this.backoffMs * 2 ** (attempt - 1);
        await this.sleep(base + Math.floor(Math.random() * this.backoffMs));
      }
    }
    await this.options.store.webhooks.recordDelivery({
      id: `whd_${randomUUID()}`,
      subscriptionId: subscription.id,
      organizationId: subscription.organizationId,
      eventId: event.id,
      eventType: event.type,
      runId: event.runId,
      url: subscription.url,
      status: last.delivered ? 'delivered' : 'failed',
      attempts: last.attempts,
      ...(last.status === undefined ? {} : { responseStatus: last.status }),
      ...(last.error === undefined ? {} : { error: last.error }),
      at: this.now(),
      durationMs: this.now() - started,
    });
    if (!last.delivered) {
      this.options.logger?.warn('webhook delivery failed', {
        subscriptionId: subscription.id,
        url: subscription.url,
        eventType: event.type,
        attempts: last.attempts,
      });
    }
  }

  private async post(
    subscription: WebhookSubscriptionRecord,
    event: WebhookEventRef,
    body: string,
    attempt: number,
  ): Promise<DeliveryOutcome> {
    const timestamp = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(subscription.url, {
        method: 'POST',
        headers: deliveryHeaders({
          secret: subscription.secret,
          event,
          deliveryId: `${event.id}:${attempt}`,
          timestamp,
          body,
        }),
        body,
        signal: controller.signal,
      });
      if (response.ok) return { delivered: true, attempts: attempt, status: response.status };
      return {
        delivered: false,
        attempts: attempt,
        status: response.status,
        error: `endpoint answered ${response.status}`,
      };
    } catch (error) {
      return { delivered: false, attempts: attempt, error: (error as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
