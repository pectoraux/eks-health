/**
 * Eks-Health Program OS — Event Platform Integration
 *
 * Programs subscribe to platform events; they NEVER poll. Every reaction is
 * event-driven. This module sits between the kernel event bus (the nervous
 * system) and individual Programs: each Program registers subscriptions to
 * topics (well-known platform topics or custom `eks.*` topics), and the
 * ProgramEventBus forwards matching events to the program's handlers.
 *
 * Capabilities:
 *   - manifest-validated subscriptions (program can only subscribe to what
 *     it declared in `eventSubscriptions`),
 *   - filter predicates (e.g. only deliver events where `payload.category === 'cardio'`),
 *   - transforms (rewrite events before delivery),
 *   - dead-letter policy with exponential backoff retry,
 *   - delivery log (delivered | failed | filtered | dead_lettered | pending),
 *   - replay from kernel event-bus history.
 *
 * Programs cannot subscribe to topics starting with `eks.kernel.` — those
 * are reserved for platform-internal use.
 */

import "server-only";
import {
  type ProgramId,
  type SubscriptionId,
  ProgramError,
  asSubscriptionId,
  PLATFORM_EVENT_TOPICS,
} from "../core";
import {
  getEventBus,
  buildEvent,
  generateId,
  getClock,
  type BaseEvent,
  type EventHandler,
  type EventHandlerContext,
  type DeadLetterPolicy,
} from "@/kernel";
import { DEFAULT_DEAD_LETTER_POLICY } from "@/kernel";
import { getRegistry } from "../lifecycle";

// re-export for callers
export { type DeadLetterPolicy, type EventHandler, type EventHandlerContext, DEFAULT_DEAD_LETTER_POLICY } from "@/kernel";
export { type SubscriptionId, PLATFORM_EVENT_TOPICS } from "../core";

// ---------------------------------------------------------------------------
// Subscription spec & record
// ---------------------------------------------------------------------------

export interface EventHandlerSpec {
  /** Glob topic pattern, e.g. `eks.measurement.*` or exact `eks.identity.account.registered`. */
  readonly topic: string;
  /** Optional filter predicate; events that do not match are recorded as `filtered`. */
  readonly filter?: (event: BaseEvent) => boolean;
  /** Optional transform applied to the event before delivery to the handler. */
  readonly transform?: (event: BaseEvent) => BaseEvent;
  /** Optional dead-letter policy with retry/backoff. */
  readonly deadLetterPolicy?: DeadLetterPolicy;
  /** Optional handler. If absent, deliveries are recorded as `pending`. */
  readonly handler?: EventHandler;
}

export interface ProgramSubscription {
  readonly id: SubscriptionId;
  readonly programId: ProgramId;
  readonly topic: string;
  readonly filter?: (event: BaseEvent) => boolean;
  readonly transform?: (event: BaseEvent) => BaseEvent;
  readonly deadLetterPolicy: DeadLetterPolicy;
  readonly handler?: EventHandler;
  readonly createdAt: string;
  readonly active: boolean;
  /** Underlying kernel event-bus subscription id (for forwarding). */
  readonly kernelSubscriptionId: string;
}

// ---------------------------------------------------------------------------
// Delivery tracking
// ---------------------------------------------------------------------------

export type DeliveryStatus = "delivered" | "failed" | "filtered" | "dead_lettered" | "pending";

export interface EventDelivery {
  readonly id: string;
  readonly programId: ProgramId;
  readonly subscriptionId: SubscriptionId;
  readonly event: BaseEvent;
  readonly status: DeliveryStatus;
  readonly deliveredAt: string;
  readonly attempt: number;
  readonly error?: string;
  readonly replayed?: boolean;
}

export interface DeliveryLogFilter {
  readonly status?: DeliveryStatus;
  readonly subscriptionId?: SubscriptionId;
  readonly since?: string;
  readonly topic?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a glob topic into a RegExp (same semantics as the kernel bus). */
function topicToRegex(topic: string): RegExp {
  const escaped = topic.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".+");
  return new RegExp(`^${escaped}$`);
}

function topicMatches(pattern: string, eventType: string): boolean {
  return topicToRegex(pattern).test(eventType);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RESERVED_TOPIC_PREFIX = "eks.kernel.";

// ---------------------------------------------------------------------------
// Program event bus
// ---------------------------------------------------------------------------

export class ProgramEventBus {
  private readonly subscriptions = new Map<SubscriptionId, ProgramSubscription>();
  private readonly byProgram = new Map<ProgramId, SubscriptionId[]>();
  private readonly deliveries: EventDelivery[] = [];
  private readonly deliveriesByProgram = new Map<ProgramId, EventDelivery[]>();
  private readonly deadLettersByProgram = new Map<ProgramId, EventDelivery[]>();

  /**
   * Register a subscription to a platform event topic for a Program.
   * Validates that the program's manifest declared this topic.
   */
  subscribe(programId: ProgramId, spec: EventHandlerSpec): SubscriptionId {
    this.validateTopic(spec.topic);
    this.validateSubscriptionAllowed(programId, spec.topic);

    const id = asSubscriptionId(generateId("psub_"));
    const now = getClock().iso();
    const policy = spec.deadLetterPolicy ?? DEFAULT_DEAD_LETTER_POLICY;

    // Register a kernel event-bus subscription that forwards matching events
    // to this program's dispatch pipeline.
    const kernelSubscriptionId = getEventBus().subscribe({
      id: `ksub_${generateId()}`,
      eventType: spec.topic,
      subscriberService: `program:${programId}`,
      deadLetterPolicy: policy,
      handler: async (ctx: EventHandlerContext) => {
        // Forward to the program. We deliberately swallow errors here:
        // retry / dead-letter is handled by dispatchToSubscription; the
        // kernel forwarding handler always reports success so the kernel
        // does not double-retry.
        try {
          await this.dispatch(programId, ctx.event);
        } catch {
          // Intentionally ignored — failures are recorded as deliveries.
        }
      },
    });

    const sub: ProgramSubscription = {
      id,
      programId,
      topic: spec.topic,
      filter: spec.filter,
      transform: spec.transform,
      deadLetterPolicy: policy,
      handler: spec.handler,
      createdAt: now,
      active: true,
      kernelSubscriptionId,
    };
    this.subscriptions.set(id, sub);
    const list = this.byProgram.get(programId) ?? [];
    this.byProgram.set(programId, [...list, id]);

    void getEventBus().publish(
      buildEvent(
        "eks.program.event.subscribed",
        { programId, subscriptionId: id, topic: spec.topic },
        {},
        "domain",
      ),
    );
    return id;
  }

  /** Unsubscribe a Program from a topic. */
  unsubscribe(programId: ProgramId, subscriptionId: SubscriptionId): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.programId !== programId) return;
    // Remove from kernel bus first to stop new deliveries.
    getEventBus().unsubscribe(sub.kernelSubscriptionId);
    this.subscriptions.delete(subscriptionId);
    const list = this.byProgram.get(programId) ?? [];
    this.byProgram.set(programId, list.filter((id) => id !== subscriptionId));

    void getEventBus().publish(
      buildEvent(
        "eks.program.event.unsubscribed",
        { programId, subscriptionId, topic: sub.topic },
        {},
        "domain",
      ),
    );
  }

  /** List a Program's subscriptions. */
  listSubscriptions(programId: ProgramId): readonly ProgramSubscription[] {
    return (this.byProgram.get(programId) ?? [])
      .map((id) => this.subscriptions.get(id)!)
      .filter((s) => s && s.active);
  }

  /**
   * Dispatch an event to all matching subscriptions for a Program.
   * Records a DeliveryStatus per subscription.
   */
  async dispatch(programId: ProgramId, event: BaseEvent): Promise<readonly EventDelivery[]> {
    const subs = (this.byProgram.get(programId) ?? [])
      .map((id) => this.subscriptions.get(id)!)
      .filter((s) => s && s.active && topicMatches(s.topic, event.type));
    const results: EventDelivery[] = [];
    for (const sub of subs) {
      const delivery = await this.dispatchToSubscription(sub, event, false);
      results.push(delivery);
    }
    return results;
  }

  /** Delivery log for a Program, optionally filtered. */
  getDeliveries(programId: ProgramId, filter?: DeliveryLogFilter): readonly EventDelivery[] {
    const all = this.deliveriesByProgram.get(programId) ?? [];
    if (!filter) return all;
    return all.filter((d) => {
      if (filter.status && d.status !== filter.status) return false;
      if (filter.subscriptionId && d.subscriptionId !== filter.subscriptionId) return false;
      if (filter.since && d.deliveredAt < filter.since) return false;
      if (filter.topic && !topicMatches(filter.topic, d.event.type)) return false;
      return true;
    });
  }

  /** Dead-lettered deliveries for a Program. */
  getDeadLetters(programId: ProgramId): readonly EventDelivery[] {
    return this.deadLettersByProgram.get(programId) ?? [];
  }

  /**
   * Re-deliver events from the kernel event-bus history matching the
   * subscription. Optionally only events since `since` (ISO timestamp).
   * Returns the count of events replayed.
   */
  async replay(programId: ProgramId, subscriptionId: SubscriptionId, since?: string): Promise<number> {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.programId !== programId || !sub.active) {
      throw new ProgramError({
        code: "eks.program.event.subscription_not_found",
        category: "not_found",
        message: `Subscription ${subscriptionId} not found for program ${programId}.`,
        userMessage: "Subscription not found.",
      });
    }
    const history = getEventBus().getHistory((e) => {
      if (!topicMatches(sub.topic, e.type)) return false;
      if (since && e.occurredAt < since) return false;
      return true;
    });
    for (const event of history) {
      const delivery = await this.dispatchToSubscription(sub, event, true);
      // dead-lettered replays still recorded; do not throw
      void delivery;
    }
    void getEventBus().publish(
      buildEvent(
        "eks.program.event.replayed",
        { programId, subscriptionId, count: history.length, since },
        {},
        "domain",
      ),
    );
    return history.length;
  }

  // --- Internals ------------------------------------------------------------

  private validateTopic(topic: string): void {
    if (!topic || typeof topic !== "string") {
      throw new ProgramError({
        code: "eks.program.event.invalid_topic",
        category: "validation",
        message: "Subscription topic must be a non-empty string.",
        userMessage: "Invalid event topic.",
      });
    }
    if (topic.startsWith(RESERVED_TOPIC_PREFIX)) {
      throw new ProgramError({
        code: "eks.program.event.reserved_topic",
        category: "capability_denied",
        message: `Topic '${topic}' is reserved for platform use and cannot be subscribed by programs.`,
        userMessage: "This event topic is reserved for the platform.",
      });
    }
  }

  /**
   * Validate the program's manifest declared this topic. If the program is
   * registered and its manifest has `eventSubscriptions`, the topic must
   * be in that list (exact match — globs must be declared as globs). If
   * the program is not yet registered, default to allowing `eks.*` topics
   * (forward-compatible for bootstrap).
   */
  private validateSubscriptionAllowed(programId: ProgramId, topic: string): void {
    const record = getRegistry().get(programId);
    if (!record) {
      // Defensive: allow standard platform topics for un-registered programs
      // (e.g. during bootstrap or test). Custom non-`eks.` topics require
      // registration + manifest declaration.
      if (!topic.startsWith("eks.") || topic.startsWith(RESERVED_TOPIC_PREFIX)) {
        throw new ProgramError({
          code: "eks.program.event.not_declared",
          category: "capability_denied",
          message: `Program ${programId} is not registered and cannot subscribe to topic '${topic}'.`,
          userMessage: "This program is not allowed to subscribe to that topic.",
        });
      }
      return;
    }
    const version = record.versions.find((v) => v.id === record.currentVersionId);
    const declared = version?.manifest.eventSubscriptions;
    if (!declared || declared.length === 0) {
      // Manifest declared no subscriptions — only allow platform topics.
      const knownPlatformTopics = Object.values(PLATFORM_EVENT_TOPICS);
      const isPlatformExact = knownPlatformTopics.includes(topic as never);
      const isPlatformGlob = knownPlatformTopics.some((t) => {
        // Allow `eks.<area>.*` style globs that subsume at least one known topic.
        if (!topic.endsWith(".*")) return false;
        const prefix = topic.slice(0, -1); // strip trailing `*`
        return t.startsWith(prefix);
      });
      if (!isPlatformExact && !isPlatformGlob) {
        throw new ProgramError({
          code: "eks.program.event.not_declared",
          category: "capability_denied",
          message: `Program ${programId} did not declare topic '${topic}' in its manifest eventSubscriptions.`,
          userMessage: "This program did not declare that event subscription.",
          metadata: { programId, topic, declared: declared ?? [] },
        });
      }
      return;
    }
    if (!declared.includes(topic)) {
      throw new ProgramError({
        code: "eks.program.event.not_declared",
        category: "capability_denied",
        message: `Program ${programId} did not declare topic '${topic}' in its manifest eventSubscriptions.`,
        userMessage: "This program did not declare that event subscription.",
        metadata: { programId, topic, declared },
      });
    }
  }

  /**
   * Deliver a single event to a single subscription, applying filter,
   * transform, retry, and dead-letter policy.
   */
  private async dispatchToSubscription(
    sub: ProgramSubscription,
    event: BaseEvent,
    isReplay: boolean,
  ): Promise<EventDelivery> {
    const deliveredAt = getClock().iso();

    // Filter predicate.
    if (sub.filter && !sub.filter(event)) {
      return this.recordDelivery({
        id: generateId("del_"),
        programId: sub.programId,
        subscriptionId: sub.id,
        event,
        status: "filtered",
        deliveredAt,
        attempt: 0,
        replayed: isReplay,
      });
    }

    // Transform (defensive — if it throws, record as failed).
    let evt: BaseEvent = event;
    if (sub.transform) {
      try {
        evt = sub.transform(event);
      } catch (e) {
        return this.recordDelivery({
          id: generateId("del_"),
          programId: sub.programId,
          subscriptionId: sub.id,
          event,
          status: "failed",
          deliveredAt,
          attempt: 1,
          error: `Transform failed: ${(e as Error).message}`,
          replayed: isReplay,
        });
      }
    }

    // No handler — pending.
    if (!sub.handler) {
      return this.recordDelivery({
        id: generateId("del_"),
        programId: sub.programId,
        subscriptionId: sub.id,
        event: evt,
        status: "pending",
        deliveredAt,
        attempt: 0,
        replayed: isReplay,
      });
    }

    // Deliver with retry + exponential backoff.
    const policy = sub.deadLetterPolicy;
    let attempt = 0;
    let backoff = policy.initialBackoffMs;
    let lastError: string | undefined;
    while (attempt <= policy.maxRetries) {
      try {
        await sub.handler({ event: evt, retryCount: attempt, attempt: attempt + 1 });
        return this.recordDelivery({
          id: generateId("del_"),
          programId: sub.programId,
          subscriptionId: sub.id,
          event: evt,
          status: "delivered",
          deliveredAt,
          attempt: attempt + 1,
          replayed: isReplay,
        });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        attempt++;
        if (attempt > policy.maxRetries) break;
        await sleep(backoff);
        backoff = Math.min(backoff * policy.backoffMultiplier, policy.maxBackoffMs);
      }
    }
    // Exhausted retries — dead-letter.
    return this.recordDelivery({
      id: generateId("del_"),
      programId: sub.programId,
      subscriptionId: sub.id,
      event: evt,
      status: "dead_lettered",
      deliveredAt,
      attempt,
      error: lastError,
      replayed: isReplay,
    });
  }

  private recordDelivery(delivery: EventDelivery): EventDelivery {
    this.deliveries.push(delivery);
    const list = this.deliveriesByProgram.get(delivery.programId) ?? [];
    list.push(delivery);
    this.deliveriesByProgram.set(delivery.programId, list);
    if (delivery.status === "dead_lettered") {
      const dl = this.deadLettersByProgram.get(delivery.programId) ?? [];
      dl.push(delivery);
      this.deadLettersByProgram.set(delivery.programId, dl);
      void getEventBus().publish(
        buildEvent(
          "eks.program.event.dead_lettered",
          {
            programId: delivery.programId,
            subscriptionId: delivery.subscriptionId,
            eventId: delivery.event.id,
            eventType: delivery.event.type,
            error: delivery.error,
            attempt: delivery.attempt,
          },
          {},
          "domain",
        ),
      );
    }
    return delivery;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _bus: ProgramEventBus | null = null;
export function getProgramEvents(): ProgramEventBus {
  if (!_bus) _bus = new ProgramEventBus();
  return _bus;
}
