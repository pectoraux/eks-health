/**
 * Eks-Health Kernel — Event Bus
 *
 * The nervous system of the platform. Everything communicates via events.
 *
 * Capabilities:
 *  - Domain / Integration / System / Scheduled / Delayed events
 *  - Pub-sub with typed handlers
 *  - Idempotency via event-id deduplication
 *  - Correlation & causation ID propagation
 *  - Retry with exponential backoff
 *  - Dead Letter Queue
 *  - Ordered delivery within a partition key
 *  - Replay from history
 *  - Schema versioning
 *  - In-memory default adapter (swappable for Kafka/NATS/SQS in production)
 */

import type {
  BaseEvent,
  CausationId,
  CorrelationId,
  EventId,
  EventKind,
  EventEnvelopeMeta,
  TenantId,
} from "../core";
import { generateEventId, generateCorrelationId, getClock } from "../core";

export type { BaseEvent, EventKind, EventId, CorrelationId, CausationId } from "../core";

// ---------------------------------------------------------------------------
// Handler contract
// ---------------------------------------------------------------------------

export interface EventHandlerContext {
  readonly event: BaseEvent;
  readonly retryCount: number;
  readonly attempt: number;
}

export type EventHandler<T extends BaseEvent = BaseEvent> = (
  ctx: EventHandlerContext,
) => Promise<void> | void;

export interface Subscription {
  readonly id: string;
  readonly eventType: string; // glob pattern, e.g. "eks.kernel.tenant.*"
  readonly handler: EventHandler;
  readonly subscriberService?: string;
  readonly deadLetterPolicy?: DeadLetterPolicy;
}

export interface DeadLetterPolicy {
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly backoffMultiplier: number;
}

export const DEFAULT_DEAD_LETTER_POLICY: DeadLetterPolicy = {
  maxRetries: 5,
  initialBackoffMs: 100,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2,
};

// ---------------------------------------------------------------------------
// Event builder
// ---------------------------------------------------------------------------

export interface PublishOptions {
  readonly tenantId?: TenantId;
  readonly correlationId?: CorrelationId;
  readonly causationId?: CausationId;
  readonly actor?: { kind: "user" | "service" | "system"; id: string };
  readonly region?: string;
  readonly delayMs?: number;
  readonly partitionKey?: string;
}

export function buildEvent<P>(
  type: string,
  payload: P,
  opts: PublishOptions = {},
  kind: EventKind = "domain",
  schemaVersion = 1,
): BaseEvent<P> {
  return {
    id: generateEventId(),
    kind,
    type,
    schemaVersion,
    payload,
    occurredAt: getClock().iso(),
    tenantId: opts.tenantId,
    correlationId: opts.correlationId ?? generateCorrelationId(),
    causationId: opts.causationId,
    actor: opts.actor,
    region: opts.region,
  };
}

// ---------------------------------------------------------------------------
// Dead-lettered event record
// ---------------------------------------------------------------------------

export interface DeadLetteredEvent {
  readonly event: BaseEvent;
  readonly subscriptionId: string;
  readonly reason: string;
  readonly failedAt: string;
  readonly attempts: number;
  readonly lastError?: string;
}

// ---------------------------------------------------------------------------
// Event Bus implementation (in-memory, partition-ordered, retry-aware)
// ---------------------------------------------------------------------------

interface InternalSubscription extends Subscription {
  readonly compiledPattern: RegExp;
}

function globToRegex(glob: string): RegExp {
  // Convert "eks.kernel.tenant.*" into /^eks\.kernel\.tenant\..+$/
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`);
}

export interface EventBusStats {
  readonly published: number;
  readonly delivered: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly replayed: number;
  readonly activeSubscriptions: number;
}

export class EventBus {
  private readonly subscriptions = new Map<string, InternalSubscription>();
  private readonly history: BaseEvent[] = [];
  private readonly deadLetterQueue: DeadLetteredEvent[] = [];
  private readonly idempotency = new Set<EventId>();
  private readonly stats = { published: 0, delivered: 0, failed: 0, deadLettered: 0, replayed: 0 };

  subscribe(sub: Subscription): string {
    const id = sub.id ?? `sub_${Math.random().toString(36).slice(2, 10)}`;
    const internal: InternalSubscription = {
      ...sub,
      id,
      compiledPattern: globToRegex(sub.eventType),
    };
    this.subscriptions.set(id, internal);
    return id;
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);
  }

  /** Publish an event. Honors delayMs (scheduled delivery) and idempotency. */
  async publish<P>(event: BaseEvent<P>): Promise<void> {
    // Idempotency: a duplicate event id is acknowledged but not re-delivered.
    if (this.idempotency.has(event.id)) {
      return;
    }
    this.idempotency.add(event.id);
    // Store as the canonical BaseEvent (payload defaults to Record<string, unknown>).
    // The payload is invariant, so we widen via a safe cast — at runtime it is a plain object.
    const canonical = event as BaseEvent;
    this.history.push(canonical);
    this.stats.published++;

    const delayMs = (event.payload as { delayMs?: number } | undefined)?.delayMs;
    if (delayMs && delayMs > 0) {
      setTimeout(() => this.dispatch(canonical), delayMs);
      return;
    }
    await this.dispatch(canonical);
  }

  private async dispatch(event: BaseEvent, isReplay = false): Promise<void> {
    const matched: InternalSubscription[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.compiledPattern.test(event.type)) {
        matched.push(sub);
      }
    }
    // Ordered delivery: process matches sequentially per event to preserve
    // ordering within a single publish. Real backends shard by partitionKey.
    for (const sub of matched) {
      await this.deliverWithRetry(event, sub, isReplay);
    }
  }

  private async deliverWithRetry(
    event: BaseEvent,
    sub: InternalSubscription,
    isReplay: boolean,
  ): Promise<void> {
    const policy = sub.deadLetterPolicy ?? DEFAULT_DEAD_LETTER_POLICY;
    let attempt = 0;
    let backoff = policy.initialBackoffMs;
    let lastError: string | undefined;
    while (attempt <= policy.maxRetries) {
      try {
        await sub.handler({ event, retryCount: attempt, attempt: attempt + 1 });
        if (!isReplay) this.stats.delivered++;
        return;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        attempt++;
        if (attempt > policy.maxRetries) break;
        await sleep(backoff);
        backoff = Math.min(backoff * policy.backoffMultiplier, policy.maxBackoffMs);
      }
    }
    if (!isReplay) this.stats.failed++;
    this.deadLetterQueue.push({
      event,
      subscriptionId: sub.id,
      reason: "max_retries_exceeded",
      failedAt: getClock().iso(),
      attempts: attempt,
      lastError,
    });
    if (!isReplay) this.stats.deadLettered++;
  }

  /** Replay events matching a filter from history. */
  async replay(filter: (e: BaseEvent) => boolean): Promise<number> {
    const matches = this.history.filter(filter);
    for (const evt of matches) {
      await this.dispatch(evt, true);
      this.stats.replayed++;
    }
    return matches.length;
  }

  getHistory(filter?: (e: BaseEvent) => boolean): BaseEvent[] {
    return filter ? this.history.filter(filter) : [...this.history];
  }

  getDeadLetters(): DeadLetteredEvent[] {
    return [...this.deadLetterQueue];
  }

  getStats(): EventBusStats {
    return { ...this.stats, activeSubscriptions: this.subscriptions.size };
  }

  /** For testing / maintenance only. */
  reset(): void {
    this.subscriptions.clear();
    this.history.length = 0;
    this.deadLetterQueue.length = 0;
    this.idempotency.clear();
    this.stats.published = 0;
    this.stats.delivered = 0;
    this.stats.failed = 0;
    this.stats.deadLettered = 0;
    (this.stats as { replayed: number }).replayed = 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _bus: EventBus | null = null;
export function getEventBus(): EventBus {
  if (!_bus) _bus = new EventBus();
  return _bus;
}
export function setEventBus(bus: EventBus): void {
  _bus = bus;
}

// ---------------------------------------------------------------------------
// Well-known system events
// ---------------------------------------------------------------------------

export const SYSTEM_EVENTS = {
  platformStarted: "eks.kernel.system.platform_started",
  serviceRegistered: "eks.kernel.system.service_registered",
  serviceHealthChanged: "eks.kernel.system.service_health_changed",
  flagToggled: "eks.kernel.flag.toggled",
  configChanged: "eks.kernel.config.changed",
  tenantProvisioned: "eks.kernel.tenant.provisioned",
  scheduleFired: "eks.kernel.scheduler.fired",
} as const;

export type SystemEventType = (typeof SYSTEM_EVENTS)[keyof typeof SYSTEM_EVENTS];

export type { EventEnvelopeMeta };
