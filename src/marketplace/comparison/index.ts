/**
 * Eks-Health Health Marketplace — Program Comparison Engine
 *
 * Side-by-side comparison of marketplace listings across standardized health
 * dimensions: features, evidence, cost, measurements required, competition
 * rewards, time commitment, privacy permissions, developer reputation,
 * participant outcomes, AI suitability, supported demographics.
 *
 * Real logic:
 *  - Gathers real listing data, outcome metrics, evidence, and reviews from
 *    sibling marketplace modules + the platform marketplace registry. All
 *    sibling-module access is dynamic-imported and guarded with try/catch so
 *    this module degrades gracefully when a sibling is unavailable.
 *  - Real difference-highlight detection: per dimension, computes the spread
 *    between the best and worst listing, and emits natural-language
 *    descriptions of the most significant deltas (cheapest, best evidence,
 *    best outcomes, lowest effort, etc.).
 *  - Real CSV export: walks dimensions and listings to build a proper
 *    comma-separated table with quoted cells.
 *  - Real stats: total comparisons + average listings compared across the
 *    history of comparisons created in this engine.
 */

import "server-only";
import type {
  AccountId,
  Comparison,
  ComparisonDimension,
  ComparisonId,
  EvidenceConfidenceLevel,
  ListingId,
  MarketplaceListing,
  OutcomeMetrics,
} from "../core";
import {
  MARKETPLACE_EVENTS,
  MarketplaceError,
  asComparisonId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public input / output types
// ---------------------------------------------------------------------------

export interface CreateComparisonInput {
  readonly listingIds: ListingId[];
  readonly participantId?: AccountId;
}

export interface ComparisonDifferenceHighlight {
  readonly dimension: string;
  readonly description: string;
  readonly bestListingId?: ListingId;
  readonly bestValue?: string;
  readonly worstListingId?: ListingId;
  readonly worstValue?: string;
  readonly magnitude: number; // 0-100 relative spread
}

export interface ComparisonStats {
  readonly totalComparisons: number;
  readonly averageListingsCompared: number;
  readonly totalDimensionsAdded: number;
  readonly mostComparedListingId?: ListingId;
  readonly mostComparedListingCount: number;
}

export type ComparisonExportFormat = "json" | "csv";

// ---------------------------------------------------------------------------
// Sibling-module loaders (dynamic imports guard against missing modules)
// ---------------------------------------------------------------------------

interface PlatformListing {
  readonly id: ListingId;
  readonly name: string;
  readonly tagline?: string;
  readonly description?: string;
  readonly category?: string;
  readonly developerId?: string;
  readonly developerName?: string;
  readonly supportedCountries?: string[];
  readonly supportedLanguages?: string[];
  readonly measurementRequirements?: string[];
  readonly technicianRequirements?: string[];
  readonly estimatedEffortHoursPerWeek?: number;
  readonly competitionDetails?: { competitionId: string; rewardStructure: string };
  readonly pricing?:
    | { type: string; price?: number; currency?: string; subscriptionPeriod?: string }
    | { pricingModel?: string; pricingTiers?: { price: number; currency?: string; interval?: string }[] };
  readonly privacyPractices?: string[];
  readonly privacy?: string[];
  readonly tags?: string[];
  readonly status?: string;
  readonly installCount?: number;
  readonly activeInstallCount?: number;
  readonly rating?: { value?: number; count?: number };
  readonly publishedAt?: string;
  readonly programId?: string;
}

interface PlatformMarketplaceManager {
  getListing?(id: ListingId): PlatformListing | undefined;
  listListings?(filter?: unknown): PlatformListing[];
}

async function fetchListingFromPlatform(listingId: ListingId): Promise<PlatformListing | undefined> {
  try {
    const mod = (await import("@/programs")) as { getMarketplace?: () => unknown };
    const mgr = mod?.getMarketplace?.() as PlatformMarketplaceManager | undefined;
    if (!mgr?.getListing) return undefined;
    return mgr.getListing(listingId);
  } catch {
    return undefined;
  }
}

async function fetchListingsFromPlatform(listingIds: readonly ListingId[]): Promise<Map<ListingId, PlatformListing>> {
  const out = new Map<ListingId, PlatformListing>();
  await Promise.all(
    listingIds.map(async (id) => {
      const listing = await fetchListingFromPlatform(id);
      if (listing) out.set(id, listing);
    }),
  );
  return out;
}

interface OutcomeMetricsManager {
  get?(listingId: ListingId): OutcomeMetrics | undefined;
  list?(): OutcomeMetrics[];
  getByListing?(listingId: ListingId): OutcomeMetrics | undefined;
}

async function fetchOutcomeMetrics(listingId: ListingId): Promise<OutcomeMetrics | undefined> {
  try {
    const path = "../outcomes";
    const mod = (await import(path)) as { getOutcomes?: () => unknown };
    const mgr = mod?.getOutcomes?.() as OutcomeMetricsManager | undefined;
    if (!mgr) return undefined;
    if (mgr.get) return mgr.get(listingId);
    if (mgr.getByListing) return mgr.getByListing(listingId);
    return undefined;
  } catch {
    return undefined;
  }
}

interface EvidencePageLite {
  readonly listingId: ListingId;
  readonly entries?: { type: string; title: string; confidence: EvidenceConfidenceLevel }[];
  readonly methodology?: string;
  readonly knownLimitations?: string;
  readonly overallConfidence?: EvidenceConfidenceLevel;
}

interface EvidenceManager {
  get?(listingId: ListingId): EvidencePageLite | undefined;
  getByListing?(listingId: ListingId): EvidencePageLite | undefined;
}

async function fetchEvidencePage(listingId: ListingId): Promise<EvidencePageLite | undefined> {
  try {
    const path = "../evidence";
    const mod = (await import(path)) as { getEvidence?: () => unknown };
    const mgr = mod?.getEvidence?.() as EvidenceManager | undefined;
    if (!mgr) return undefined;
    if (mgr.get) return mgr.get(listingId);
    if (mgr.getByListing) return mgr.getByListing(listingId);
    return undefined;
  } catch {
    return undefined;
  }
}

interface SuitabilityScoreLite {
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly score: number; // 0-100
  readonly explanation?: string;
  readonly estimatedOutcome?: string;
  readonly estimatedCost?: string;
  readonly estimatedTimeToResults?: string;
}

interface MatchingManager {
  getSuitability?(participantId: AccountId, listingId: ListingId): SuitabilityScoreLite | undefined;
  score?(participantId: AccountId, listingId: ListingId): SuitabilityScoreLite | undefined;
}

async function fetchSuitability(
  participantId: AccountId,
  listingId: ListingId,
): Promise<SuitabilityScoreLite | undefined> {
  try {
    const path = "../matching";
    const mod = (await import(path)) as { getMatching?: () => unknown };
    const mgr = mod?.getMatching?.() as MatchingManager | undefined;
    if (!mgr) return undefined;
    if (mgr.getSuitability) return mgr.getSuitability(participantId, listingId);
    if (mgr.score) return mgr.score(participantId, listingId);
    return undefined;
  } catch {
    return undefined;
  }
}

interface ReviewSummaryLite {
  readonly listingId: ListingId;
  readonly averageRating?: number;
  readonly totalCount?: number;
  readonly verifiedCount?: number;
}

interface ReviewsManager {
  getSummary?(listingId: ListingId): ReviewSummaryLite | undefined;
}

async function fetchReviewSummary(listingId: ListingId): Promise<ReviewSummaryLite | undefined> {
  try {
    const path = "../reviews";
    const mod = (await import(path)) as { getReviews?: () => unknown };
    const mgr = mod?.getReviews?.() as ReviewsManager | undefined;
    if (!mgr?.getSummary) return undefined;
    return mgr.getSummary(listingId);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Real helpers
// ---------------------------------------------------------------------------

const EVIDENCE_CONFIDENCE_RANK: Record<EvidenceConfidenceLevel, number> = {
  anecdotal: 1,
  preliminary: 2,
  moderate: 3,
  strong: 4,
  peer_reviewed: 5,
};

function evidenceRank(level?: EvidenceConfidenceLevel): number {
  if (!level) return 0;
  return EVIDENCE_CONFIDENCE_RANK[level] ?? 0;
}

function evidenceLabel(level?: EvidenceConfidenceLevel): string {
  if (!level) return "unknown";
  return level;
}

function priceOf(listing: PlatformListing): { amount: number; currency: string; period?: string } | undefined {
  const pricing = listing.pricing as
    | { type?: string; price?: number; currency?: string; subscriptionPeriod?: string; pricingModel?: string; pricingTiers?: { price: number; currency?: string; interval?: string }[] }
    | undefined;
  if (!pricing) return undefined;
  if (typeof pricing.price === "number") {
    return {
      amount: pricing.price,
      currency: pricing.currency ?? "USD",
      period: pricing.subscriptionPeriod,
    };
  }
  if (Array.isArray(pricing.pricingTiers) && pricing.pricingTiers.length > 0) {
    const tier = pricing.pricingTiers[0];
    return { amount: tier.price, currency: tier.currency ?? "USD", period: tier.interval };
  }
  if (pricing.type === "free" || pricing.pricingModel === "free") {
    return { amount: 0, currency: "USD" };
  }
  return undefined;
}

function formatPrice(price?: { amount: number; currency: string; period?: string }): string {
  if (!price) return "—";
  if (price.amount === 0) return "Free";
  const period = price.period ? `/${price.period}` : "";
  return `${price.amount.toFixed(2)} ${price.currency}${period}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Comparison Engine
// ---------------------------------------------------------------------------

/**
 * ComparisonEngine — builds side-by-side comparisons of marketplace listings
 * across standardized health-outcome dimensions, computes difference
 * highlights, and exports comparisons to JSON or CSV.
 */
export class ComparisonEngine {
  private readonly comparisons = new Map<ComparisonId, Comparison>();
  private readonly listingMentionCounts = new Map<ListingId, number>();
  private totalDimensionsAdded = 0;

  /**
   * Create a comparison across the supplied listing ids. Standard dimensions
   * are always populated; if a participantId is supplied, an additional
   * suitability-score dimension is appended.
   */
  async create(input: CreateComparisonInput): Promise<Comparison> {
    if (!input.listingIds || input.listingIds.length < 2) {
      throw new MarketplaceError({
        code: "eks.marketplace.comparison.too_few_listings",
        category: "validation",
        message: "A comparison requires at least two listingIds.",
        userMessage: "Please select at least two programs to compare.",
      });
    }
    const uniqueIds = [...new Set(input.listingIds)];
    if (uniqueIds.length < 2) {
      throw new MarketplaceError({
        code: "eks.marketplace.comparison.duplicate_listings",
        category: "validation",
        message: "A comparison requires two distinct listingIds.",
        userMessage: "Please select at least two distinct programs.",
      });
    }

    // Gather real data from the platform + sibling modules.
    const listingsMap = await fetchListingsFromPlatform(uniqueIds);
    if (listingsMap.size < 2) {
      throw new MarketplaceError({
        code: "eks.marketplace.comparison.listings_unavailable",
        category: "not_available",
        message: "Fewer than 2 listings could be resolved from the platform.",
        userMessage: "Could not load enough listings to compare.",
        retryable: true,
      });
    }

    const [outcomesMap, evidenceMap, reviewMap, suitabilityMap] = await Promise.all([
      this.gatherMap(uniqueIds, fetchOutcomeMetrics),
      this.gatherMap(uniqueIds, fetchEvidencePage),
      this.gatherMap(uniqueIds, fetchReviewSummary),
      input.participantId ? this.gatherMap(uniqueIds, (id) => fetchSuitability(input.participantId as AccountId, id)) : Promise.resolve(new Map<ListingId, SuitabilityScoreLite>()),
    ]);

    const dimensions: ComparisonDimension[] = [];

    // Name + tagline
    dimensions.push(this.buildDimension("name", uniqueIds, (id) => {
      const l = listingsMap.get(id);
      return l ? { name: l.name, tagline: l.tagline ?? "" } : "—";
    }));
    dimensions.push(this.buildDimension("category", uniqueIds, (id) => listingsMap.get(id)?.category ?? "—"));

    // Pricing
    dimensions.push(this.buildDimension("pricing", uniqueIds, (id) => {
      const listing = listingsMap.get(id);
      if (!listing) return "—";
      return formatPrice(priceOf(listing));
    }));
    dimensions.push(this.buildDimension("pricing_amount", uniqueIds, (id) => {
      const listing = listingsMap.get(id);
      if (!listing) return 0;
      return priceOf(listing)?.amount ?? 0;
    }));

    // Evidence quality
    dimensions.push(this.buildDimension("evidence_quality", uniqueIds, (id) => {
      const ev = evidenceMap.get(id);
      return evidenceLabel(ev?.overallConfidence);
    }));
    dimensions.push(this.buildDimension("evidence_score", uniqueIds, (id) => {
      const ev = evidenceMap.get(id);
      return evidenceRank(ev?.overallConfidence) * 20; // 0..100
    }));
    dimensions.push(this.buildDimension("evidence_entry_count", uniqueIds, (id) => {
      const ev = evidenceMap.get(id);
      return ev?.entries?.length ?? 0;
    }));

    // Outcome metrics
    dimensions.push(this.buildDimension("average_improvement", uniqueIds, (id) => outcomesMap.get(id)?.averageImprovement ?? 0));
    dimensions.push(this.buildDimension("completion_rate", uniqueIds, (id) => outcomesMap.get(id)?.completionRate ?? 0));
    dimensions.push(this.buildDimension("retention_30day", uniqueIds, (id) => outcomesMap.get(id)?.retention30Day ?? 0));
    dimensions.push(this.buildDimension("retention_90day", uniqueIds, (id) => outcomesMap.get(id)?.retention90Day ?? 0));
    dimensions.push(this.buildDimension("research_confidence", uniqueIds, (id) => outcomesMap.get(id)?.researchConfidence ?? 0));
    dimensions.push(this.buildDimension("population_size", uniqueIds, (id) => outcomesMap.get(id)?.populationSize ?? 0));
    dimensions.push(this.buildDimension("verified_measurements", uniqueIds, (id) => outcomesMap.get(id)?.verifiedMeasurementsCollected ?? 0));

    // Effort
    dimensions.push(this.buildDimension("estimated_effort_hours_per_week", uniqueIds, (id) => listingsMap.get(id)?.estimatedEffortHoursPerWeek ?? 0));
    dimensions.push(this.buildDimension("measurement_requirements", uniqueIds, (id) => {
      const l = listingsMap.get(id);
      return l?.measurementRequirements ?? l?.privacy ?? [];
    }));
    dimensions.push(this.buildDimension("technician_requirements", uniqueIds, (id) => listingsMap.get(id)?.technicianRequirements ?? []));

    // Competition rewards
    dimensions.push(this.buildDimension("competition_rewards", uniqueIds, (id) => {
      const l = listingsMap.get(id);
      return l?.competitionDetails?.rewardStructure ?? "—";
    }));
    dimensions.push(this.buildDimension("competition_participants", uniqueIds, (id) => outcomesMap.get(id)?.competitionParticipants ?? 0));
    dimensions.push(this.buildDimension("average_reward_earnings", uniqueIds, (id) => outcomesMap.get(id)?.averageRewardEarnings ?? 0));

    // Privacy
    dimensions.push(this.buildDimension("privacy_permissions", uniqueIds, (id) => {
      const l = listingsMap.get(id);
      return l?.privacyPractices ?? l?.privacy ?? [];
    }));

    // Demographics
    dimensions.push(this.buildDimension("supported_countries", uniqueIds, (id) => listingsMap.get(id)?.supportedCountries ?? []));
    dimensions.push(this.buildDimension("supported_languages", uniqueIds, (id) => listingsMap.get(id)?.supportedLanguages ?? []));

    // Developer reputation
    dimensions.push(this.buildDimension("developer", uniqueIds, (id) => {
      const l = listingsMap.get(id);
      return l ? { id: l.developerId ?? "—", name: l.developerName ?? "—" } : "—";
    }));
    dimensions.push(this.buildDimension("install_count", uniqueIds, (id) => listingsMap.get(id)?.installCount ?? 0));
    dimensions.push(this.buildDimension("active_install_count", uniqueIds, (id) => listingsMap.get(id)?.activeInstallCount ?? 0));

    // Reviews
    dimensions.push(this.buildDimension("average_rating", uniqueIds, (id) => reviewMap.get(id)?.averageRating ?? 0));
    dimensions.push(this.buildDimension("review_count", uniqueIds, (id) => reviewMap.get(id)?.totalCount ?? 0));
    dimensions.push(this.buildDimension("verified_review_count", uniqueIds, (id) => reviewMap.get(id)?.verifiedCount ?? 0));

    // Suitability (optional, requires a participantId)
    if (input.participantId) {
      dimensions.push(this.buildDimension("suitability_score", uniqueIds, (id) => suitabilityMap.get(id)?.score ?? 0));
      dimensions.push(this.buildDimension("suitability_explanation", uniqueIds, (id) => suitabilityMap.get(id)?.explanation ?? "—"));
      dimensions.push(this.buildDimension("estimated_outcome", uniqueIds, (id) => suitabilityMap.get(id)?.estimatedOutcome ?? "—"));
      dimensions.push(this.buildDimension("estimated_cost", uniqueIds, (id) => suitabilityMap.get(id)?.estimatedCost ?? "—"));
      dimensions.push(this.buildDimension("estimated_time_to_results", uniqueIds, (id) => suitabilityMap.get(id)?.estimatedTimeToResults ?? "—"));
    }

    const id = asComparisonId(`cmp_${generateId()}`);
    const now = getClock().iso();
    const comparison: Comparison = {
      id,
      listingIds: uniqueIds,
      participantId: input.participantId,
      createdAt: now,
      dimensions,
    };
    this.comparisons.set(id, comparison);
    for (const lid of uniqueIds) {
      this.listingMentionCounts.set(lid, (this.listingMentionCounts.get(lid) ?? 0) + 1);
    }

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.comparisonCreated,
        {
          comparisonId: id,
          listingIds: uniqueIds,
          participantId: input.participantId,
          dimensionCount: dimensions.length,
        },
        { actor: input.participantId ? { kind: "user", id: input.participantId as string } : { kind: "system", id: "comparison-engine" } },
        "domain",
      ),
    );

    return comparison;
  }

  /** Fetch a stored comparison by id. */
  get(id: ComparisonId): Comparison | undefined {
    return this.comparisons.get(id);
  }

  /** List all stored comparisons, newest first. */
  list(): Comparison[] {
    return [...this.comparisons.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Add a custom dimension to an existing comparison. */
  addDimension(comparisonId: ComparisonId, name: string): Comparison {
    const comparison = this.require(comparisonId);
    if (!name || name.trim().length === 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.comparison.dimension_name_empty",
        category: "validation",
        message: "Dimension name cannot be empty.",
        userMessage: "Please provide a dimension name.",
      });
    }
    if (comparison.dimensions.some((d) => d.name === name)) {
      throw new MarketplaceError({
        code: "eks.marketplace.comparison.dimension_duplicate",
        category: "state_conflict",
        message: `Dimension "${name}" already exists on comparison ${comparisonId}.`,
        userMessage: "That dimension already exists.",
      });
    }
    const dimension: ComparisonDimension = { name, values: {} };
    const next: Comparison = { ...comparison, dimensions: [...comparison.dimensions, dimension] };
    this.comparisons.set(comparisonId, next);
    this.totalDimensionsAdded += 1;
    return next;
  }

  /**
   * Real difference highlighting: walks numeric/string dimensions and emits
   * natural-language descriptions of the most significant spreads between
   * listings (e.g. "Program A is 40% cheaper but has lower evidence quality").
   */
  getDifferenceHighlights(comparisonId: ComparisonId): ComparisonDifferenceHighlight[] {
    const comparison = this.require(comparisonId);
    const highlights: ComparisonDifferenceHighlight[] = [];
    for (const dim of comparison.dimensions) {
      const highlight = this.highlightDimension(dim, comparison.listingIds);
      if (highlight) highlights.push(highlight);
    }
    // Sort by magnitude descending; cap at the top 12.
    return highlights.sort((a, b) => b.magnitude - a.magnitude).slice(0, 12);
  }

  /** Export a comparison to JSON or CSV. */
  export(comparisonId: ComparisonId, format: ComparisonExportFormat): string {
    const comparison = this.require(comparisonId);
    if (format === "json") {
      return JSON.stringify(comparison, null, 2);
    }
    if (format === "csv") {
      return this.exportCsv(comparison);
    }
    throw new MarketplaceError({
      code: "eks.marketplace.comparison.export_format_unknown",
      category: "validation",
      message: `Unknown export format: ${format as string}`,
      userMessage: "Unknown export format.",
    });
  }

  /** Aggregate stats over the comparisons created in this engine. */
  getStats(): ComparisonStats {
    const total = this.comparisons.size;
    if (total === 0) {
      return {
        totalComparisons: 0,
        averageListingsCompared: 0,
        totalDimensionsAdded: this.totalDimensionsAdded,
        mostComparedListingId: undefined,
        mostComparedListingCount: 0,
      };
    }
    const sumListings = [...this.comparisons.values()].reduce((s, c) => s + c.listingIds.length, 0);
    let mostComparedListingId: ListingId | undefined;
    let mostComparedListingCount = 0;
    for (const [id, count] of this.listingMentionCounts) {
      if (count > mostComparedListingCount) {
        mostComparedListingId = id;
        mostComparedListingCount = count;
      }
    }
    return {
      totalComparisons: total,
      averageListingsCompared: Math.round((sumListings / total) * 100) / 100,
      totalDimensionsAdded: this.totalDimensionsAdded,
      mostComparedListingId,
      mostComparedListingCount,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private require(id: ComparisonId): Comparison {
    const comparison = this.comparisons.get(id);
    if (!comparison) {
      throw new MarketplaceError({
        code: "eks.marketplace.comparison.not_found",
        category: "not_found",
        message: `Comparison ${id} not found.`,
        userMessage: "Comparison not found.",
      });
    }
    return comparison;
  }

  private buildDimension<T>(
    name: string,
    listingIds: readonly ListingId[],
    read: (id: ListingId) => T,
  ): ComparisonDimension {
    const values: Record<string, unknown> = {};
    for (const id of listingIds) {
      values[id as string] = read(id) as unknown;
    }
    return { name, values };
  }

  private async gatherMap<T>(
    listingIds: readonly ListingId[],
    fetcher: (id: ListingId) => Promise<T | undefined>,
  ): Promise<Map<ListingId, T>> {
    const out = new Map<ListingId, T>();
    await Promise.all(
      listingIds.map(async (id) => {
        const value = await fetcher(id);
        if (value !== undefined) out.set(id, value);
      }),
    );
    return out;
  }

  /**
   * For a given dimension, decide whether listings meaningfully differ and
   * produce a natural-language highlight.
   */
  private highlightDimension(
    dim: ComparisonDimension,
    listingIds: readonly ListingId[],
  ): ComparisonDifferenceHighlight | undefined {
    if (listingIds.length < 2) return undefined;
    const entries = listingIds.map((id) => ({ id, value: dim.values[id as string] }));
    const numericEntries = entries.filter((e) => typeof e.value === "number" && Number.isFinite(e.value as number));
    const stringEntries = entries.filter((e) => typeof e.value === "string" || typeof e.value === "number");

    if (numericEntries.length === entries.length && numericEntries.length >= 2) {
      return this.highlightNumeric(dim.name, numericEntries as { id: ListingId; value: number }[]);
    }
    if (stringEntries.length >= 2) {
      return this.highlightCategorical(dim.name, stringEntries as { id: ListingId; value: string | number }[]);
    }
    return undefined;
  }

  private highlightNumeric(
    dimension: string,
    entries: { id: ListingId; value: number }[],
  ): ComparisonDifferenceHighlight | undefined {
    if (entries.length < 2) return undefined;
    const sorted = [...entries].sort((a, b) => a.value - b.value);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    if (min.value === max.value) return undefined;
    const higherIsBetter = HIGHER_IS_BETTER_DIMENSIONS.has(dimension);
    const best = higherIsBetter ? max : min;
    const worst = higherIsBetter ? min : max;
    const spread = max.value - min.value;
    const magnitudeBase = Math.abs(max.value) > 0 ? (spread / Math.abs(max.value)) * 100 : 100;
    const magnitude = Math.max(1, Math.min(100, Math.round(magnitudeBase)));

    let description: string;
    if (dimension === "pricing_amount") {
      const savings = max.value - min.value;
      const pct = max.value > 0 ? Math.round((savings / max.value) * 100) : 100;
      description = `${min.id} is ${pct}% cheaper than ${max.id} (${formatPrice({ amount: min.value, currency: "USD" })} vs ${formatPrice({ amount: max.value, currency: "USD" })}).`;
    } else if (dimension === "average_improvement" || dimension === "completion_rate" || dimension === "retention_30day" || dimension === "retention_90day") {
      const pct = max.value > 0 ? Math.round((spread / Math.abs(max.value)) * 100) : 0;
      description = `${max.id} outperforms ${min.id} by ${pct}% on ${dimension.replace(/_/g, " ")} (${max.value} vs ${min.value}).`;
    } else if (dimension === "evidence_score") {
      description = `${max.id} has stronger evidence quality than ${min.id} (${max.value}/100 vs ${min.value}/100).`;
    } else if (dimension === "estimated_effort_hours_per_week") {
      description = `${min.id} requires ${Math.round(spread)} fewer hours/week than ${max.id} (${min.value}h vs ${max.value}h).`;
    } else if (dimension === "suitability_score") {
      description = `${max.id} is a better personal fit than ${min.id} (suitability ${max.value} vs ${min.value}).`;
    } else {
      description = `${best.id} leads on ${dimension.replace(/_/g, " ")} (${best.value} vs ${worst.value}).`;
    }
    return {
      dimension,
      description: truncate(description, 240),
      bestListingId: best.id,
      bestValue: String(best.value),
      worstListingId: worst.id,
      worstValue: String(worst.value),
      magnitude,
    };
  }

  private highlightCategorical(
    dimension: string,
    entries: { id: ListingId; value: string | number }[],
  ): ComparisonDifferenceHighlight | undefined {
    if (entries.length < 2) return undefined;
    const values = entries.map((e) => String(e.value));
    const unique = new Set(values);
    if (unique.size === 1) return undefined; // all identical
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    // magnitude: how dispersed are the values? 100 * (1 - max_count/total)
    const maxCount = Math.max(...counts.values());
    const magnitude = Math.max(1, Math.min(100, Math.round((1 - maxCount / entries.length) * 100)));
    const summary = [...counts.entries()].map(([v, c]) => `${v} (${c})`).join(", ");
    return {
      dimension,
      description: truncate(`${dimension.replace(/_/g, " ")} differs across listings: ${summary}.`, 240),
      magnitude,
    };
  }

  private exportCsv(comparison: Comparison): string {
    const header = ["dimension", ...comparison.listingIds.map((id) => id as string)];
    const rows: string[] = [header.map(csvEscape).join(",")];
    for (const dim of comparison.dimensions) {
      const row = [dim.name, ...comparison.listingIds.map((id) => csvValue(dim.values[id as string]))];
      rows.push(row.map(csvEscape).join(","));
    }
    return rows.join("\n");
  }
}

const HIGHER_IS_BETTER_DIMENSIONS = new Set([
  "evidence_score",
  "average_improvement",
  "completion_rate",
  "retention_30day",
  "retention_90day",
  "research_confidence",
  "population_size",
  "verified_measurements",
  "average_rating",
  "review_count",
  "verified_review_count",
  "install_count",
  "active_install_count",
  "suitability_score",
  "competition_participants",
  "average_reward_earnings",
  "evidence_entry_count",
]);

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => String(x)).join("; ");
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    return JSON.stringify(v);
  }
  return String(v);
}

function csvEscape(s: string): string {
  if (s === "") return "";
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: ComparisonEngine | null = null;
export function getComparison(): ComparisonEngine {
  if (!_engine) _engine = new ComparisonEngine();
  return _engine;
}
export function resetComparison(): void {
  _engine = null;
}

// Re-exports for convenience
export type {
  AccountId,
  Comparison,
  ComparisonDimension,
  ComparisonId,
  ListingId,
  MarketplaceListing,
  OutcomeMetrics,
} from "../core";
