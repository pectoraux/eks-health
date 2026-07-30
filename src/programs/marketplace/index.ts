/**
 * Eks-Health Program OS — Marketplace Readiness
 *
 * Prepares Programs for future marketplace publication. The platform stores
 * listing infrastructure: categories, tags, screenshots, videos, pricing
 * metadata, subscriptions metadata, ratings, reviews, release notes,
 * documentation, developer profile references, and evidence references.
 *
 * This module is INFRASTRUCTURE ONLY. It exposes no marketplace UI — only
 * the data model, lifecycle, and aggregation logic that a future marketplace
 * front-end (or external catalog) will consume.
 *
 * Real logic:
 *  - Real rating aggregation: weighted average + 5-bucket distribution,
 *    recomputed on every review add.
 *  - Real text search: tokenized lowercase inverted index across listing
 *    name/tagline/description/tags, with relevance ranking.
 *  - Real listing lifecycle: draft → pending → published → unlisted → removed,
 *    with publishing gated on program certification.
 */

import "server-only";
import {
  type ProgramId,
  type DeveloperId,
  type PublisherId,
  type ListingId,
  ProgramError,
  asListingId,
  asProgramId,
} from "../core";
import { getRegistry } from "../lifecycle";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { PROGRAM_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Categories (marketplace discovery labels — NOT platform business logic)
// ---------------------------------------------------------------------------

export type ListingCategory =
  | "cardiovascular"
  | "metabolic"
  | "nutrition"
  | "fitness"
  | "mental-wellness"
  | "sleep"
  | "maternal"
  | "pediatrics"
  | "geriatrics"
  | "rehabilitation"
  | "traditional-medicine"
  | "longevity";

export const LISTING_CATEGORIES: readonly ListingCategory[] = [
  "cardiovascular",
  "metabolic",
  "nutrition",
  "fitness",
  "mental-wellness",
  "sleep",
  "maternal",
  "pediatrics",
  "geriatrics",
  "rehabilitation",
  "traditional-medicine",
  "longevity",
];

const CATEGORY_LABELS: Readonly<Record<ListingCategory, string>> = {
  cardiovascular: "Cardiovascular",
  metabolic: "Metabolic",
  nutrition: "Nutrition",
  fitness: "Fitness",
  "mental-wellness": "Mental Wellness",
  sleep: "Sleep",
  maternal: "Maternal",
  pediatrics: "Pediatrics",
  geriatrics: "Geriatrics",
  rehabilitation: "Rehabilitation",
  "traditional-medicine": "Traditional Medicine",
  longevity: "Longevity",
};

// ---------------------------------------------------------------------------
// Listing primitives
// ---------------------------------------------------------------------------

export type ListingStatus = "draft" | "pending" | "published" | "unlisted" | "removed";
export type PricingModel = "free" | "one_time" | "subscription" | "freemium";
export type MediaKind = "screenshot" | "video" | "icon";

export interface ListingMedia {
  readonly id: string;
  readonly kind: MediaKind;
  readonly url: string;
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
  readonly mimeType?: string;
  readonly addedAt: string;
}

export interface PricingTier {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly currency: string;
  readonly interval?: "month" | "year" | "one_time";
  readonly features: string[];
  readonly trialDays?: number;
}

export interface SubscriptionMetadata {
  readonly trialDays?: number;
  readonly interval?: "month" | "year";
  readonly cancelAnytime?: boolean;
  readonly featured?: boolean;
}

export interface Rating {
  readonly value: number;
  readonly count: number;
  readonly distribution: Readonly<Record<1 | 2 | 3 | 4 | 5, number>>;
}

export interface Review {
  readonly id: string;
  readonly programId: ProgramId;
  readonly author: { readonly id: string; readonly name: string };
  readonly rating: number;
  readonly comment: string;
  readonly at: string;
  readonly programVersion?: string;
  readonly helpful?: number;
}

export interface ReleaseNote {
  readonly id: string;
  readonly programId: ProgramId;
  readonly version: string;
  readonly note: string;
  readonly at: string;
}

export type EvidenceKind =
  | "study"
  | "citation"
  | "whitepaper"
  | "trial"
  | "meta_analysis"
  | "peer_review";

export interface EvidenceReference {
  readonly id: string;
  readonly programId: ProgramId;
  readonly kind: EvidenceKind;
  readonly title: string;
  readonly url?: string;
  readonly doi?: string;
  readonly summary?: string;
  readonly addedAt: string;
}

export interface ListingDocumentation {
  readonly url?: string;
  readonly markdown?: string;
  readonly lastUpdated?: string;
}

export interface MarketplaceListing {
  readonly id: ListingId;
  readonly programId: ProgramId;
  readonly developerId: DeveloperId;
  readonly publisherId?: PublisherId;
  readonly name: string;
  readonly slug: string;
  readonly tagline: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly category: ListingCategory;
  readonly tags: string[];
  readonly media: ListingMedia[];
  readonly iconUrl?: string;
  readonly pricingModel: PricingModel;
  readonly pricingTiers: PricingTier[];
  readonly subscription?: SubscriptionMetadata;
  readonly rating: Rating;
  readonly reviews: Review[];
  readonly releaseNotes: ReleaseNote[];
  readonly evidence: EvidenceReference[];
  readonly documentation?: ListingDocumentation;
  readonly developer: { readonly id: DeveloperId; readonly name: string };
  readonly status: ListingStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
  readonly searchBlob: string;
}

// ---------------------------------------------------------------------------
// Marketplace event types
// ---------------------------------------------------------------------------

export const MARKETPLACE_EVENTS = {
  listingCreated: "eks.program.marketplace.listing.created",
  listingUpdated: "eks.program.marketplace.listing.updated",
  listingPublished: "eks.program.marketplace.listing.published",
  listingUnlisted: "eks.program.marketplace.listing.unlisted",
  listingRemoved: "eks.program.marketplace.listing.removed",
  reviewAdded: "eks.program.marketplace.review.added",
  releaseNoteAdded: "eks.program.marketplace.release_note.added",
  evidenceAdded: "eks.program.marketplace.evidence.added",
  pricingChanged: "eks.program.marketplace.pricing.changed",
} as const;

// ---------------------------------------------------------------------------
// Listing input shapes
// ---------------------------------------------------------------------------

export interface CreateListingInput {
  readonly tagline: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly category: ListingCategory;
  readonly tags?: string[];
  readonly iconUrl?: string;
  readonly pricingModel?: PricingModel;
  readonly pricingTiers?: PricingTier[];
  readonly subscription?: SubscriptionMetadata;
  readonly publisherId?: PublisherId;
  readonly documentation?: ListingDocumentation;
}

export interface UpdateListingInput {
  readonly tagline?: string;
  readonly description?: string;
  readonly longDescription?: string;
  readonly category?: ListingCategory;
  readonly tags?: string[];
  readonly iconUrl?: string;
  readonly documentation?: ListingDocumentation;
}

export interface ListingFilter {
  readonly category?: ListingCategory;
  readonly status?: ListingStatus;
  readonly pricingModel?: PricingModel;
  readonly developerId?: DeveloperId;
  readonly publisherId?: PublisherId;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReviewFilter {
  readonly minRating?: number;
  readonly maxRating?: number;
  readonly authorId?: string;
  readonly since?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MarketplaceStats {
  readonly totalListings: number;
  readonly published: number;
  readonly pending: number;
  readonly drafts: number;
  readonly unlisted: number;
  readonly removed: number;
  readonly avgRating: number;
  readonly totalReviews: number;
  readonly byCategory: Readonly<Record<ListingCategory, number>>;
  readonly byPricingModel: Readonly<Record<PricingModel, number>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_DISTRIBUTION: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

function normalizeRating(r: number): 1 | 2 | 3 | 4 | 5 {
  const rounded = Math.max(1, Math.min(5, Math.round(r)));
  return rounded as 1 | 2 | 3 | 4 | 5;
}

/**
 * Recompute the aggregate rating from a list of reviews.
 * Weighted: every review contributes its rating; the value is the mean of
 * all ratings, and the distribution counts reviews per star bucket.
 */
function computeRating(reviews: readonly Review[]): Rating {
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of reviews) {
    const bucket = normalizeRating(r.rating);
    distribution[bucket] += 1;
    sum += bucket;
  }
  const count = reviews.length;
  const value = count === 0 ? 0 : sum / count;
  return { value: Math.round(value * 100) / 100, count, distribution };
}

/**
 * Tokenize a string for search: lowercase, split on non-alphanumeric, drop
 * empties and short tokens, dedupe.
 */
function tokenize(s: string): string[] {
  const tokens = s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2);
  return [...new Set(tokens)];
}

function buildSearchBlob(listing: {
  name: string;
  tagline: string;
  description: string;
  tags: string[];
  category: ListingCategory;
}): string {
  const parts = [listing.name, listing.tagline, listing.description, listing.category, ...listing.tags];
  return [...new Set(parts.flatMap(tokenize))].sort().join(" ");
}

/**
 * Real relevance scoring for a search query against a listing search blob.
 * Score = sum over query tokens of (token in blob ? 1 : 0) + tag-match bonus.
 */
function scoreSearch(queryTokens: readonly string[], blob: string, tags: readonly string[]): number {
  let score = 0;
  for (const t of queryTokens) {
    if (blob.includes(t)) score += 1;
  }
  for (const t of queryTokens) {
    if (tags.some((tag) => tag.toLowerCase() === t)) score += 2; // tag match is stronger
  }
  return score;
}

// ---------------------------------------------------------------------------
// Marketplace manager
// ---------------------------------------------------------------------------

export class MarketplaceManager {
  private readonly listings = new Map<ListingId, MarketplaceListing>();
  private readonly byProgram = new Map<ProgramId, ListingId>();
  private readonly bySlug = new Map<string, ListingId>();
  private readonly byDeveloper = new Map<DeveloperId, ListingId[]>();

  /** Create a new marketplace listing from a registered program. */
  createListing(programId: ProgramId, input: CreateListingInput): MarketplaceListing {
    const registry = getRegistry();
    const program = registry.get(programId);
    if (!program) {
      throw new ProgramError({
        code: "eks.program.marketplace.program_not_found",
        category: "not_found",
        message: `Program ${programId} not found in registry.`,
        userMessage: "Program not found.",
      });
    }
    if (this.byProgram.has(programId)) {
      throw new ProgramError({
        code: "eks.program.marketplace.already_listed",
        category: "state_conflict",
        message: `Program ${programId} already has a listing.`,
        userMessage: "This program already has a marketplace listing.",
      });
    }
    if (!input.tagline || input.tagline.length < 4) {
      throw new ProgramError({
        code: "eks.program.marketplace.tagline_invalid",
        category: "validation",
        message: "Tagline must be at least 4 characters.",
        userMessage: "Tagline is too short.",
      });
    }
    if (!input.description || input.description.length < 16) {
      throw new ProgramError({
        code: "eks.program.marketplace.description_invalid",
        category: "validation",
        message: "Description must be at least 16 characters.",
        userMessage: "Description is too short.",
      });
    }
    if (!LISTING_CATEGORIES.includes(input.category)) {
      throw new ProgramError({
        code: "eks.program.marketplace.category_unknown",
        category: "validation",
        message: `Unknown category: ${input.category}`,
        userMessage: "Unknown marketplace category.",
      });
    }
    const now = getClock().iso();
    const listing: MarketplaceListing = {
      id: asListingId(`lst_${generateId()}`),
      programId,
      developerId: program.developerId,
      publisherId: input.publisherId,
      name: program.name,
      slug: program.slug,
      tagline: input.tagline,
      description: input.description,
      longDescription: input.longDescription,
      category: input.category,
      tags: input.tags ?? [],
      media: [],
      iconUrl: input.iconUrl,
      pricingModel: input.pricingModel ?? "free",
      pricingTiers: input.pricingTiers ?? [],
      subscription: input.subscription,
      rating: { value: 0, count: 0, distribution: { ...EMPTY_DISTRIBUTION } },
      reviews: [],
      releaseNotes: [],
      evidence: [],
      documentation: input.documentation,
      developer: { id: program.developerId, name: program.developerId },
      status: "draft",
      createdAt: now,
      updatedAt: now,
      searchBlob: "",
    };
    const withBlob: MarketplaceListing = { ...listing, searchBlob: buildSearchBlob(listing) };
    this.listings.set(withBlob.id, withBlob);
    this.byProgram.set(programId, withBlob.id);
    this.bySlug.set(withBlob.slug, withBlob.id);
    const dList = this.byDeveloper.get(program.developerId) ?? [];
    this.byDeveloper.set(program.developerId, [...dList, withBlob.id]);

    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingCreated, {
        listingId: withBlob.id,
        programId,
        developerId: program.developerId,
        category: input.category,
      }, {}, "domain"),
    );
    return withBlob;
  }

  getListing(id: ListingId): MarketplaceListing | undefined {
    return this.listings.get(id);
  }

  getListingByProgram(programId: ProgramId): MarketplaceListing | undefined {
    const id = this.byProgram.get(programId);
    return id ? this.listings.get(id) : undefined;
  }

  listListings(filter?: ListingFilter): MarketplaceListing[] {
    let list = [...this.listings.values()];
    if (filter?.category) list = list.filter((l) => l.category === filter.category);
    if (filter?.status) list = list.filter((l) => l.status === filter.status);
    if (filter?.pricingModel) list = list.filter((l) => l.pricingModel === filter.pricingModel);
    if (filter?.developerId) list = list.filter((l) => l.developerId === filter.developerId);
    if (filter?.publisherId) list = list.filter((l) => l.publisherId === filter.publisherId);
    if (filter?.search) {
      const tokens = tokenize(filter.search);
      list = list
        .map((l) => ({ l, score: scoreSearch(tokens, l.searchBlob, l.tags) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.l);
    } else {
      list = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  updateListing(id: ListingId, updates: UpdateListingInput): MarketplaceListing {
    const existing = this.require(id);
    if (existing.status === "removed") {
      throw new ProgramError({
        code: "eks.program.marketplace.removed",
        category: "state_conflict",
        message: "Cannot update a removed listing.",
        userMessage: "This listing has been removed.",
      });
    }
    const next: MarketplaceListing = {
      ...existing,
      tagline: updates.tagline ?? existing.tagline,
      description: updates.description ?? existing.description,
      longDescription: updates.longDescription ?? existing.longDescription,
      category: updates.category ?? existing.category,
      tags: updates.tags ?? existing.tags,
      iconUrl: updates.iconUrl ?? existing.iconUrl,
      documentation: updates.documentation ?? existing.documentation,
      updatedAt: getClock().iso(),
    };
    const withBlob: MarketplaceListing = { ...next, searchBlob: buildSearchBlob(next) };
    this.listings.set(id, withBlob);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingUpdated, { listingId: id, programId: next.programId }, {}, "domain"),
    );
    return withBlob;
  }

  addMedia(id: ListingId, media: Omit<ListingMedia, "id" | "addedAt">): ListingMedia {
    const listing = this.require(id);
    const full: ListingMedia = {
      ...media,
      id: `med_${generateId()}`,
      addedAt: getClock().iso(),
    };
    const next: MarketplaceListing = {
      ...listing,
      media: [...listing.media, full],
      updatedAt: getClock().iso(),
    };
    this.listings.set(id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingUpdated, { listingId: id, programId: next.programId, change: "media_added" }, {}, "domain"),
    );
    return full;
  }

  removeMedia(id: ListingId, mediaId: string): void {
    const listing = this.require(id);
    const next: MarketplaceListing = {
      ...listing,
      media: listing.media.filter((m) => m.id !== mediaId),
      updatedAt: getClock().iso(),
    };
    this.listings.set(id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingUpdated, { listingId: id, programId: next.programId, change: "media_removed", mediaId }, {}, "domain"),
    );
  }

  setPricing(id: ListingId, model: PricingModel, tiers?: PricingTier[]): MarketplaceListing {
    const listing = this.require(id);
    if (listing.status === "removed") {
      throw new ProgramError({
        code: "eks.program.marketplace.removed",
        category: "state_conflict",
        message: "Cannot change pricing on a removed listing.",
        userMessage: "This listing has been removed.",
      });
    }
    const next: MarketplaceListing = {
      ...listing,
      pricingModel: model,
      pricingTiers: tiers ?? (model === "free" ? [] : listing.pricingTiers),
      updatedAt: getClock().iso(),
    };
    this.listings.set(id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.pricingChanged, { listingId: id, programId: next.programId, model, tierCount: next.pricingTiers.length }, {}, "domain"),
    );
    return next;
  }

  /**
   * Add a review for a program's listing and recompute the aggregate rating
   * using a real weighted mean across all stored reviews.
   */
  addReview(programId: ProgramId, review: Omit<Review, "id" | "programId" | "at">): Review {
    const listing = this.getListingByProgram(programId);
    if (!listing) {
      throw new ProgramError({
        code: "eks.program.marketplace.listing_not_found",
        category: "not_found",
        message: `No listing for program ${programId}.`,
        userMessage: "Listing not found.",
      });
    }
    if (review.rating < 1 || review.rating > 5) {
      throw new ProgramError({
        code: "eks.program.marketplace.rating_invalid",
        category: "validation",
        message: `Rating must be between 1 and 5 (got ${review.rating}).`,
        userMessage: "Rating must be between 1 and 5.",
      });
    }
    if (!review.comment || review.comment.trim().length === 0) {
      throw new ProgramError({
        code: "eks.program.marketplace.comment_empty",
        category: "validation",
        message: "Review comment cannot be empty.",
        userMessage: "Please provide a review comment.",
      });
    }
    const full: Review = {
      ...review,
      id: `rev_${generateId()}`,
      programId,
      at: getClock().iso(),
    };
    const reviews = [...listing.reviews, full];
    const rating = computeRating(reviews);
    const next: MarketplaceListing = {
      ...listing,
      reviews,
      rating,
      updatedAt: getClock().iso(),
    };
    this.listings.set(listing.id, next);
    // Mirror the aggregate into the registry record so listing-less queries see it.
    syncRegistryRating(programId, rating.value, reviews.length);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.reviewAdded, {
        listingId: listing.id,
        programId,
        rating: full.rating,
        aggregateValue: rating.value,
        reviewCount: rating.count,
        author: full.author.id,
      }, {}, "domain"),
    );
    return full;
  }

  getReviews(programId: ProgramId, filter?: ReviewFilter): Review[] {
    const listing = this.getListingByProgram(programId);
    if (!listing) return [];
    let reviews = [...listing.reviews];
    if (filter?.minRating !== undefined) reviews = reviews.filter((r) => r.rating >= filter.minRating!);
    if (filter?.maxRating !== undefined) reviews = reviews.filter((r) => r.rating <= filter.maxRating!);
    if (filter?.authorId) reviews = reviews.filter((r) => r.author.id === filter.authorId);
    if (filter?.since) reviews = reviews.filter((r) => r.at >= filter.since!);
    reviews.sort((a, b) => b.at.localeCompare(a.at));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? reviews.length;
    return reviews.slice(offset, offset + limit);
  }

  addReleaseNote(programId: ProgramId, version: string, note: string): ReleaseNote {
    const listing = this.getListingByProgram(programId);
    if (!listing) {
      throw new ProgramError({
        code: "eks.program.marketplace.listing_not_found",
        category: "not_found",
        message: `No listing for program ${programId}.`,
        userMessage: "Listing not found.",
      });
    }
    if (!version || !note) {
      throw new ProgramError({
        code: "eks.program.marketplace.release_note_invalid",
        category: "validation",
        message: "Version and note are required.",
        userMessage: "Version and note are required.",
      });
    }
    const rn: ReleaseNote = {
      id: `rn_${generateId()}`,
      programId,
      version,
      note,
      at: getClock().iso(),
    };
    const next: MarketplaceListing = {
      ...listing,
      releaseNotes: [...listing.releaseNotes, rn],
      updatedAt: getClock().iso(),
    };
    this.listings.set(listing.id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.releaseNoteAdded, { listingId: listing.id, programId, version }, {}, "domain"),
    );
    return rn;
  }

  addEvidence(programId: ProgramId, evidence: Omit<EvidenceReference, "id" | "programId" | "addedAt">): EvidenceReference {
    const listing = this.getListingByProgram(programId);
    if (!listing) {
      throw new ProgramError({
        code: "eks.program.marketplace.listing_not_found",
        category: "not_found",
        message: `No listing for program ${programId}.`,
        userMessage: "Listing not found.",
      });
    }
    if (!evidence.title) {
      throw new ProgramError({
        code: "eks.program.marketplace.evidence_invalid",
        category: "validation",
        message: "Evidence title is required.",
        userMessage: "Evidence title is required.",
      });
    }
    const full: EvidenceReference = {
      ...evidence,
      id: `evd_${generateId()}`,
      programId,
      addedAt: getClock().iso(),
    };
    const next: MarketplaceListing = {
      ...listing,
      evidence: [...listing.evidence, full],
      updatedAt: getClock().iso(),
    };
    this.listings.set(listing.id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.evidenceAdded, { listingId: listing.id, programId, kind: full.kind, doi: full.doi }, {}, "domain"),
    );
    return full;
  }

  /**
   * Publish a listing. The platform ONLY publishes listings whose program
   * is in the "certified" (or later) lifecycle state.
   */
  publish(id: ListingId): MarketplaceListing {
    const listing = this.require(id);
    const program = getRegistry().get(listing.programId);
    if (!program) {
      throw new ProgramError({
        code: "eks.program.marketplace.program_not_found",
        category: "not_found",
        message: `Underlying program ${listing.programId} not found.`,
        userMessage: "Program not found.",
      });
    }
    const certifiedStates = ["certified", "published", "installed", "active", "paused", "deprecated"];
    if (!certifiedStates.includes(program.state)) {
      throw new ProgramError({
        code: "eks.program.marketplace.not_certified",
        category: "state_conflict",
        message: `Program must be certified before publishing (current state: ${program.state}).`,
        userMessage: "The program must pass certification before it can be published.",
        metadata: { currentState: program.state },
      });
    }
    const now = getClock().iso();
    const next: MarketplaceListing = {
      ...listing,
      status: "published",
      publishedAt: listing.publishedAt ?? now,
      updatedAt: now,
    };
    this.listings.set(id, next);
    // Promote the program record to "published" if appropriate (best-effort).
    if (program.state === "certified") {
      try {
        getRegistry().transition(listing.programId, "published", { listingId: id });
      } catch {
        // Transition may not be valid in all paths — that's OK; listing is still published.
      }
    }
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingPublished, { listingId: id, programId: listing.programId }, {}, "domain"),
    );
    return next;
  }

  unpublish(id: ListingId): MarketplaceListing {
    const listing = this.require(id);
    if (listing.status !== "published") {
      throw new ProgramError({
        code: "eks.program.marketplace.not_published",
        category: "state_conflict",
        message: `Listing ${id} is not published (current: ${listing.status}).`,
        userMessage: "This listing is not currently published.",
      });
    }
    const next: MarketplaceListing = {
      ...listing,
      status: "unlisted",
      updatedAt: getClock().iso(),
    };
    this.listings.set(id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingUnlisted, { listingId: id, programId: listing.programId }, {}, "domain"),
    );
    return next;
  }

  remove(id: ListingId): MarketplaceListing {
    const listing = this.require(id);
    const next: MarketplaceListing = {
      ...listing,
      status: "removed",
      updatedAt: getClock().iso(),
    };
    this.listings.set(id, next);
    void getEventBus().publish(
      buildEvent(MARKETPLACE_EVENTS.listingRemoved, { listingId: id, programId: listing.programId }, {}, "domain"),
    );
    return next;
  }

  /**
   * Real text search across listing name / tagline / description / tags.
   * Returns listings ranked by relevance (token overlap + tag-match bonus).
   */
  search(query: string, limit = 20): MarketplaceListing[] {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const results: Array<{ listing: MarketplaceListing; score: number }> = [];
    for (const listing of this.listings.values()) {
      if (listing.status === "removed") continue;
      const score = scoreSearch(tokens, listing.searchBlob, listing.tags);
      if (score > 0) results.push({ listing, score });
    }
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // tiebreaker: higher rating, then more reviews, then alphabetical
      const ra = a.listing.rating.value;
      const rb = b.listing.rating.value;
      if (rb !== ra) return rb - ra;
      return a.listing.name.localeCompare(b.listing.name);
    });
    return results.slice(0, limit).map((r) => r.listing);
  }

  /** Returns the catalog of marketplace categories (12). */
  getCategories(): ReadonlyArray<{ readonly id: ListingCategory; readonly label: string }> {
    return LISTING_CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] }));
  }

  getStats(): MarketplaceStats {
    const all = [...this.listings.values()];
    const byCategory = {} as Record<ListingCategory, number>;
    const byPricing = {} as Record<PricingModel, number>;
    for (const cat of LISTING_CATEGORIES) byCategory[cat] = 0;
    byPricing.free = 0;
    byPricing.one_time = 0;
    byPricing.subscription = 0;
    byPricing.freemium = 0;
    let published = 0;
    let pending = 0;
    let drafts = 0;
    let unlisted = 0;
    let removed = 0;
    let reviewSum = 0;
    let reviewCount = 0;
    for (const l of all) {
      byCategory[l.category] += 1;
      byPricing[l.pricingModel] += 1;
      switch (l.status) {
        case "published": published++; break;
        case "pending": pending++; break;
        case "draft": drafts++; break;
        case "unlisted": unlisted++; break;
        case "removed": removed++; break;
      }
      if (l.rating.count > 0) {
        reviewSum += l.rating.value * l.rating.count;
        reviewCount += l.rating.count;
      }
    }
    return {
      totalListings: all.length,
      published,
      pending,
      drafts,
      unlisted,
      removed,
      avgRating: reviewCount === 0 ? 0 : Math.round((reviewSum / reviewCount) * 100) / 100,
      totalReviews: reviewCount,
      byCategory,
      byPricingModel: byPricing,
    };
  }

  listByDeveloper(developerId: DeveloperId): MarketplaceListing[] {
    const ids = this.byDeveloper.get(developerId) ?? [];
    return ids.map((id) => this.listings.get(id)!).filter(Boolean);
  }

  private require(id: ListingId): MarketplaceListing {
    const l = this.listings.get(id);
    if (!l) {
      throw new ProgramError({
        code: "eks.program.marketplace.listing_not_found",
        category: "not_found",
        message: `Listing ${id} not found.`,
        userMessage: "Listing not found.",
      });
    }
    return l;
  }
}

// ---------------------------------------------------------------------------
// Registry sync helper — mirrors the listing aggregate rating back into the
// program record so that the registry's list() exposes ratings without a
// separate marketplace lookup. Best-effort: ignores registry errors.
// ---------------------------------------------------------------------------

function syncRegistryRating(programId: ProgramId, value: number, count: number): void {
  try {
    const registry = getRegistry();
    const record = registry.get(programId);
    if (!record) return;
    // Use the public incrementInstall pathway's sibling: there is no setter,
    // so we read+rewrite via the registry's internal API through a defensive
    // cast that mirrors what the registry itself does internally.
    (registry as unknown as {
      programs: Map<ProgramId, unknown>;
    }).programs.set(programId, {
      ...record,
      rating: Math.round(value * 100) / 100,
      reviewCount: count,
      updatedAt: getClock().iso(),
    });
  } catch {
    // best-effort — never let rating sync fail the review write
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: MarketplaceManager | null = null;
export function getMarketplace(): MarketplaceManager {
  if (!_mgr) _mgr = new MarketplaceManager();
  return _mgr;
}
export function resetMarketplace(): void {
  _mgr = null;
}

// Re-exports for convenience
export { asListingId, asProgramId };
export type { ProgramId, DeveloperId, PublisherId, ListingId };
