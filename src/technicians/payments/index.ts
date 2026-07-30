/**
 * Eks-Health Technician Network — Payment Provider Interface
 *
 * The technician platform NEVER executes payments itself. It requests
 * payment intents through a PaymentProvider abstraction, receives
 * confirmations, receives payout confirmations, and reacts to payment
 * events emitted by the provider (webhook-style). PaySwap is the default
 * provider; Stripe / manual / custom providers can be registered without
 * changing application code.
 *
 * PaySwapProvider simulates a real payment intent lifecycle in memory
 * (pending -> confirmed -> payout_confirmed). In production, the actual
 * payment execution is delegated to the provider's hosted flow / API.
 */

import "server-only";
import {
  type PaymentIntentId,
  type PaymentProviderId,
  type PaymentIntent,
  TechnicianError,
  asPaymentIntentId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Payment types
// ---------------------------------------------------------------------------

export type PaymentIntentStatus = PaymentIntent["status"];
export type PaymentEventType =
  | "intent_created"
  | "intent_confirmed"
  | "intent_failed"
  | "intent_refunded"
  | "payout_confirmed"
  | "payout_failed";

export interface PaymentEvent {
  readonly type: PaymentEventType;
  readonly intentId: PaymentIntentId;
  readonly provider: PaymentProviderId;
  readonly at: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateIntentInput {
  readonly amount: number;
  readonly currency: string;
  readonly reference: string; // session or appointment id
  readonly metadata?: Record<string, unknown>;
  readonly providerId?: PaymentProviderId;
}

export interface ListIntentsFilter {
  readonly status?: PaymentIntentStatus;
  readonly reference?: string;
  readonly provider?: PaymentProviderId;
}

// ---------------------------------------------------------------------------
// PaymentProvider abstraction
// ---------------------------------------------------------------------------

export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** Whether this provider is properly configured and ready to use. */
  isConfigured(): boolean;
  createIntent(input: Omit<CreateIntentInput, "providerId">): PaymentIntent;
  confirmIntent(intentId: PaymentIntentId): PaymentIntent;
  refund(intentId: PaymentIntentId): PaymentIntent;
  payout(intentId: PaymentIntentId): PaymentIntent;
  getIntent(intentId: PaymentIntentId): PaymentIntent | undefined;
}

// ---------------------------------------------------------------------------
// PaySwap provider (real in-memory simulation of the intent lifecycle)
// ---------------------------------------------------------------------------

/**
 * PaySwap is the default payment provider for the Eks-Health technician
 * platform. It simulates a real payment intent lifecycle: pending ->
 * confirmed -> payout_confirmed (with refund and failure branches).
 *
 * IMPORTANT: PaySwapProvider does NOT execute real payment transactions.
 * In production, the technician platform delegates payment execution to
 * the provider's hosted checkout / API; PaySwapProvider is the in-process
 * adapter that records the lifecycle.
 */
export class PaySwapProvider implements PaymentProvider {
  readonly id: PaymentProviderId = "payswap";
  private readonly intents = new Map<PaymentIntentId, PaymentIntent>();
  private configured = true;

  isConfigured(): boolean {
    return this.configured;
  }

  setConfigured(value: boolean): void {
    this.configured = value;
  }

  createIntent(input: Omit<CreateIntentInput, "providerId">): PaymentIntent {
    if (input.amount <= 0) {
      throw new TechnicianError({
        code: "eks.technician.payment.invalid_amount",
        category: "validation",
        message: "Payment amount must be positive.",
        userMessage: "The payment amount must be greater than zero.",
      });
    }
    if (!input.currency || input.currency.length !== 3) {
      throw new TechnicianError({
        code: "eks.technician.payment.invalid_currency",
        category: "validation",
        message: "Currency must be a 3-letter ISO code.",
        userMessage: "A valid 3-letter currency code is required.",
      });
    }
    const intent: PaymentIntent = {
      id: asPaymentIntentId(generateId("pi_")),
      provider: this.id,
      amount: Math.round(input.amount * 100) / 100,
      currency: input.currency.toUpperCase(),
      status: "pending",
      reference: input.reference,
      createdAt: getClock().iso(),
      metadata: input.metadata,
    };
    this.intents.set(intent.id, intent);
    return intent;
  }

  confirmIntent(intentId: PaymentIntentId): PaymentIntent {
    const current = this.require(intentId);
    if (current.status !== "pending") {
      throw new TechnicianError({
        code: "eks.technician.payment.not_pending",
        category: "state_conflict",
        message: `Cannot confirm intent in status "${current.status}".`,
        userMessage: "This payment intent cannot be confirmed at its current stage.",
      });
    }
    const updated: PaymentIntent = {
      ...current,
      status: "confirmed",
      confirmedAt: getClock().iso(),
    };
    this.intents.set(intentId, updated);
    return updated;
  }

  refund(intentId: PaymentIntentId): PaymentIntent {
    const current = this.require(intentId);
    if (current.status !== "confirmed" && current.status !== "payout_confirmed") {
      throw new TechnicianError({
        code: "eks.technician.payment.not_refundable",
        category: "state_conflict",
        message: `Cannot refund intent in status "${current.status}".`,
        userMessage: "This payment intent cannot be refunded.",
      });
    }
    const updated: PaymentIntent = { ...current, status: "refunded" };
    this.intents.set(intentId, updated);
    return updated;
  }

  payout(intentId: PaymentIntentId): PaymentIntent {
    const current = this.require(intentId);
    if (current.status !== "confirmed") {
      throw new TechnicianError({
        code: "eks.technician.payment.not_confirmed",
        category: "state_conflict",
        message: `Cannot pay out intent in status "${current.status}".`,
        userMessage: "This payment intent must be confirmed before payout.",
      });
    }
    const updated: PaymentIntent = { ...current, status: "payout_confirmed" };
    this.intents.set(intentId, updated);
    return updated;
  }

  getIntent(intentId: PaymentIntentId): PaymentIntent | undefined {
    return this.intents.get(intentId);
  }

  listInternal(): PaymentIntent[] {
    return [...this.intents.values()];
  }

  private require(id: PaymentIntentId): PaymentIntent {
    const i = this.intents.get(id);
    if (!i) {
      throw new TechnicianError({
        code: "eks.technician.payment.not_found",
        category: "not_found",
        message: `Payment intent ${id} not found.`,
        userMessage: "This payment intent could not be found.",
      });
    }
    return i;
  }
}

// ---------------------------------------------------------------------------
// Payment manager
// ---------------------------------------------------------------------------

export class PaymentManager {
  private readonly providers = new Map<PaymentProviderId, PaymentProvider>();
  private readonly intents = new Map<PaymentIntentId, PaymentIntent>();
  private readonly byReference = new Map<string, PaymentIntentId[]>();
  private defaultProviderId: PaymentProviderId = "payswap";

  constructor() {
    // Pre-register PaySwap as the default provider.
    this.registerProvider(new PaySwapProvider());
  }

  registerProvider(provider: PaymentProvider): void {
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: PaymentProviderId): PaymentProvider | undefined {
    return this.providers.get(providerId);
  }

  listProviders(): PaymentProvider[] {
    return [...this.providers.values()];
  }

  setDefault(providerId: PaymentProviderId): void {
    if (!this.providers.has(providerId)) {
      throw new TechnicianError({
        code: "eks.technician.payment.provider_not_registered",
        category: "not_found",
        message: `Provider ${providerId} is not registered.`,
        userMessage: "That payment provider is not registered.",
      });
    }
    this.defaultProviderId = providerId;
  }

  getDefault(): PaymentProviderId {
    return this.defaultProviderId;
  }

  createIntent(input: CreateIntentInput): PaymentIntent {
    const providerId = input.providerId ?? this.defaultProviderId;
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new TechnicianError({
        code: "eks.technician.payment.provider_not_registered",
        category: "not_found",
        message: `Provider ${providerId} is not registered.`,
        userMessage: "That payment provider is not registered.",
      });
    }
    if (!provider.isConfigured()) {
      throw new TechnicianError({
        code: "eks.technician.payment.provider_not_configured",
        category: "validation",
        message: `Provider ${providerId} is not configured.`,
        userMessage: "The payment provider is not configured.",
      });
    }
    const intent = provider.createIntent(input);
    this.intents.set(intent.id, intent);
    const refList = this.byReference.get(intent.reference) ?? [];
    this.byReference.set(intent.reference, [...refList, intent.id]);
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.paymentIntentCreated,
        { intentId: intent.id, amount: intent.amount, currency: intent.currency, reference: intent.reference, provider: intent.provider },
        {},
        "domain",
      ),
    );
    return intent;
  }

  confirmIntent(intentId: PaymentIntentId): PaymentIntent {
    const current = this.requireIntent(intentId);
    const provider = this.requireProvider(current.provider);
    const updated = provider.confirmIntent(intentId);
    this.intents.set(intentId, updated);
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.paymentConfirmed,
        { intentId, amount: updated.amount, currency: updated.currency, reference: updated.reference, provider: updated.provider },
        {},
        "domain",
      ),
    );
    return updated;
  }

  refund(intentId: PaymentIntentId): PaymentIntent {
    const current = this.requireIntent(intentId);
    const provider = this.requireProvider(current.provider);
    const updated = provider.refund(intentId);
    this.intents.set(intentId, updated);
    void getEventBus().publish(
      buildEvent(
        "eks.technician.payment.refunded",
        { intentId, amount: updated.amount, currency: updated.currency, reference: updated.reference, provider: updated.provider },
        {},
        "domain",
      ),
    );
    return updated;
  }

  payout(intentId: PaymentIntentId): PaymentIntent {
    const current = this.requireIntent(intentId);
    const provider = this.requireProvider(current.provider);
    const updated = provider.payout(intentId);
    this.intents.set(intentId, updated);
    void getEventBus().publish(
      buildEvent(
        "eks.technician.payment.payout_confirmed",
        { intentId, amount: updated.amount, currency: updated.currency, reference: updated.reference, provider: updated.provider },
        {},
        "domain",
      ),
    );
    return updated;
  }

  getIntent(intentId: PaymentIntentId): PaymentIntent | undefined {
    // Delegate to provider for the freshest state, then cache locally.
    for (const provider of this.providers.values()) {
      const found = provider.getIntent(intentId);
      if (found) {
        this.intents.set(intentId, found);
        return found;
      }
    }
    return this.intents.get(intentId);
  }

  listIntents(filter?: ListIntentsFilter): PaymentIntent[] {
    let list = [...this.intents.values()];
    if (filter?.status) list = list.filter((i) => i.status === filter.status);
    if (filter?.reference) list = list.filter((i) => i.reference === filter.reference);
    if (filter?.provider) list = list.filter((i) => i.provider === filter.provider);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getIntentsByReference(reference: string): PaymentIntent[] {
    const ids = this.byReference.get(reference) ?? [];
    return ids.map((id) => this.intents.get(id)!).filter(Boolean);
  }

  /**
   * Handle a payment event arriving from the provider (webhook-style).
   * Refreshes the local cache of the intent and emits the appropriate
   * technician-domain event. Unknown intent ids are recorded but ignored.
   */
  handleEvent(event: PaymentEvent): void {
    const intent = this.getIntent(event.intentId);
    if (!intent) {
      // Provider emitted an event for an intent we don't track; ignore.
      return;
    }
    // Refresh from provider (the provider may have already updated its state).
    const fresh = this.getProvider(event.provider)?.getIntent(event.intentId) ?? intent;
    this.intents.set(event.intentId, fresh);
    const eventMap: Record<PaymentEventType, string> = {
      intent_created: TECHNICIAN_EVENTS.paymentIntentCreated,
      intent_confirmed: TECHNICIAN_EVENTS.paymentConfirmed,
      intent_failed: "eks.technician.payment.failed",
      intent_refunded: "eks.technician.payment.refunded",
      payout_confirmed: "eks.technician.payment.payout_confirmed",
      payout_failed: "eks.technician.payment.payout_failed",
    };
    void getEventBus().publish(
      buildEvent(
        eventMap[event.type],
        { intentId: event.intentId, type: event.type, provider: event.provider, reference: fresh.reference, amount: fresh.amount, currency: fresh.currency },
        {},
        "domain",
      ),
    );
  }

  getStats(): {
    totalIntents: number;
    byStatus: Record<PaymentIntentStatus, number>;
    byProvider: Record<PaymentProviderId, number>;
    totalAmount: number;
    confirmedAmount: number;
  } {
    const list = [...this.intents.values()];
    const byStatus: Record<PaymentIntentStatus, number> = {
      pending: 0,
      confirmed: 0,
      failed: 0,
      refunded: 0,
      payout_confirmed: 0,
    };
    const byProvider: Record<PaymentProviderId, number> = {
      payswap: 0,
      stripe: 0,
      manual: 0,
      custom: 0,
    };
    let totalAmount = 0;
    let confirmedAmount = 0;
    for (const i of list) {
      byStatus[i.status]++;
      byProvider[i.provider] = (byProvider[i.provider] ?? 0) + 1;
      totalAmount += i.amount;
      if (i.status === "confirmed" || i.status === "payout_confirmed") {
        confirmedAmount += i.amount;
      }
    }
    return { totalIntents: list.length, byStatus, byProvider, totalAmount, confirmedAmount };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private requireIntent(id: PaymentIntentId): PaymentIntent {
    const i = this.intents.get(id);
    if (!i) {
      throw new TechnicianError({
        code: "eks.technician.payment.not_found",
        category: "not_found",
        message: `Payment intent ${id} not found.`,
        userMessage: "This payment intent could not be found.",
      });
    }
    return i;
  }

  private requireProvider(id: PaymentProviderId): PaymentProvider {
    const p = this.providers.get(id);
    if (!p) {
      throw new TechnicianError({
        code: "eks.technician.payment.provider_not_registered",
        category: "not_found",
        message: `Provider ${id} is not registered.`,
        userMessage: "That payment provider is not registered.",
      });
    }
    return p;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _payments: PaymentManager | null = null;
export function getPayments(): PaymentManager {
  if (!_payments) _payments = new PaymentManager();
  return _payments;
}

/**
 * Extended payment event catalog. The core TECHNICIAN_EVENTS catalog covers
 * intent_created + confirmed; we re-export the full payment set here for
 * consumers that subscribe to refund/payout/failed events.
 */
export const PAYMENT_EVENTS = {
  intentCreated: TECHNICIAN_EVENTS.paymentIntentCreated,
  confirmed: TECHNICIAN_EVENTS.paymentConfirmed,
  failed: "eks.technician.payment.failed",
  refunded: "eks.technician.payment.refunded",
  payoutConfirmed: "eks.technician.payment.payout_confirmed",
  payoutFailed: "eks.technician.payment.payout_failed",
} as const;
