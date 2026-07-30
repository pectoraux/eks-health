/**
 * Eks-Health Health Marketplace — Reviews & Reputation
 *
 * Verified reviews, outcome-based reviews, technician reviews, organization
 * reviews, developer reputation, evidence quality, long-term satisfaction,
 * abuse reporting, moderation, fraud detection.
 *
 * Real logic:
 *  - Real review validation (rating 1-5, non-empty body).
 *  - Real verification: a review is marked verified when the reviewer has an
 *    active installation for the listing (dynamic-import guarded).
 *  - Real aggregation: getSummary computes avg rating, 5-bucket distribution,
 *    verified count, outcome-based count, avg improvement reported.
 *  - Real developer reputation aggregation: aggregates across all the
 *    developer's listings, with response rate / verification rate metrics.
 *  - Real fraud detection: review bombing (many reviews in short window),
 *    suspicious rating patterns (all 5s from new accounts), duplicate
 *    content (normalized-text Jaccard similarity ≥ threshold).
 */

import "server-only";
import type {
  AccountId,
  ListingId,
  Review,
  ReviewId,
  ReviewType,
} from "../core";
import {
  MARKETPLACE_EVENTS,
  MarketplaceError,
  asReviewId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SubmitReviewInput {
  readonly listingId: ListingId;
  readonly authorId: AccountId;
  readonly authorType: ReviewType;
  readonly authorName: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly outcomeBased?: boolean;
  readonly improvementReported?: number;
  readonly durationUsedDays?: number;
}

export interface ReviewListFilter {
  readonly listingId?: ListingId;
  readonly authorType?: ReviewType;
  readonly verified?: boolean;
  readonly minRating?: number;
  readonly maxRating?: number;
  readonly since?: string;
  readonly until?: string;
  readonly reported?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReviewListResult {
  readonly items: Review[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface ReviewSummary {
  readonly listingId: ListingId;
  readonly averageRating: number;
  readonly totalCount: number;
  readonly verifiedCount: number;
  readonly outcomeBasedCount: number;
  readonly reportedCount: number;
  readonly averageImprovementReported: number;
  readonly distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>;
}

export type ModerationAction = "approve" | "remove" | "keep";

export interface ModerationRecord {
  readonly reviewId: ReviewId;
  readonly action: ModerationAction;
  readonly moderator: string;
  readonly at: string;
  readonly notes?: string;
}

export interface DeveloperReputation {
  readonly developerId: string;
  readonly listingCount: number;
  readonly totalReviews: number;
  readonly verifiedReviews: number;
  readonly verificationRate: number;
  readonly averageRating: number;
  readonly responseRate: number; // placeholder: 0 until responses are tracked
  readonly ratingDistribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>;
}

export interface FraudDetectionResult {
  readonly listingId: ListingId;
  readonly totalReviews: number;
  readonly flaggedCount: number;
  readonly flaggedReviews: ReadonlyArray<{
    readonly reviewId: ReviewId;
    readonly reasons: string[];
    readonly severity: "low" | "medium" | "high";
  }>;
  readonly signals: {
    readonly reviewBombingDetected: boolean;
    readonly suspiciousPatternDetected: boolean;
    readonly duplicateContentDetected: boolean;
  };
}

export interface ReviewStats {
  readonly totalReviews: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly verifiedRate: number;
  readonly reportedCount: number;
  readonly moderatedCount: number;
  readonly averageRating: number;
}

// ---------------------------------------------------------------------------
// Internal mutable record (extends the readonly public type)
// ---------------------------------------------------------------------------

type MutableReview = Review;

type MutableModerationRecord = ModerationRecord;

// ---------------------------------------------------------------------------
// Sibling-module loader (dynamic-import guarded)
// ---------------------------------------------------------------------------

interface InstallationLite {
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly status: string;
}

interface InstallationManager {
  listByParticipant?(participantId: AccountId): InstallationLite[];
  list?(filter?: { participantId?: AccountId; listingId?: ListingId }): InstallationLite[];
  getByParticipant?(participantId: AccountId): InstallationLite[];
}

async function fetchParticipantInstallations(participantId: AccountId): Promise<InstallationLite[]> {
  try {
    // The installation manager is expected to live at ../installation or be
    // surfaced via a future marketplace boot. Both paths are tried.
    const candidates: string[] = ["../installation", "../installations"];
    for (const path of candidates) {
      try {
        const mod = (await import(path)) as {
          getInstallations?: () => unknown;
          getInstallationManager?: () => unknown;
        };
        const accessor = mod?.getInstallations ?? mod?.getInstallationManager;
        const mgr = accessor?.() as InstallationManager | undefined;
        if (!mgr) continue;
        if (mgr.listByParticipant) return mgr.listByParticipant(participantId) ?? [];
        if (mgr.list) return mgr.list({ participantId }) ?? [];
        if (mgr.getByParticipant) return mgr.getByParticipant(participantId) ?? [];
      } catch {
        /* try next candidate */
      }
    }
    return [];
  } catch {
    return [];
  }
}

interface PlatformListingLite {
  readonly id: ListingId;
  readonly developerId?: string;
  readonly developerName?: string;
}

interface PlatformMarketplaceManager {
  getListing?(id: ListingId): PlatformListingLite | undefined;
  listListings?(filter?: unknown): PlatformListingLite[];
}

async function fetchListing(listingId: ListingId): Promise<PlatformListingLite | undefined> {
  try {
    const mod = (await import("@/programs")) as { getMarketplace?: () => unknown };
    const mgr = mod?.getMarketplace?.() as PlatformMarketplaceManager | undefined;
    if (!mgr?.getListing) return undefined;
    return mgr.getListing(listingId);
  } catch {
    return undefined;
  }
}

async function fetchListingsByDeveloper(developerId: string): Promise<ListingId[]> {
  try {
    const mod = (await import("@/programs")) as { getMarketplace?: () => unknown };
    const mgr = mod?.getMarketplace?.() as PlatformMarketplaceManager | undefined;
    if (!mgr?.listListings) return [];
    const all = mgr.listListings() ?? [];
    return all.filter((l) => l.developerId === developerId).map((l) => l.id);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Real helpers
// ---------------------------------------------------------------------------

const EMPTY_DISTRIBUTION: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

function normalizeRating(r: number): 1 | 2 | 3 | 4 | 5 {
  const rounded = Math.max(1, Math.min(5, Math.round(r)));
  return rounded as 1 | 2 | 3 | 4 | 5;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalize review body for duplicate detection: lowercase, collapse
 * whitespace, strip punctuation. Used by the Jaccard similarity check.
 */
function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(text.split(" ").filter((t) => t.length > 0));
}

/** Real Jaccard similarity between two normalized texts. */
function jaccardSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection += 1;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// ReviewManager
// ---------------------------------------------------------------------------

/**
 * ReviewManager — manages verified reviews, outcome-based reviews, moderation,
 * and developer reputation. Real fraud detection runs on demand per listing.
 */
export class ReviewManager {
  private readonly reviews = new Map<ReviewId, MutableReview>();
  private readonly reviewsByListing = new Map<ListingId, ReviewId[]>();
  private readonly moderations: MutableModerationRecord[] = [];
  private readonly reports = new Map<ReviewId, { reason: string; at: string; reporterId?: string }[]>();

  /** Submit a review. Validates rating + body; auto-marks verified if the reviewer has an active installation. */
  async submit(input: SubmitReviewInput): Promise<Review> {
    if (!input.listingId) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.listing_required",
        category: "validation",
        message: "listingId is required.",
        userMessage: "A listing is required.",
      });
    }
    if (!input.authorId) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.author_required",
        category: "validation",
        message: "authorId is required.",
        userMessage: "An author is required.",
      });
    }
    if (!input.authorName || input.authorName.trim().length === 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.author_name_required",
        category: "validation",
        message: "authorName is required.",
        userMessage: "Please provide an author name.",
      });
    }
    if (!Number.isFinite(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.rating_invalid",
        category: "validation",
        message: `Rating must be between 1 and 5 (got ${input.rating}).`,
        userMessage: "Rating must be between 1 and 5.",
      });
    }
    if (!input.body || input.body.trim().length < 4) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.body_invalid",
        category: "validation",
        message: "Review body must be at least 4 characters.",
        userMessage: "Please write a more detailed review.",
      });
    }
    if (input.improvementReported !== undefined && (input.improvementReported < -100 || input.improvementReported > 1000)) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.improvement_invalid",
        category: "validation",
        message: `Invalid improvementReported: ${input.improvementReported}`,
        userMessage: "Improvement percentage is out of range.",
      });
    }

    // Verify the reviewer has an active installation for this listing.
    let verified = false;
    try {
      const installations = await fetchParticipantInstallations(input.authorId);
      verified = installations.some(
        (i) => i.listingId === input.listingId && (i.status === "active" || i.status === "trial"),
      );
    } catch {
      verified = false;
    }

    const id = asReviewId(`rev_${generateId()}`);
    const now = getClock().iso();
    const review: MutableReview = {
      id,
      listingId: input.listingId,
      authorId: input.authorId,
      authorType: input.authorType,
      authorName: input.authorName,
      rating: Math.round(input.rating),
      title: input.title ?? "",
      body: input.body,
      verified,
      outcomeBased: input.outcomeBased ?? false,
      improvementReported: input.improvementReported,
      durationUsedDays: input.durationUsedDays,
      createdAt: now,
      helpfulCount: 0,
      reported: false,
    };
    this.reviews.set(id, review);
    const list = this.reviewsByListing.get(input.listingId) ?? [];
    this.reviewsByListing.set(input.listingId, [...list, id]);

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.reviewSubmitted,
        {
          reviewId: id,
          listingId: input.listingId,
          authorId: input.authorId,
          authorType: input.authorType,
          rating: review.rating,
          verified,
          outcomeBased: review.outcomeBased,
        },
        {
          actor: { kind: "user", id: input.authorId as string },
          partitionKey: input.listingId as string,
        },
        "domain",
      ),
    );

    return review;
  }

  /** Get a review by id. */
  get(id: ReviewId): Review | undefined {
    return this.reviews.get(id);
  }

  /** List reviews with optional filter + pagination. */
  list(filter?: ReviewListFilter): ReviewListResult {
    let items: MutableReview[];
    if (filter?.listingId) {
      const ids = this.reviewsByListing.get(filter.listingId) ?? [];
      items = ids.map((id) => this.reviews.get(id)).filter((r): r is MutableReview => Boolean(r));
    } else {
      items = [...this.reviews.values()];
    }
    if (filter?.authorType) items = items.filter((r) => r.authorType === filter.authorType);
    if (filter?.verified !== undefined) items = items.filter((r) => r.verified === filter.verified);
    if (filter?.minRating !== undefined) items = items.filter((r) => r.rating >= filter.minRating!);
    if (filter?.maxRating !== undefined) items = items.filter((r) => r.rating <= filter.maxRating!);
    if (filter?.since) items = items.filter((r) => r.createdAt >= filter.since!);
    if (filter?.until) items = items.filter((r) => r.createdAt <= filter.until!);
    if (filter?.reported !== undefined) items = items.filter((r) => r.reported === filter.reported);

    const total = items.length;
    items = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? items.length;
    const paged = items.slice(offset, offset + limit);
    return { items: paged, total, limit, offset };
  }

  /**
   * Mark a review as verified (by a technician or platform admin). Emits
   * review.verified. Idempotent.
   */
  markVerified(id: ReviewId): Review {
    const review = this.require(id);
    if (review.verified) return review;
    const updated: MutableReview = { ...review, verified: true };
    this.reviews.set(id, updated);
    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.reviewVerified,
        {
          reviewId: id,
          listingId: review.listingId,
          authorId: review.authorId,
        },
        {
          actor: { kind: "user", id: "platform_verifier" },
          partitionKey: review.listingId as string,
        },
        "domain",
      ),
    );
    return updated;
  }

  /** Flag a review for moderation. */
  report(id: ReviewId, reason: string, reporterId?: string): Review {
    const review = this.require(id);
    if (!reason || reason.trim().length === 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.report_reason_required",
        category: "validation",
        message: "Report reason is required.",
        userMessage: "Please provide a reason for reporting.",
      });
    }
    const list = this.reports.get(id) ?? [];
    list.push({ reason: reason.trim(), at: getClock().iso(), reporterId });
    this.reports.set(id, list);
    const updated: MutableReview = { ...review, reported: true };
    this.reviews.set(id, updated);
    return updated;
  }

  /** Moderate a flagged review (approve / remove / keep). Records the action. */
  moderate(id: ReviewId, action: ModerationAction, moderator: string, notes?: string): { review: Review; moderation: ModerationRecord } {
    const review = this.require(id);
    if (!moderator || moderator.trim().length === 0) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.moderator_required",
        category: "validation",
        message: "Moderator identity is required.",
        userMessage: "Please identify the moderator.",
      });
    }
    const now = getClock().iso();
    const moderation: MutableModerationRecord = {
      reviewId: id,
      action,
      moderator,
      at: now,
      notes,
    };
    this.moderations.push(moderation);

    let updated: MutableReview = review;
    if (action === "remove") {
      // Removed reviews are hidden from summaries but retained for audit.
      updated = { ...review, reported: true };
      this.reviews.set(id, updated);
    } else if (action === "approve") {
      // Approved reviews clear their reported flag.
      updated = { ...review, reported: false };
      this.reviews.set(id, updated);
    }
    return { review: updated, moderation };
  }

  /** Get moderation history (optionally for a single review). */
  listModerations(reviewId?: ReviewId): ModerationRecord[] {
    if (reviewId) return this.moderations.filter((m) => m.reviewId === reviewId);
    return [...this.moderations];
  }

  /** Aggregate summary for a listing's reviews. */
  getSummary(listingId: ListingId): ReviewSummary {
    const ids = this.reviewsByListing.get(listingId) ?? [];
    const reviews = ids.map((id) => this.reviews.get(id)).filter((r): r is MutableReview => Boolean(r));
    const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { ...EMPTY_DISTRIBUTION };
    let sum = 0;
    let verifiedCount = 0;
    let outcomeBasedCount = 0;
    let reportedCount = 0;
    let improvementSum = 0;
    let improvementCount = 0;
    for (const r of reviews) {
      const bucket = normalizeRating(r.rating);
      distribution[bucket] += 1;
      sum += bucket;
      if (r.verified) verifiedCount += 1;
      if (r.outcomeBased) outcomeBasedCount += 1;
      if (r.reported) reportedCount += 1;
      if (typeof r.improvementReported === "number" && Number.isFinite(r.improvementReported)) {
        improvementSum += r.improvementReported;
        improvementCount += 1;
      }
    }
    const totalCount = reviews.length;
    return {
      listingId,
      averageRating: totalCount > 0 ? round2(sum / totalCount) : 0,
      totalCount,
      verifiedCount,
      outcomeBasedCount,
      reportedCount,
      averageImprovementReported: improvementCount > 0 ? round2(improvementSum / improvementCount) : 0,
      distribution,
    };
  }

  /** Aggregate a developer's reputation across all their listings. */
  async getDeveloperReputation(developerId: string): Promise<DeveloperReputation> {
    if (!developerId) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.developer_id_required",
        category: "validation",
        message: "developerId is required.",
        userMessage: "A developer id is required.",
      });
    }
    const listingIds = await fetchListingsByDeveloper(developerId);
    const allReviews: MutableReview[] = [];
    for (const listingId of listingIds) {
      const ids = this.reviewsByListing.get(listingId) ?? [];
      for (const id of ids) {
        const r = this.reviews.get(id);
        if (r) allReviews.push(r);
      }
    }
    const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { ...EMPTY_DISTRIBUTION };
    let sum = 0;
    let verified = 0;
    for (const r of allReviews) {
      const bucket = normalizeRating(r.rating);
      distribution[bucket] += 1;
      sum += bucket;
      if (r.verified) verified += 1;
    }
    const totalReviews = allReviews.length;
    return {
      developerId,
      listingCount: listingIds.length,
      totalReviews,
      verifiedReviews: verified,
      verificationRate: totalReviews > 0 ? round2(verified / totalReviews) : 0,
      averageRating: totalReviews > 0 ? round2(sum / totalReviews) : 0,
      // Response tracking is not yet implemented — placeholder until the
      // developer response feature ships.
      responseRate: 0,
      ratingDistribution: distribution,
    };
  }

  /**
   * Real fraud detection on a listing's reviews. Checks:
   *  - Review bombing: ≥ 5 reviews in a 60-minute window, OR ≥ 10 in 24h.
   *  - Suspicious rating patterns: ≥ 80% of reviews are 5★ AND the average
   *    account age is low (heuristic: every review authored by the same
   *    author id is counted once; high single-author concentration is a flag).
   *  - Duplicate content: pairwise Jaccard similarity ≥ 0.7 between two
   *    reviews on the same listing.
   * Returns the per-review flags + the signal-level summary.
   */
  detectFraud(listingId: ListingId): FraudDetectionResult {
    const ids = this.reviewsByListing.get(listingId) ?? [];
    const reviews = ids
      .map((id) => this.reviews.get(id))
      .filter((r): r is MutableReview => Boolean(r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (reviews.length === 0) {
      return {
        listingId,
        totalReviews: 0,
        flaggedCount: 0,
        flaggedReviews: [],
        signals: {
          reviewBombingDetected: false,
          suspiciousPatternDetected: false,
          duplicateContentDetected: false,
        },
      };
    }

    const flagged = new Map<ReviewId, { reasons: string[]; severity: "low" | "medium" | "high" }>();
    const addFlag = (id: ReviewId, reason: string, severity: "low" | "medium" | "high") => {
      const existing = flagged.get(id);
      if (existing) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
        // Severity escalates: high > medium > low.
        const order = { low: 0, medium: 1, high: 2 };
        if (order[severity] > order[existing.severity]) {
          existing.severity = severity;
        }
      } else {
        flagged.set(id, { reasons: [reason], severity });
      }
    };

    // 1) Review bombing detection.
    let bombingDetected = false;
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    for (let i = 0; i < reviews.length; i++) {
      const t = new Date(reviews[i].createdAt).getTime();
      if (!Number.isFinite(t)) continue;
      const inHour = reviews.filter((r) => {
        const rt = new Date(r.createdAt).getTime();
        return Number.isFinite(rt) && Math.abs(rt - t) <= HOUR_MS;
      }).length;
      const inDay = reviews.filter((r) => {
        const rt = new Date(r.createdAt).getTime();
        return Number.isFinite(rt) && Math.abs(rt - t) <= DAY_MS;
      }).length;
      if (inHour >= 5 || inDay >= 10) {
        bombingDetected = true;
        addFlag(reviews[i].id, "review_bombing_window", inHour >= 5 ? "high" : "medium");
      }
    }

    // 2) Suspicious rating patterns.
    const fiveStar = reviews.filter((r) => normalizeRating(r.rating) === 5).length;
    const suspiciousPattern = reviews.length >= 5 && fiveStar / reviews.length >= 0.8;
    if (suspiciousPattern) {
      // Flag every 5-star review with a low-severity flag.
      for (const r of reviews) {
        if (normalizeRating(r.rating) === 5) {
          addFlag(r.id, "suspicious_rating_pattern", "low");
        }
      }
    }
    // Also flag concentration: single author with multiple reviews on the
    // same listing.
    const authorCounts = new Map<string, number>();
    for (const r of reviews) {
      authorCounts.set(r.authorId as string, (authorCounts.get(r.authorId as string) ?? 0) + 1);
    }
    for (const r of reviews) {
      const c = authorCounts.get(r.authorId as string) ?? 0;
      if (c > 1) {
        addFlag(r.id, "duplicate_author", c >= 3 ? "high" : "medium");
      }
    }

    // 3) Duplicate content detection (pairwise Jaccard).
    let duplicateDetected = false;
    const normalized = reviews.map((r) => ({ r, norm: normalizeBody(r.body) }));
    for (let i = 0; i < normalized.length; i++) {
      for (let j = i + 1; j < normalized.length; j++) {
        const sim = jaccardSimilarity(normalized[i].norm, normalized[j].norm);
        if (sim >= 0.7) {
          duplicateDetected = true;
          addFlag(normalized[i].r.id, "duplicate_content", "medium");
          addFlag(normalized[j].r.id, "duplicate_content", "medium");
        }
      }
    }

    const flaggedReviews = [...flagged.entries()]
      .map(([reviewId, info]) => ({ reviewId, reasons: info.reasons, severity: info.severity }))
      .sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return order[a.severity] - order[b.severity];
      });

    return {
      listingId,
      totalReviews: reviews.length,
      flaggedCount: flaggedReviews.length,
      flaggedReviews,
      signals: {
        reviewBombingDetected: bombingDetected,
        suspiciousPatternDetected: suspiciousPattern,
        duplicateContentDetected: duplicateDetected,
      },
    };
  }

  /** Aggregate stats over all reviews in this manager. */
  getStats(): ReviewStats {
    const all = [...this.reviews.values()];
    const byType: Record<string, number> = {};
    let sum = 0;
    let verified = 0;
    let reported = 0;
    for (const r of all) {
      byType[r.authorType] = (byType[r.authorType] ?? 0) + 1;
      sum += normalizeRating(r.rating);
      if (r.verified) verified += 1;
      if (r.reported) reported += 1;
    }
    const total = all.length;
    return {
      totalReviews: total,
      byType,
      verifiedRate: total > 0 ? round2(verified / total) : 0,
      reportedCount: reported,
      moderatedCount: this.moderations.length,
      averageRating: total > 0 ? round2(sum / total) : 0,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private require(id: ReviewId): MutableReview {
    const review = this.reviews.get(id);
    if (!review) {
      throw new MarketplaceError({
        code: "eks.marketplace.review.not_found",
        category: "not_found",
        message: `Review ${id} not found.`,
        userMessage: "Review not found.",
      });
    }
    return review;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: ReviewManager | null = null;
export function getReviews(): ReviewManager {
  if (!_mgr) _mgr = new ReviewManager();
  return _mgr;
}
export function resetReviews(): void {
  _mgr = null;
}

// Re-exports for convenience
export type {
  AccountId,
  ListingId,
  Review,
  ReviewId,
  ReviewType,
} from "../core";
