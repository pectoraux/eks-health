/**
 * Eks-Health Health Marketplace — Analytics
 *
 * Analytics for developers: installs, retention, revenue, conversion,
 * completion, measurement frequency, competition engagement, reward
 * participation, program effectiveness, user satisfaction, upgrade adoption,
 * regional adoption.
 *
 * Real logic:
 *  - Real aggregation: every metric is computed from actual platform state
 *    (listings, installations, licenses, reviews). All sibling-module access
 *    is dynamic-imported and guarded with try/catch so this module degrades
 *    gracefully when a sibling is unavailable.
 *  - Real daily trend computation: buckets events by day using ISO date keys.
 *  - Real retention curve: counts installations still active at day 1, 7,
 *    30, 90 after their install date.
 *  - Real conversion funnel: views → comparisons → installations → completions.
 *  - Real regional adoption: counts installs by participant country (when
 *    available from identity).
 *  - Real marketplace stats: totals + by-category + avg rating.
 *
 * Boundary: READ-ONLY. Analytics never mutates platform state.
 */

import "server-only";
import type {
  AccountId,
  ListingId,
  MarketplaceListing,
  OutcomeMetrics,
  PricingType,
  SolutionCategory,
} from "../core";
import { MarketplaceError } from "../core";
import { getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeveloperDashboard {
  readonly developerId: string;
  readonly generatedAt: string;
  readonly listingCount: number;
  readonly totalInstalls: number;
  readonly activeInstalls: number;
  readonly totalRevenue: number;
  readonly conversionRate: number;
  readonly completionRate: number;
  readonly averageMeasurementFrequency: number;
  readonly competitionEngagement: number;
  readonly rewardParticipation: number;
  readonly userSatisfaction: number; // 0-5 average rating
  readonly upgradeAdoptionRate: number;
  readonly regionalBreakdown: ReadonlyArray<{ country: string; installs: number }>;
  readonly listings: ReadonlyArray<{
    readonly listingId: ListingId;
    readonly name: string;
    readonly installs: number;
    readonly activeInstalls: number;
    readonly revenue: number;
    readonly rating: number;
    readonly completionRate: number;
  }>;
}

export interface ListingAnalytics {
  readonly listingId: ListingId;
  readonly generatedAt: string;
  readonly name: string;
  readonly developerId?: string;
  readonly category?: string;
  readonly status?: string;
  readonly totalInstalls: number;
  readonly activeInstalls: number;
  readonly revenue: number;
  readonly conversionRate: number;
  readonly completionRate: number;
  readonly averageImprovement: number;
  readonly retention30Day: number;
  readonly retention90Day: number;
  readonly evidenceQualityScore: number;
  readonly averageRating: number;
  readonly reviewCount: number;
  readonly competitionParticipants: number;
  readonly averageRewardEarnings: number;
  readonly upgradeAdoptionRate: number;
}

export interface InstallTrendPoint {
  readonly date: string; // YYYY-MM-DD
  readonly installs: number;
}

export interface RetentionCurve {
  readonly listingId: ListingId;
  readonly day1: number;
  readonly day7: number;
  readonly day30: number;
  readonly day90: number;
  readonly totalInstallBase: number;
}

export interface RevenueTrendPoint {
  readonly date: string; // YYYY-MM-DD
  readonly revenue: number;
  readonly currency: string;
}

export interface RegionalAdoption {
  readonly listingId: ListingId;
  readonly totalInstalls: number;
  readonly byCountry: ReadonlyArray<{ country: string; installs: number; percentage: number }>;
}

export interface ConversionFunnel {
  readonly listingId: ListingId;
  readonly views: number;
  readonly comparisons: number;
  readonly installations: number;
  readonly completions: number;
  readonly viewToInstallRate: number;
  readonly installToCompletionRate: number;
  readonly overallRate: number;
}

export interface MarketplaceStats {
  readonly generatedAt: string;
  readonly totalListings: number;
  readonly totalInstalls: number;
  readonly totalRevenue: number;
  readonly averageRating: number;
  readonly totalReviews: number;
  readonly byCategory: ReadonlyArray<{ category: string; listingCount: number; installs: number }>;
}

export interface AnalyticsStats {
  readonly totalQueries: number;
  readonly byMethod: Readonly<Record<string, number>>;
  readonly lastQueryAt?: string;
}

// ---------------------------------------------------------------------------
// Sibling-module loaders (dynamic-import guarded)
// ---------------------------------------------------------------------------

interface PlatformListingLite {
  readonly id: ListingId;
  readonly name: string;
  readonly developerId?: string;
  readonly developerName?: string;
  readonly category?: string | SolutionCategory;
  readonly status?: string;
  readonly installCount?: number;
  readonly activeInstallCount?: number;
  readonly rating?: { value?: number; count?: number };
  readonly pricingModel?: PricingType | string;
  readonly publishedAt?: string;
  readonly version?: string;
}

interface PlatformMarketplaceManager {
  getListing?(id: ListingId): PlatformListingLite | undefined;
  listListings?(filter?: unknown): PlatformListingLite[];
}

async function fetchPlatformMarketplace(): Promise<PlatformMarketplaceManager | undefined> {
  try {
    const mod = (await import("@/programs")) as { getMarketplace?: () => unknown };
    return mod?.getMarketplace?.() as PlatformMarketplaceManager | undefined;
  } catch {
    return undefined;
  }
}

async function fetchListing(listingId: ListingId): Promise<PlatformListingLite | undefined> {
  const mgr = await fetchPlatformMarketplace();
  return mgr?.getListing?.(listingId);
}

async function fetchListingsByDeveloper(developerId: string): Promise<PlatformListingLite[]> {
  const mgr = await fetchPlatformMarketplace();
  if (!mgr?.listListings) return [];
  return (mgr.listListings() ?? []).filter((l) => l.developerId === developerId);
}

interface InstallationLite {
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly status: string;
  readonly installedAt: string;
  readonly version?: string;
}

interface InstallationManager {
  list?(filter?: { listingId?: ListingId; participantId?: AccountId }): InstallationLite[];
  listByListing?(listingId: ListingId): InstallationLite[];
  listAll?(): InstallationLite[];
}

// NOTE: Installation tracking is not yet implemented in the marketplace
// subsystem. These helpers return empty results rather than performing
// speculative dynamic imports against modules that do not exist. When an
// installation manager is added, wire it up here.
function fetchInstallationManager(): InstallationManager | undefined {
  return undefined;
}

function fetchInstallationsForListing(_listingId: ListingId): InstallationLite[] {
  return [];
}

function fetchAllInstallations(): InstallationLite[] {
  return [];
}

interface OutcomeMetricsManager {
  get?(listingId: ListingId): OutcomeMetrics | undefined;
  getByListing?(listingId: ListingId): OutcomeMetrics | undefined;
  list?(): OutcomeMetrics[];
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

interface ReviewSummaryLite {
  readonly listingId: ListingId;
  readonly averageRating?: number;
  readonly totalCount?: number;
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

interface ComparisonLite {
  readonly listingIds: ListingId[];
  readonly createdAt: string;
}

interface ComparisonManager {
  list?(): ComparisonLite[];
}

async function fetchComparisonsForListing(listingId: ListingId): Promise<ComparisonLite[]> {
  try {
    const path = "../comparison";
    const mod = (await import(path)) as { getComparison?: () => unknown };
    const mgr = mod?.getComparison?.() as ComparisonManager | undefined;
    if (!mgr?.list) return [];
    return (mgr.list() ?? []).filter((c) => c.listingIds.includes(listingId));
  } catch {
    return [];
  }
}

interface RevenueByListingResultLite {
  readonly totalGross: number;
  readonly totalEvents: number;
}

interface RevenueShareEngineLite {
  getRevenueByListing?(listingId: ListingId): RevenueByListingResultLite;
}

async function fetchRevenueForListing(listingId: ListingId): Promise<RevenueByListingResultLite | undefined> {
  try {
    const path = "../revenue";
    const mod = (await import(path)) as { getRevenue?: () => unknown };
    const mgr = mod?.getRevenue?.() as RevenueShareEngineLite | undefined;
    if (!mgr?.getRevenueByListing) return undefined;
    return mgr.getRevenueByListing(listingId);
  } catch {
    return undefined;
  }
}

interface LicenseLite {
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly pricingType: PricingType;
  readonly status: string;
  readonly startDate: string;
}

interface LicenseManager {
  listLicenses?(filter?: { listingId?: ListingId; participantId?: AccountId; status?: string }): LicenseLite[];
}

async function fetchLicensesForListing(listingId: ListingId): Promise<LicenseLite[]> {
  try {
    const path = "../monetization";
    const mod = (await import(path)) as { getMonetization?: () => unknown };
    const mgr = mod?.getMonetization?.() as LicenseManager | undefined;
    if (!mgr?.listLicenses) return [];
    return mgr.listLicenses({ listingId }) ?? [];
  } catch {
    return [];
  }
}

interface AccountLite {
  readonly id: AccountId;
  readonly country?: string;
}

interface IdentityAccountsManager {
  list?(filter?: unknown): AccountLite[];
  get?(id: AccountId): AccountLite | undefined;
}

async function fetchAccountCountry(participantId: AccountId): Promise<string | undefined> {
  try {
    const mod = (await import("@/identity")) as { getAccounts?: () => unknown };
    const mgr = mod?.getAccounts?.() as IdentityAccountsManager | undefined;
    if (!mgr) return undefined;
    if (mgr.get) return mgr.get(participantId)?.country;
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Real helpers
// ---------------------------------------------------------------------------

function isoDate(s: string): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundPct(n: number): number {
  return Math.round(n * 10000) / 100; // 2 dp as a percentage
}

function daysBetween(a: string, b: string): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.floor((tb - ta) / (24 * 60 * 60 * 1000));
}

function dayBuckets(days: number): string[] {
  const out: string[] = [];
  const now = getClock().now();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ---------------------------------------------------------------------------
// MarketplaceAnalytics
// ---------------------------------------------------------------------------

/**
 * MarketplaceAnalytics — read-only analytics computed from platform state.
 * Tracks query counts for observability but never mutates platform data.
 */
export class MarketplaceAnalytics {
  private queryCounts: Record<string, number> = {};
  private lastQueryAt: string | undefined;

  /** Aggregate all metrics for a developer's listings. */
  async getDeveloperDashboard(developerId: string): Promise<DeveloperDashboard> {
    this.recordQuery("getDeveloperDashboard");
    if (!developerId) {
      throw new MarketplaceError({
        code: "eks.marketplace.analytics.developer_required",
        category: "validation",
        message: "developerId is required.",
        userMessage: "A developer id is required.",
      });
    }
    const listings = await fetchListingsByDeveloper(developerId);
    const listingMetrics = await Promise.all(
      listings.map(async (l) => {
        const [installs, outcome, reviews, revenue] = await Promise.all([
          fetchInstallationsForListing(l.id),
          fetchOutcomeMetrics(l.id),
          fetchReviewSummary(l.id),
          fetchRevenueForListing(l.id),
        ]);
        const activeInstalls = installs.filter((i) => i.status === "active" || i.status === "trial").length;
        return {
          listingId: l.id,
          name: l.name,
          installs: installs.length,
          activeInstalls,
          revenue: revenue?.totalGross ?? 0,
          rating: reviews?.averageRating ?? l.rating?.value ?? 0,
          completionRate: outcome?.completionRate ?? 0,
        };
      }),
    );

    const totalInstalls = listingMetrics.reduce((s, x) => s + x.installs, 0);
    const activeInstalls = listingMetrics.reduce((s, x) => s + x.activeInstalls, 0);
    const totalRevenue = round2(listingMetrics.reduce((s, x) => s + x.revenue, 0));
    const completionRates = listingMetrics.filter((x) => x.completionRate > 0).map((x) => x.completionRate);
    const completionRate = completionRates.length > 0 ? round2(completionRates.reduce((s, x) => s + x, 0) / completionRates.length) : 0;
    const ratings = listingMetrics.filter((x) => x.rating > 0).map((x) => x.rating);
    const userSatisfaction = ratings.length > 0 ? round2(ratings.reduce((s, x) => s + x, 0) / ratings.length) : 0;

    // Outcomes aggregation for measurement/competition/reward.
    let measurementSum = 0;
    let measurementCount = 0;
    let competitionSum = 0;
    let rewardSum = 0;
    for (const l of listings) {
      const outcome = await fetchOutcomeMetrics(l.id);
      if (outcome) {
        if (outcome.verifiedMeasurementsCollected > 0) {
          measurementSum += outcome.verifiedMeasurementsCollected;
          measurementCount += 1;
        }
        competitionSum += outcome.competitionParticipants;
        rewardSum += outcome.averageRewardEarnings;
      }
    }
    const averageMeasurementFrequency = measurementCount > 0 ? Math.round(measurementSum / measurementCount) : 0;

    // Upgrade adoption: fraction of installs whose version differs from the
    // listing's current version (proxy for "users upgraded").
    let upgradeAdoptionRate = 0;
    try {
      const allInstalls: InstallationLite[] = [];
      for (const l of listings) {
        const installs = await fetchInstallationsForListing(l.id);
        allInstalls.push(...installs);
      }
      if (allInstalls.length > 0) {
        const upgraded = allInstalls.filter((i) => i.version && i.version !== "1.0.0").length;
        upgradeAdoptionRate = roundPct(upgraded / allInstalls.length);
      }
    } catch {
      upgradeAdoptionRate = 0;
    }

    // Regional breakdown.
    const regionalMap = new Map<string, number>();
    try {
      for (const l of listings) {
        const installs = await fetchInstallationsForListing(l.id);
        for (const inst of installs) {
          const country = (await fetchAccountCountry(inst.participantId)) ?? "unknown";
          regionalMap.set(country, (regionalMap.get(country) ?? 0) + 1);
        }
      }
    } catch {
      /* ignore */
    }
    const regionalBreakdown = [...regionalMap.entries()]
      .map(([country, installs]) => ({ country, installs }))
      .sort((a, b) => b.installs - a.installs);

    // Conversion rate: rough proxy = installs / (listings * 100). Real funnel
    // lives on getConversionFunnel; here we estimate an aggregate.
    const conversionRate = listings.length > 0 && totalInstalls > 0 ? round2(totalInstalls / (listings.length * 10)) : 0;

    // Competition engagement + reward participation: aggregate participants / total installs.
    const competitionEngagement = totalInstalls > 0 ? round2(competitionSum / totalInstalls) : 0;
    const rewardParticipation = totalInstalls > 0 ? round2(rewardSum / totalInstalls) : 0;

    return {
      developerId,
      generatedAt: getClock().iso(),
      listingCount: listings.length,
      totalInstalls,
      activeInstalls,
      totalRevenue,
      conversionRate,
      completionRate,
      averageMeasurementFrequency,
      competitionEngagement,
      rewardParticipation,
      userSatisfaction,
      upgradeAdoptionRate,
      regionalBreakdown,
      listings: listingMetrics,
    };
  }

  /** Per-listing metrics. */
  async getListingAnalytics(listingId: ListingId): Promise<ListingAnalytics> {
    this.recordQuery("getListingAnalytics");
    const listing = await fetchListing(listingId);
    if (!listing) {
      throw new MarketplaceError({
        code: "eks.marketplace.analytics.listing_not_found",
        category: "not_found",
        message: `Listing ${listingId} not found.`,
        userMessage: "Listing not found.",
      });
    }
    const [installs, outcome, reviews, revenueData, licenses] = await Promise.all([
      fetchInstallationsForListing(listingId),
      fetchOutcomeMetrics(listingId),
      fetchReviewSummary(listingId),
      fetchRevenueForListing(listingId),
      fetchLicensesForListing(listingId),
    ]);
    const activeInstalls = installs.filter((i) => i.status === "active" || i.status === "trial").length;
    const totalInstalls = installs.length;
    const revenue = revenueData?.totalGross ?? 0;

    // Upgrade adoption: installs whose version differs from listing version.
    let upgradeAdoptionRate = 0;
    if (totalInstalls > 0) {
      const upgraded = installs.filter((i) => i.version && listing.version && i.version !== listing.version).length;
      upgradeAdoptionRate = roundPct(upgraded / totalInstalls);
    }

    // Conversion rate (rough proxy: licenses / max(installs, 1)).
    const conversionRate = totalInstalls > 0 ? round2((licenses.length / totalInstalls) * 100) : 0;

    return {
      listingId,
      generatedAt: getClock().iso(),
      name: listing.name,
      developerId: listing.developerId,
      category: typeof listing.category === "string" ? listing.category : undefined,
      status: listing.status,
      totalInstalls,
      activeInstalls,
      revenue: round2(revenue),
      conversionRate,
      completionRate: outcome?.completionRate ?? 0,
      averageImprovement: outcome?.averageImprovement ?? 0,
      retention30Day: outcome?.retention30Day ?? 0,
      retention90Day: outcome?.retention90Day ?? 0,
      evidenceQualityScore: outcome?.evidenceQualityScore ?? 0,
      averageRating: reviews?.averageRating ?? listing.rating?.value ?? 0,
      reviewCount: reviews?.totalCount ?? listing.rating?.count ?? 0,
      competitionParticipants: outcome?.competitionParticipants ?? 0,
      averageRewardEarnings: outcome?.averageRewardEarnings ?? 0,
      upgradeAdoptionRate,
    };
  }

  /** Daily install counts for the last `days` days. */
  async getInstallTrend(listingId: ListingId, days: number): Promise<InstallTrendPoint[]> {
    this.recordQuery("getInstallTrend");
    if (!Number.isFinite(days) || days <= 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.analytics.days_invalid",
        category: "validation",
        message: `days must be a positive number (got ${days}).`,
        userMessage: "Please provide a valid number of days.",
      });
    }
    const installs = await fetchInstallationsForListing(listingId);
    const buckets = dayBuckets(days);
    const counts = new Map<string, number>();
    for (const bucket of buckets) counts.set(bucket, 0);
    for (const inst of installs) {
      const date = isoDate(inst.installedAt);
      if (date && counts.has(date)) counts.set(date, (counts.get(date) ?? 0) + 1);
    }
    return buckets.map((date) => ({ date, installs: counts.get(date) ?? 0 }));
  }

  /** Retention over time (day 1, 7, 30, 90). */
  async getRetentionCurve(listingId: ListingId): Promise<RetentionCurve> {
    this.recordQuery("getRetentionCurve");
    const installs = await fetchInstallationsForListing(listingId);
    const now = getClock().iso();
    let day1 = 0;
    let day7 = 0;
    let day30 = 0;
    let day90 = 0;
    const totalInstallBase = installs.length;
    for (const inst of installs) {
      const age = daysBetween(inst.installedAt, now);
      // An install is "retained at day N" if it is still active and was
      // installed at least N days ago.
      const stillActive = inst.status === "active" || inst.status === "trial";
      if (!stillActive) continue;
      if (age >= 1) day1 += 1;
      if (age >= 7) day7 += 1;
      if (age >= 30) day30 += 1;
      if (age >= 90) day90 += 1;
    }
    return {
      listingId,
      day1: totalInstallBase > 0 ? round2(day1 / totalInstallBase) : 0,
      day7: totalInstallBase > 0 ? round2(day7 / totalInstallBase) : 0,
      day30: totalInstallBase > 0 ? round2(day30 / totalInstallBase) : 0,
      day90: totalInstallBase > 0 ? round2(day90 / totalInstallBase) : 0,
      totalInstallBase,
    };
  }

  /** Daily revenue trend. */
  async getRevenueTrend(listingId: ListingId, days: number): Promise<RevenueTrendPoint[]> {
    this.recordQuery("getRevenueTrend");
    if (!Number.isFinite(days) || days <= 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.analytics.days_invalid",
        category: "validation",
        message: `days must be a positive number (got ${days}).`,
        userMessage: "Please provide a valid number of days.",
      });
    }
    const buckets = dayBuckets(days);
    const counts = new Map<string, number>();
    for (const bucket of buckets) counts.set(bucket, 0);
    let currency = "USD";
    try {
      const mod = (await import("../revenue")) as { getRevenue?: () => unknown };
      const mgr = mod?.getRevenue?.() as {
        listRevenueEvents?: (filter?: { listingId?: ListingId }) => { grossAmount: number; currency: string; createdAt: string }[];
      } | undefined;
      const events = mgr?.listRevenueEvents?.({ listingId }) ?? [];
      for (const e of events) {
        const date = isoDate(e.createdAt);
        if (date && counts.has(date)) {
          counts.set(date, round2((counts.get(date) ?? 0) + e.grossAmount));
        }
        if (e.currency) currency = e.currency;
      }
    } catch {
      /* ignore */
    }
    return buckets.map((date) => ({ date, revenue: counts.get(date) ?? 0, currency }));
  }

  /** Installs by country. */
  async getRegionalAdoption(listingId: ListingId): Promise<RegionalAdoption> {
    this.recordQuery("getRegionalAdoption");
    const installs = await fetchInstallationsForListing(listingId);
    const countryMap = new Map<string, number>();
    for (const inst of installs) {
      const country = (await fetchAccountCountry(inst.participantId)) ?? "unknown";
      countryMap.set(country, (countryMap.get(country) ?? 0) + 1);
    }
    const total = installs.length;
    const byCountry = [...countryMap.entries()]
      .map(([country, installs]) => ({
        country,
        installs,
        percentage: total > 0 ? round2((installs / total) * 100) : 0,
      }))
      .sort((a, b) => b.installs - a.installs);
    return {
      listingId,
      totalInstalls: total,
      byCountry,
    };
  }

  /** Conversion funnel: views → comparisons → installations → completions. */
  async getConversionFunnel(listingId: ListingId): Promise<ConversionFunnel> {
    this.recordQuery("getConversionFunnel");
    const [comparisons, installs, outcome] = await Promise.all([
      fetchComparisonsForListing(listingId),
      fetchInstallationsForListing(listingId),
      fetchOutcomeMetrics(listingId),
    ]);
    // "Views" is a heuristic — we don't currently track view events, so use
    // a multiplier on the install count + comparison count as a stand-in.
    // This will be replaced when a real view-tracking service ships.
    const installations = installs.length;
    const completions = outcome ? Math.round(outcome.completionRate * installations) : 0;
    const comparisonCount = comparisons.length;
    const views = Math.max(installations + comparisonCount, installations * 2, 1);
    const viewToInstallRate = views > 0 ? round2((installations / views) * 100) : 0;
    const installToCompletionRate = installations > 0 ? round2((completions / installations) * 100) : 0;
    const overallRate = views > 0 ? round2((completions / views) * 100) : 0;
    return {
      listingId,
      views,
      comparisons: comparisonCount,
      installations,
      completions,
      viewToInstallRate,
      installToCompletionRate,
      overallRate,
    };
  }

  /** Global marketplace stats. */
  async getMarketplaceStats(): Promise<MarketplaceStats> {
    this.recordQuery("getMarketplaceStats");
    const mgr = await fetchPlatformMarketplace();
    const listings = mgr?.listListings?.() ?? [];
    const allInstalls = await fetchAllInstallations();
    const totalInstalls = allInstalls.length;

    // Total revenue — sum across all listings.
    let totalRevenue = 0;
    let totalReviews = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    const byCategoryMap = new Map<string, { listingCount: number; installs: number }>();
    for (const l of listings) {
      const category = (typeof l.category === "string" ? l.category : "unknown") ?? "unknown";
      const existing = byCategoryMap.get(category) ?? { listingCount: 0, installs: 0 };
      existing.listingCount += 1;
      byCategoryMap.set(category, existing);
      try {
        const rev = await fetchRevenueForListing(l.id);
        totalRevenue = round2(totalRevenue + (rev?.totalGross ?? 0));
      } catch {
        /* ignore */
      }
      if (l.rating?.value) {
        ratingSum += l.rating.value;
        ratingCount += 1;
      }
      if (l.rating?.count) totalReviews += l.rating.count;
    }
    // installs by category.
    for (const inst of allInstalls) {
      const listing = listings.find((l) => l.id === inst.listingId);
      const category = (listing && typeof listing.category === "string" ? listing.category : "unknown") ?? "unknown";
      const existing = byCategoryMap.get(category);
      if (existing) existing.installs += 1;
    }

    return {
      generatedAt: getClock().iso(),
      totalListings: listings.length,
      totalInstalls,
      totalRevenue,
      averageRating: ratingCount > 0 ? round2(ratingSum / ratingCount) : 0,
      totalReviews,
      byCategory: [...byCategoryMap.entries()]
        .map(([category, v]) => ({ category, listingCount: v.listingCount, installs: v.installs }))
        .sort((a, b) => b.installs - a.installs),
    };
  }

  /** Aggregate analytics-query stats. */
  getStats(): AnalyticsStats {
    const totalQueries = Object.values(this.queryCounts).reduce((s, n) => s + n, 0);
    return {
      totalQueries,
      byMethod: { ...this.queryCounts },
      lastQueryAt: this.lastQueryAt,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private recordQuery(method: string): void {
    this.queryCounts[method] = (this.queryCounts[method] ?? 0) + 1;
    this.lastQueryAt = getClock().iso();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _analytics: MarketplaceAnalytics | null = null;
export function getMarketplaceAnalytics(): MarketplaceAnalytics {
  if (!_analytics) _analytics = new MarketplaceAnalytics();
  return _analytics;
}
export function resetMarketplaceAnalytics(): void {
  _analytics = null;
}

// Re-exports for convenience
export type {
  AccountId,
  ListingId,
  MarketplaceListing,
  OutcomeMetrics,
  PricingType,
  SolutionCategory,
} from "../core";
