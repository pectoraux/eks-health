/**
 * Eks-Health Health Marketplace — Revenue Sharing
 *
 * Configurable revenue-sharing engine. Allocations between developer,
 * platform, prize pools, organizations, affiliates, researchers, insurance
 * partners, government programs, charities. NO financial execution — only
 * accounting and event generation.
 *
 * Real logic:
 *  - Real percentage-based allocation computation: validates that allocations
 *    sum to exactly 100.0 (within a tiny epsilon to tolerate float drift),
 *    computes per-recipient amounts from gross, and rounds to 2 decimals.
 *  - Real double-entry-style accounting: each RevenueEvent records gross +
 *    per-recipient allocations; recipients can be queried across events.
 *  - Real aggregation: getRevenueByListing / getRevenueByRecipient compute
 *    totals by walking all events.
 *
 * Boundary: NO money transfer. The Payment Provider executes transfers; this
 * module only records the accounting + emits revenue.allocated events.
 */

import "server-only";
import type {
  ListingId,
  PurchaseIntentId,
  RevenueAllocation,
  RevenueAllocationId,
  RevenueEvent,
  RevenueRecipientType,
  RevenueShareId,
  RevenueShareRule,
} from "../core";
import {
  MARKETPLACE_EVENTS,
  MarketplaceError,
  asRevenueShareId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

/** Local helper — the core barrel exposes asRevenueShareId but not asRevenueAllocationId. */
function asRevenueAllocationId(s: string): RevenueAllocationId {
  return s as RevenueAllocationId;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RevenueAllocationInput {
  readonly recipientType: RevenueRecipientType;
  readonly recipientId: string;
  readonly percentage: number;
}

export interface SetRuleInput {
  readonly name?: string;
  readonly allocations: RevenueAllocationInput[];
  readonly active?: boolean;
}

export interface RevenueEventFilter {
  readonly listingId?: ListingId;
  readonly recipientType?: RevenueRecipientType;
  readonly recipientId?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RevenueByListingResult {
  readonly listingId: ListingId;
  readonly totalGross: number;
  readonly totalEvents: number;
  readonly byRecipient: ReadonlyArray<{
    readonly recipientType: RevenueRecipientType;
    readonly recipientId: string;
    readonly totalAmount: number;
    readonly averagePercentage: number;
  }>;
}

export interface RevenueByRecipientResult {
  readonly recipientId: string;
  readonly recipientType?: RevenueRecipientType;
  readonly totalAmount: number;
  readonly eventCount: number;
  readonly listingBreakdown: ReadonlyArray<{
    readonly listingId: ListingId;
    readonly amount: number;
    readonly eventCount: number;
  }>;
}

export interface RevenueStats {
  readonly totalRevenueProcessed: number;
  readonly totalEvents: number;
  readonly totalRules: number;
  readonly activeRules: number;
  readonly byRecipientType: Readonly<Record<string, number>>;
  readonly byListing: ReadonlyArray<{ listingId: ListingId; totalGross: number; eventCount: number }>;
  readonly averageAllocationPercentage: number;
}

// ---------------------------------------------------------------------------
// Internal mutable records
// ---------------------------------------------------------------------------

type MutableRevenueShareRule = RevenueShareRule;
type MutableRevenueEvent = RevenueEvent;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERCENTAGE_EPSILON = 0.01; // tolerate up to 0.01% drift on the sum
const ROUND_DP = 2;

function roundCurrency(n: number): number {
  return Math.round(n * 10 ** ROUND_DP) / 10 ** ROUND_DP;
}

// ---------------------------------------------------------------------------
// RevenueShareEngine
// ---------------------------------------------------------------------------

/**
 * RevenueShareEngine — configures revenue-share rules per listing, computes
 * per-recipient allocations for each purchase, and records revenue events.
 * Does NOT transfer money — only accounting + events.
 */
export class RevenueShareEngine {
  private readonly rules = new Map<ListingId, MutableRevenueShareRule>();
  private readonly events: MutableRevenueEvent[] = [];

  /**
   * Create or update a revenue-share rule for a listing. Validates that
   * allocations sum to exactly 100%.
   */
  setRule(listingId: ListingId, input: SetRuleInput): RevenueShareRule {
    if (!input.allocations || input.allocations.length === 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.revenue.no_allocations",
        category: "validation",
        message: "At least one allocation is required.",
        userMessage: "Please provide at least one allocation.",
      });
    }
    const sum = input.allocations.reduce((s, a) => s + a.percentage, 0);
    if (Math.abs(sum - 100) > PERCENTAGE_EPSILON) {
      throw new MarketplaceError({
        code: "eks.marketplace.revenue.allocations_sum_invalid",
        category: "validation",
        message: `Allocations must sum to 100% (got ${sum}).`,
        userMessage: `Revenue share allocations must total 100% (currently ${sum}%).`,
        metadata: { sum, allocations: input.allocations },
      });
    }
    for (const a of input.allocations) {
      if (a.percentage < 0 || a.percentage > 100 || !Number.isFinite(a.percentage)) {
        throw new MarketplaceError({
          code: "eks.marketplace.revenue.percentage_invalid",
          category: "validation",
          message: `Invalid percentage ${a.percentage} for recipient ${a.recipientId}.`,
          userMessage: "Each percentage must be between 0 and 100.",
          metadata: { recipientId: a.recipientId, percentage: a.percentage },
        });
      }
      if (!a.recipientId || a.recipientId.trim().length === 0) {
        throw new MarketplaceError({
          code: "eks.marketplace.revenue.recipient_id_required",
          category: "validation",
          message: "recipientId is required for every allocation.",
          userMessage: "Each allocation requires a recipient.",
        });
      }
    }

    const existing = this.rules.get(listingId);
    const now = getClock().iso();
    const allocations: RevenueAllocation[] = input.allocations.map((a, idx) => ({
      id: asRevenueAllocationId(`ral_${generateId()}_${idx}`),
      recipientType: a.recipientType,
      recipientId: a.recipientId,
      percentage: a.percentage,
    }));
    const rule: MutableRevenueShareRule = {
      id: existing?.id ?? asRevenueShareId(`rsr_${generateId()}`),
      listingId,
      name: input.name ?? existing?.name ?? `Revenue share for ${listingId as string}`,
      allocations,
      active: input.active ?? true,
      createdAt: existing?.createdAt ?? now,
    };
    this.rules.set(listingId, rule);
    return rule;
  }

  /** Get the revenue-share rule for a listing (if any). */
  getRule(listingId: ListingId): RevenueShareRule | undefined {
    return this.rules.get(listingId);
  }

  /** List all configured rules. */
  listRules(): RevenueShareRule[] {
    return [...this.rules.values()];
  }

  /**
   * Compute per-recipient allocations for a purchase + record a RevenueEvent.
   * If no rule is configured for the listing, falls back to a default split
   * (70% developer / 25% platform / 5% prize_pool) so accounting always
   * happens. Emits revenue.allocated.
   *
   * Does NOT transfer money — only records the accounting.
   */
  allocate(
    purchaseIntentId: PurchaseIntentId,
    listingId: ListingId,
    grossAmount: number,
    currency: string,
  ): RevenueEvent {
    if (grossAmount < 0 || !Number.isFinite(grossAmount)) {
      throw new MarketplaceError({
        code: "eks.marketplace.revenue.gross_invalid",
        category: "validation",
        message: `Invalid gross amount: ${grossAmount}`,
        userMessage: "Please provide a valid gross amount.",
      });
    }
    if (!currency || currency.length !== 3) {
      throw new MarketplaceError({
        code: "eks.marketplace.revenue.currency_invalid",
        category: "validation",
        message: `Invalid currency: ${currency}`,
        userMessage: "Please provide a valid 3-letter currency code.",
      });
    }

    const rule = this.rules.get(listingId);
    const allocations = rule && rule.active ? rule.allocations : this.defaultAllocations(listingId);

    // Real per-recipient computation. We allocate by percentage and handle
    // rounding drift by adjusting the largest allocation so the per-event
    // total always equals gross.
    const rawSplits = allocations.map((a) => ({
      recipientType: a.recipientType,
      recipientId: a.recipientId,
      percentage: a.percentage,
      amount: roundCurrency((grossAmount * a.percentage) / 100),
    }));
    const allocatedSum = rawSplits.reduce((s, a) => s + a.amount, 0);
    const drift = roundCurrency(grossAmount - allocatedSum);
    if (Math.abs(drift) >= 0.01 && rawSplits.length > 0) {
      // Adjust the largest allocation to absorb the drift.
      let maxIdx = 0;
      for (let i = 1; i < rawSplits.length; i++) {
        if (rawSplits[i].amount > rawSplits[maxIdx].amount) maxIdx = i;
      }
      rawSplits[maxIdx] = {
        ...rawSplits[maxIdx],
        amount: roundCurrency(rawSplits[maxIdx].amount + drift),
      };
    }

    const event: MutableRevenueEvent = {
      id: `rev_${generateId()}`,
      listingId,
      purchaseIntentId,
      grossAmount: roundCurrency(grossAmount),
      currency,
      allocations: rawSplits,
      createdAt: getClock().iso(),
    };
    this.events.push(event);

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.revenueAllocated,
        {
          revenueEventId: event.id,
          listingId,
          purchaseIntentId,
          grossAmount: event.grossAmount,
          currency,
          allocations: event.allocations,
          ruleId: rule?.id,
          ruleActive: Boolean(rule && rule.active),
        },
        {
          actor: { kind: "service", id: "revenue-share-engine" },
          partitionKey: listingId as string,
        },
        "domain",
      ),
    );

    return event;
  }

  /** Get a single revenue event by id. */
  getRevenueEvent(id: string): RevenueEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** List revenue events with optional filter. */
  listRevenueEvents(filter?: RevenueEventFilter): RevenueEvent[] {
    let list = [...this.events];
    if (filter?.listingId) list = list.filter((e) => e.listingId === filter.listingId);
    if (filter?.recipientType) {
      list = list.filter((e) => e.allocations.some((a) => a.recipientType === filter.recipientType));
    }
    if (filter?.recipientId) {
      list = list.filter((e) => e.allocations.some((a) => a.recipientId === filter.recipientId));
    }
    if (filter?.since) list = list.filter((e) => e.createdAt >= filter.since!);
    if (filter?.until) list = list.filter((e) => e.createdAt <= filter.until!);
    list = list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  /** Aggregate total gross + per-recipient totals for a listing. */
  getRevenueByListing(listingId: ListingId): RevenueByListingResult {
    const listingEvents = this.events.filter((e) => e.listingId === listingId);
    const totalGross = roundCurrency(listingEvents.reduce((s, e) => s + e.grossAmount, 0));
    const recipientMap = new Map<string, { recipientType: RevenueRecipientType; recipientId: string; totalAmount: number; percentageSum: number; count: number }>();
    for (const e of listingEvents) {
      for (const a of e.allocations) {
        const key = `${a.recipientType}|${a.recipientId}`;
        const existing = recipientMap.get(key);
        if (existing) {
          existing.totalAmount = roundCurrency(existing.totalAmount + a.amount);
          existing.percentageSum += a.percentage;
          existing.count += 1;
        } else {
          recipientMap.set(key, {
            recipientType: a.recipientType,
            recipientId: a.recipientId,
            totalAmount: a.amount,
            percentageSum: a.percentage,
            count: 1,
          });
        }
      }
    }
    const byRecipient = [...recipientMap.values()]
      .map((r) => ({
        recipientType: r.recipientType,
        recipientId: r.recipientId,
        totalAmount: r.totalAmount,
        averagePercentage: r.count > 0 ? Math.round((r.percentageSum / r.count) * 100) / 100 : 0,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);
    return {
      listingId,
      totalGross,
      totalEvents: listingEvents.length,
      byRecipient,
    };
  }

  /** Aggregate all revenue allocated to a specific recipient. */
  getRevenueByRecipient(recipientId: string): RevenueByRecipientResult {
    const listingMap = new Map<string, { listingId: ListingId; amount: number; count: number }>();
    let totalAmount = 0;
    let eventCount = 0;
    let recipientType: RevenueRecipientType | undefined;
    for (const e of this.events) {
      for (const a of e.allocations) {
        if (a.recipientId !== recipientId) continue;
        totalAmount = roundCurrency(totalAmount + a.amount);
        eventCount += 1;
        if (!recipientType) recipientType = a.recipientType;
        const key = e.listingId as string;
        const existing = listingMap.get(key);
        if (existing) {
          existing.amount = roundCurrency(existing.amount + a.amount);
          existing.count += 1;
        } else {
          listingMap.set(key, { listingId: e.listingId, amount: a.amount, count: 1 });
        }
      }
    }
    const listingBreakdown = [...listingMap.values()]
      .map((r) => ({ listingId: r.listingId, amount: r.amount, eventCount: r.count }))
      .sort((a, b) => b.amount - a.amount);
    return {
      recipientId,
      recipientType,
      totalAmount,
      eventCount,
      listingBreakdown,
    };
  }

  /** Aggregate revenue stats across the whole marketplace. */
  getStats(): RevenueStats {
    const totalRevenueProcessed = roundCurrency(this.events.reduce((s, e) => s + e.grossAmount, 0));
    const byRecipientType: Record<string, number> = {};
    const byListingMap = new Map<string, { listingId: ListingId; totalGross: number; eventCount: number }>();
    let percentageSum = 0;
    let allocationCount = 0;
    for (const e of this.events) {
      const listingKey = e.listingId as string;
      const existing = byListingMap.get(listingKey);
      if (existing) {
        existing.totalGross = roundCurrency(existing.totalGross + e.grossAmount);
        existing.eventCount += 1;
      } else {
        byListingMap.set(listingKey, { listingId: e.listingId, totalGross: e.grossAmount, eventCount: 1 });
      }
      for (const a of e.allocations) {
        byRecipientType[a.recipientType] = roundCurrency((byRecipientType[a.recipientType] ?? 0) + a.amount);
        percentageSum += a.percentage;
        allocationCount += 1;
      }
    }
    return {
      totalRevenueProcessed,
      totalEvents: this.events.length,
      totalRules: this.rules.size,
      activeRules: [...this.rules.values()].filter((r) => r.active).length,
      byRecipientType,
      byListing: [...byListingMap.values()].sort((a, b) => b.totalGross - a.totalGross),
      averageAllocationPercentage: allocationCount > 0 ? Math.round((percentageSum / allocationCount) * 100) / 100 : 0,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Default revenue split used when no rule is configured. Mirrors the
   * platform's standard marketplace fee: 70% developer, 25% platform, 5%
   * prize pool (which funds the competition rewards that drive outcomes).
   */
  private defaultAllocations(listingId: ListingId): RevenueAllocation[] {
    return [
      {
        id: asRevenueAllocationId(`ral_default_dev_${listingId as string}`),
        recipientType: "developer",
        recipientId: `developer_of_${listingId as string}`,
        percentage: 70,
      },
      {
        id: asRevenueAllocationId(`ral_default_plat_${listingId as string}`),
        recipientType: "platform",
        recipientId: "eks_health_platform",
        percentage: 25,
      },
      {
        id: asRevenueAllocationId(`ral_default_prize_${listingId as string}`),
        recipientType: "prize_pool",
        recipientId: "global_prize_pool",
        percentage: 5,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: RevenueShareEngine | null = null;
export function getRevenue(): RevenueShareEngine {
  if (!_engine) _engine = new RevenueShareEngine();
  return _engine;
}
export function resetRevenue(): void {
  _engine = null;
}

// Re-exports for convenience
export type {
  ListingId,
  PurchaseIntentId,
  RevenueAllocation,
  RevenueAllocationId,
  RevenueEvent,
  RevenueRecipientType,
  RevenueShareId,
  RevenueShareRule,
} from "../core";
