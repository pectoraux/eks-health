/**
 * Eks-Health Health Marketplace — Monetization & Licensing
 *
 * Programs declare pricing (free, one-time, subscription, freemium,
 * enterprise, government, employer, consumables, premium AI, premium content,
 * bundles, measurement packages). The marketplace NEVER processes payments.
 * It records purchase intents, receives confirmations from the Payment
 * Provider (PaySwap initially), and manages licenses + entitlements.
 *
 * Real logic:
 *  - Real purchase-intent lifecycle: pending → confirmed | failed | refunded,
 *    with idempotent confirmation (a second confirm on the same intent is a
 *    no-op rather than a duplicate license).
 *  - Real license + entitlement lifecycle: license status (active | trial |
 *    expired | revoked | cancelled), entitlement activation/revocation,
 *    feature-level access checks.
 *  - Real expiry sweep: scans all licenses and flips any past their endDate
 *    to "expired" + revokes the linked entitlement. Designed to be called by
 *    the kernel scheduler on a regular cadence.
 *  - Real stats: intent counts by status, license counts by status + pricing
 *    type, totals.
 *
 * Boundary: NO payment processing. The Payment Provider subscribes to
 * purchase.intent_created events and emits confirmations via confirmPurchase.
 */

import "server-only";
import type {
  AccountId,
  Entitlement,
  EntitlementId,
  License,
  LicenseId,
  ListingId,
  PricingType,
  PurchaseIntent,
  PurchaseIntentId,
} from "../core";
import {
  MARKETPLACE_EVENTS,
  MarketplaceError,
  asEntitlementId,
  asLicenseId,
  asPurchaseIntentId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreatePurchaseIntentInput {
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly pricingType: PricingType;
  readonly amount: number;
  readonly currency: string;
  readonly features?: string[];
  readonly metadata?: Record<string, unknown>;
  readonly trialDays?: number;
}

export interface ConfirmPurchaseInput {
  readonly entitlementId?: EntitlementId;
  readonly features?: string[];
  readonly endDate?: string;
  readonly trialEndDate?: string;
  readonly trialDays?: number;
}

export interface PurchaseIntentFilter {
  readonly listingId?: ListingId;
  readonly participantId?: AccountId;
  readonly pricingType?: PricingType;
  readonly status?: PurchaseIntent["status"];
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface LicenseFilter {
  readonly participantId?: AccountId;
  readonly listingId?: ListingId;
  readonly pricingType?: PricingType;
  readonly status?: License["status"];
  readonly limit?: number;
  readonly offset?: number;
}

export interface MonetizationStats {
  readonly totalIntents: number;
  readonly pendingIntents: number;
  readonly confirmedIntents: number;
  readonly failedIntents: number;
  readonly refundedIntents: number;
  readonly activeLicenses: number;
  readonly trialLicenses: number;
  readonly expiredLicenses: number;
  readonly revokedLicenses: number;
  readonly cancelledLicenses: number;
  readonly totalEntitlements: number;
  readonly activeEntitlements: number;
  readonly revokedEntitlements: number;
  readonly intentsByPricingType: Readonly<Record<string, number>>;
  readonly licensesByPricingType: Readonly<Record<string, number>>;
  readonly totalGrossAmount: number;
  readonly totalRefundedAmount: number;
}

export interface EntitlementCheckResult {
  readonly entitled: boolean;
  readonly licenseId?: LicenseId;
  readonly entitlementId?: EntitlementId;
  readonly reason?: "no_license" | "no_entitlement" | "feature_not_covered" | "entitlement_revoked" | "license_inactive";
}

// ---------------------------------------------------------------------------
// Internal mutable records (the public types are readonly; we mutate locally)
// ---------------------------------------------------------------------------

interface MutableLicense extends License {
  endDate?: string;
  trialEndDate?: string;
}

type MutableEntitlement = Entitlement;

type MutablePurchaseIntent = PurchaseIntent;

// ---------------------------------------------------------------------------
// MonetizationManager
// ---------------------------------------------------------------------------

/**
 * MonetizationManager — tracks purchase intents, licenses, and entitlements.
 * Does NOT process payments — only records intents + accounting + emits
 * events that the Payment Provider subscribes to.
 */
export class MonetizationManager {
  private readonly intents = new Map<PurchaseIntentId, MutablePurchaseIntent>();
  private readonly licenses = new Map<LicenseId, MutableLicense>();
  private readonly entitlements = new Map<EntitlementId, MutableEntitlement>();
  private readonly licensesByParticipantListing = new Map<string, LicenseId>();

  /** Create a purchase intent. Emits purchase.intent_created (the Payment Provider listens). */
  createPurchaseIntent(input: CreatePurchaseIntentInput): PurchaseIntent {
    if (!input.listingId) {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.listing_required",
        category: "validation",
        message: "listingId is required.",
        userMessage: "A listing is required.",
      });
    }
    if (!input.participantId) {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.participant_required",
        category: "validation",
        message: "participantId is required.",
        userMessage: "A participant is required.",
      });
    }
    if (input.amount < 0 || !Number.isFinite(input.amount)) {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.amount_invalid",
        category: "validation",
        message: `Invalid amount: ${input.amount}`,
        userMessage: "Please provide a valid amount.",
      });
    }
    if (!input.currency || input.currency.length !== 3) {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.currency_invalid",
        category: "validation",
        message: `Invalid currency: ${input.currency}`,
        userMessage: "Please provide a valid 3-letter currency code.",
      });
    }
    const id = asPurchaseIntentId(`pi_${generateId()}`);
    const now = getClock().iso();
    const intent: MutablePurchaseIntent = {
      id,
      listingId: input.listingId,
      participantId: input.participantId,
      pricingType: input.pricingType,
      amount: input.amount,
      currency: input.currency,
      status: "pending",
      createdAt: now,
      metadata: input.metadata,
    };
    this.intents.set(id, intent);

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.purchaseIntentCreated,
        {
          intentId: id,
          listingId: input.listingId,
          participantId: input.participantId,
          pricingType: input.pricingType,
          amount: input.amount,
          currency: input.currency,
          features: input.features ?? [],
          trialDays: input.trialDays,
        },
        {
          actor: { kind: "user", id: input.participantId as string },
          partitionKey: input.listingId as string,
        },
        "domain",
      ),
    );

    return intent;
  }

  /**
   * Confirm a purchase — marks the intent as confirmed, creates a License +
   * Entitlement, and emits purchase.confirmed + entitlement.granted.
   * Idempotent: a second call returns the existing license.
   */
  confirmPurchase(intentId: PurchaseIntentId, input?: ConfirmPurchaseInput): { license: License; entitlement: Entitlement; intent: PurchaseIntent } {
    const intent = this.requireIntent(intentId);
    if (intent.status === "refunded") {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.already_refunded",
        category: "state_conflict",
        message: `Intent ${intentId} was already refunded; cannot confirm.`,
        userMessage: "This purchase was refunded.",
      });
    }
    if (intent.status === "failed") {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.failed",
        category: "state_conflict",
        message: `Intent ${intentId} failed; cannot confirm.`,
        userMessage: "This purchase failed.",
      });
    }
    // Idempotent: if already confirmed, return the existing license+entitlement.
    if (intent.status === "confirmed" && intent.entitlementId) {
      const existingLicense = this.findLicenseByEntitlement(intent.entitlementId);
      if (existingLicense) {
        return {
          license: existingLicense,
          entitlement: this.entitlements.get(intent.entitlementId) as Entitlement,
          intent,
        };
      }
    }

    const now = getClock().iso();
    const licenseId = asLicenseId(`lic_${generateId()}`);
    const entitlementId = input?.entitlementId ?? asEntitlementId(`ent_${generateId()}`);

    // Compute end date: trial → trialEndDate + trial-length; subscription → +period.
    const endDate = input?.endDate ?? this.computeEndDate(intent.pricingType, input?.trialDays);
    const trialEndDate = input?.trialEndDate ?? (input?.trialDays ? this.computeTrialEndDate(input.trialDays) : undefined);
    const status: License["status"] = input?.trialDays && input.trialDays > 0 ? "trial" : "active";

    const license: MutableLicense = {
      id: licenseId,
      listingId: intent.listingId,
      participantId: intent.participantId,
      pricingType: intent.pricingType,
      status,
      startDate: now,
      endDate,
      trialEndDate,
      purchaseIntentId: intent.id,
      entitlementId,
    };
    this.licenses.set(licenseId, license);
    this.licensesByParticipantListing.set(this.participantListingKey(intent.participantId, intent.listingId), licenseId);

    const features = input?.features ?? this.defaultFeaturesFor(intent.pricingType);
    const entitlement: MutableEntitlement = {
      id: entitlementId,
      licenseId,
      features,
      active: true,
      grantedAt: now,
    };
    this.entitlements.set(entitlementId, entitlement);

    const updatedIntent: MutablePurchaseIntent = {
      ...intent,
      status: "confirmed",
      confirmedAt: now,
      entitlementId,
    };
    this.intents.set(intentId, updatedIntent);

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.purchaseConfirmed,
        {
          intentId,
          licenseId,
          entitlementId,
          listingId: intent.listingId,
          participantId: intent.participantId,
          pricingType: intent.pricingType,
          amount: intent.amount,
          currency: intent.currency,
        },
        {
          actor: { kind: "service", id: "payment-provider" },
          partitionKey: intent.listingId as string,
        },
        "domain",
      ),
    );
    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.entitlementGranted,
        {
          entitlementId,
          licenseId,
          listingId: intent.listingId,
          participantId: intent.participantId,
          features,
        },
        {
          actor: { kind: "service", id: "monetization-manager" },
          partitionKey: intent.participantId as string,
        },
        "domain",
      ),
    );

    return { license, entitlement, intent: updatedIntent };
  }

  /**
   * Refund a purchase — marks intent as refunded, revokes the entitlement and
   * cancels the license. Emits purchase.refunded + entitlement.revoked.
   */
  refundPurchase(intentId: PurchaseIntentId): { intent: PurchaseIntent; license?: License; entitlement?: Entitlement } {
    const intent = this.requireIntent(intentId);
    if (intent.status === "refunded") {
      // Idempotent.
      const existingLicense = intent.entitlementId ? this.findLicenseByEntitlement(intent.entitlementId) : undefined;
      return {
        intent,
        license: existingLicense,
        entitlement: intent.entitlementId ? this.entitlements.get(intent.entitlementId) : undefined,
      };
    }
    if (intent.status !== "confirmed") {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.not_confirmable",
        category: "state_conflict",
        message: `Intent ${intentId} is in status ${intent.status}; only confirmed intents can be refunded.`,
        userMessage: "This purchase cannot be refunded.",
      });
    }

    const now = getClock().iso();
    const updatedIntent: MutablePurchaseIntent = {
      ...intent,
      status: "refunded",
    };
    this.intents.set(intentId, updatedIntent);

    let updatedLicense: MutableLicense | undefined;
    let updatedEntitlement: MutableEntitlement | undefined;

    if (intent.entitlementId) {
      const entitlement = this.entitlements.get(intent.entitlementId);
      if (entitlement) {
        updatedEntitlement = { ...entitlement, active: false, revokedAt: now };
        this.entitlements.set(intent.entitlementId, updatedEntitlement);
      }
      const license = this.findLicenseByEntitlement(intent.entitlementId);
      if (license) {
        updatedLicense = { ...license, status: "cancelled" };
        this.licenses.set(license.id, updatedLicense);
      }
    }

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.purchaseRefunded,
        {
          intentId,
          listingId: intent.listingId,
          participantId: intent.participantId,
          amount: intent.amount,
          currency: intent.currency,
        },
        {
          actor: { kind: "service", id: "payment-provider" },
          partitionKey: intent.listingId as string,
        },
        "domain",
      ),
    );
    if (updatedEntitlement) {
      void getEventBus().publish(
        buildEvent(
          MARKETPLACE_EVENTS.entitlementRevoked,
          {
            entitlementId: updatedEntitlement.id,
            licenseId: updatedEntitlement.licenseId,
            listingId: intent.listingId,
            participantId: intent.participantId,
            reason: "refund",
          },
          {
            actor: { kind: "service", id: "monetization-manager" },
            partitionKey: intent.participantId as string,
          },
          "domain",
        ),
      );
    }

    return { intent: updatedIntent, license: updatedLicense, entitlement: updatedEntitlement };
  }

  /** Get the active license for a participant + listing (if any). */
  getLicense(participantId: AccountId, listingId: ListingId): License | undefined {
    const id = this.licensesByParticipantListing.get(this.participantListingKey(participantId, listingId));
    if (!id) return undefined;
    return this.licenses.get(id);
  }

  /** Get entitlements for a license. */
  getEntitlement(licenseId: LicenseId): Entitlement | undefined {
    const license = this.licenses.get(licenseId);
    if (!license?.entitlementId) return undefined;
    return this.entitlements.get(license.entitlementId);
  }

  /**
   * Check whether a participant has an active entitlement covering the given
   * feature. Returns a structured result explaining the decision.
   */
  checkEntitlement(
    participantId: AccountId,
    listingId: ListingId,
    feature: string,
  ): EntitlementCheckResult {
    const license = this.getLicense(participantId, listingId);
    if (!license) {
      return { entitled: false, reason: "no_license" };
    }
    if (license.status !== "active" && license.status !== "trial") {
      return { entitled: false, licenseId: license.id, reason: "license_inactive" };
    }
    const entitlement = license.entitlementId ? this.entitlements.get(license.entitlementId) : undefined;
    if (!entitlement) {
      return { entitled: false, licenseId: license.id, reason: "no_entitlement" };
    }
    if (!entitlement.active) {
      return {
        entitled: false,
        licenseId: license.id,
        entitlementId: entitlement.id,
        reason: "entitlement_revoked",
      };
    }
    // Free-tier feature "*" acts as a wildcard pass.
    if (entitlement.features.includes("*") || entitlement.features.includes(feature)) {
      return { entitled: true, licenseId: license.id, entitlementId: entitlement.id };
    }
    return {
      entitled: false,
      licenseId: license.id,
      entitlementId: entitlement.id,
      reason: "feature_not_covered",
    };
  }

  /** List licenses with optional filter. */
  listLicenses(filter?: LicenseFilter): License[] {
    let list = [...this.licenses.values()];
    if (filter?.participantId) list = list.filter((l) => l.participantId === filter.participantId);
    if (filter?.listingId) list = list.filter((l) => l.listingId === filter.listingId);
    if (filter?.pricingType) list = list.filter((l) => l.pricingType === filter.pricingType);
    if (filter?.status) list = list.filter((l) => l.status === filter.status);
    list = list.sort((a, b) => b.startDate.localeCompare(a.startDate));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  /** List purchase intents with optional filter. */
  listPurchaseIntents(filter?: PurchaseIntentFilter): PurchaseIntent[] {
    let list = [...this.intents.values()];
    if (filter?.listingId) list = list.filter((i) => i.listingId === filter.listingId);
    if (filter?.participantId) list = list.filter((i) => i.participantId === filter.participantId);
    if (filter?.pricingType) list = list.filter((i) => i.pricingType === filter.pricingType);
    if (filter?.status) list = list.filter((i) => i.status === filter.status);
    if (filter?.since) list = list.filter((i) => i.createdAt >= filter.since!);
    if (filter?.until) list = list.filter((i) => i.createdAt <= filter.until!);
    list = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  /**
   * Sweep expired licenses — flips any license past its endDate to "expired"
   * and revokes its entitlement. Designed to be called by the kernel
   * scheduler on a regular cadence (e.g. hourly).
   * Returns the count of licenses transitioned to expired.
   */
  expireLicenses(): { expired: number; revokedEntitlements: number } {
    const now = getClock().epochMs();
    let expired = 0;
    let revokedEntitlements = 0;
    for (const [id, license] of this.licenses) {
      if (license.status !== "active" && license.status !== "trial") continue;
      if (!license.endDate) continue;
      const endMs = new Date(license.endDate).getTime();
      if (!Number.isFinite(endMs) || endMs > now) continue;
      const updated: MutableLicense = { ...license, status: "expired" };
      this.licenses.set(id, updated);
      expired += 1;
      if (license.entitlementId) {
        const ent = this.entitlements.get(license.entitlementId);
        if (ent && ent.active) {
          const updatedEnt: MutableEntitlement = {
            ...ent,
            active: false,
            revokedAt: getClock().iso(),
          };
          this.entitlements.set(license.entitlementId, updatedEnt);
          revokedEntitlements += 1;
          void getEventBus().publish(
            buildEvent(
              MARKETPLACE_EVENTS.entitlementRevoked,
              {
                entitlementId: updatedEnt.id,
                licenseId: id,
                listingId: license.listingId,
                participantId: license.participantId,
                reason: "license_expired",
              },
              {
                actor: { kind: "system", id: "monetization-manager" },
                partitionKey: license.participantId as string,
              },
              "scheduled",
            ),
          );
        }
      }
    }
    return { expired, revokedEntitlements };
  }

  /** Aggregate monetization stats. */
  getStats(): MonetizationStats {
    const intents = [...this.intents.values()];
    const licenses = [...this.licenses.values()];
    const entitlements = [...this.entitlements.values()];
    const intentsByPricingType: Record<string, number> = {};
    const licensesByPricingType: Record<string, number> = {};
    let gross = 0;
    let refunded = 0;
    for (const i of intents) {
      intentsByPricingType[i.pricingType] = (intentsByPricingType[i.pricingType] ?? 0) + 1;
      if (i.status === "confirmed") gross += i.amount;
      if (i.status === "refunded") refunded += i.amount;
    }
    for (const l of licenses) {
      licensesByPricingType[l.pricingType] = (licensesByPricingType[l.pricingType] ?? 0) + 1;
    }
    return {
      totalIntents: intents.length,
      pendingIntents: intents.filter((i) => i.status === "pending").length,
      confirmedIntents: intents.filter((i) => i.status === "confirmed").length,
      failedIntents: intents.filter((i) => i.status === "failed").length,
      refundedIntents: intents.filter((i) => i.status === "refunded").length,
      activeLicenses: licenses.filter((l) => l.status === "active").length,
      trialLicenses: licenses.filter((l) => l.status === "trial").length,
      expiredLicenses: licenses.filter((l) => l.status === "expired").length,
      revokedLicenses: licenses.filter((l) => l.status === "revoked").length,
      cancelledLicenses: licenses.filter((l) => l.status === "cancelled").length,
      totalEntitlements: entitlements.length,
      activeEntitlements: entitlements.filter((e) => e.active).length,
      revokedEntitlements: entitlements.filter((e) => !e.active).length,
      intentsByPricingType,
      licensesByPricingType,
      totalGrossAmount: gross,
      totalRefundedAmount: refunded,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private requireIntent(id: PurchaseIntentId): MutablePurchaseIntent {
    const intent = this.intents.get(id);
    if (!intent) {
      throw new MarketplaceError({
        code: "eks.marketplace.purchase.intent_not_found",
        category: "not_found",
        message: `Purchase intent ${id} not found.`,
        userMessage: "Purchase intent not found.",
      });
    }
    return intent;
  }

  private findLicenseByEntitlement(entitlementId: EntitlementId): MutableLicense | undefined {
    for (const license of this.licenses.values()) {
      if (license.entitlementId === entitlementId) return license;
    }
    return undefined;
  }

  private participantListingKey(participantId: AccountId, listingId: ListingId): string {
    return `${participantId as string}|${listingId as string}`;
  }

  private computeEndDate(pricingType: PricingType, trialDays?: number): string | undefined {
    const now = getClock().now();
    // Free + one-time don't have a natural end date.
    if (pricingType === "free" || pricingType === "one_time") {
      if (trialDays && trialDays > 0) {
        const d = new Date(now);
        d.setDate(d.getDate() + trialDays);
        return d.toISOString();
      }
      return undefined;
    }
    // Subscription/freemium/etc → end in 1 period (default monthly).
    const d = new Date(now);
    d.setMonth(d.getMonth() + 1);
    return d.toISOString();
  }

  private computeTrialEndDate(trialDays: number): string {
    const d = getClock().now();
    d.setDate(d.getDate() + trialDays);
    return d.toISOString();
  }

  private defaultFeaturesFor(pricingType: PricingType): string[] {
    switch (pricingType) {
      case "free":
        return ["*"]; // wildcard — covers all features in the free tier
      case "subscription":
      case "freemium":
      case "premium_ai":
      case "premium_content":
      case "marketplace_bundle":
        return ["*"];
      case "one_time":
        return ["*"];
      case "enterprise_licensing":
      case "government_licensing":
      case "employer_licensing":
        return ["*"];
      case "consumables":
      case "measurement_package":
        return ["*"];
      default:
        return ["*"];
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: MonetizationManager | null = null;
export function getMonetization(): MonetizationManager {
  if (!_mgr) _mgr = new MonetizationManager();
  return _mgr;
}
export function resetMonetization(): void {
  _mgr = null;
}

// Re-exports for convenience
export type {
  AccountId,
  Entitlement,
  EntitlementId,
  License,
  LicenseId,
  ListingId,
  PricingType,
  PurchaseIntent,
  PurchaseIntentId,
} from "../core";
