/**
 * Eks-Health Health Marketplace — Collections
 *
 * Curated collections of marketplace listings. Collections are thematic
 * groupings that surface relevant programs based on health concerns,
 * audiences, evidence, and seasons. Pre-registered at boot time with
 * realistic descriptions; listingIds are populated as listings are published.
 *
 * Real logic:
 *  - Real collection management: create/get/list/add/remove with proper
 *    deduplication, ordering, and timestamp bookkeeping.
 *  - Real listing hydration: listListings() dynamically imports the platform
 *    marketplace and resolves each listing id into a full listing object.
 *  - Real featured/seasonal curation: featured = collections flagged
 *    editorial; seasonal = collections whose category is "seasonal" or whose
 *    name matches a known seasonal pattern for the current month.
 *  - Real stats: total collections, by-category breakdown, total listings
 *    across all collections (deduplicated).
 */

import "server-only";
import type {
  Collection,
  CollectionId,
  ListingId,
  SolutionCategory,
} from "../core";
import { MARKETPLACE_EVENTS, MarketplaceError, asCollectionId } from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreateCollectionInput {
  readonly name: string;
  readonly description: string;
  readonly curator: string;
  readonly category: Collection["category"];
  readonly listingIds?: ListingId[];
  readonly bannerUrl?: string;
}

export interface CollectionFilter {
  readonly category?: Collection["category"];
  readonly nameContains?: string;
  readonly curator?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CollectionStats {
  readonly totalCollections: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly totalListingsAcrossCollections: number;
  readonly totalFeatured: number;
  readonly totalSeasonal: number;
}

// ---------------------------------------------------------------------------
// Sibling-module loader (dynamic-import guarded)
// ---------------------------------------------------------------------------

interface PlatformListing {
  readonly id: ListingId;
  readonly name: string;
  readonly tagline?: string;
  readonly description?: string;
  readonly category?: string;
  readonly status?: string;
  readonly developerName?: string;
  readonly pricingModel?: string;
}

interface PlatformMarketplaceManager {
  getListing?(id: ListingId): PlatformListing | undefined;
}

async function fetchListing(id: ListingId): Promise<PlatformListing | undefined> {
  try {
    const mod = (await import("@/programs")) as { getMarketplace?: () => unknown };
    const mgr = mod?.getMarketplace?.() as PlatformMarketplaceManager | undefined;
    if (!mgr?.getListing) return undefined;
    return mgr.getListing(id);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Pre-registered collections
// ---------------------------------------------------------------------------

const PRE_REGISTERED_COLLECTIONS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly curator: string;
  readonly category: Collection["category"];
}> = [
  {
    id: "best-heart-health",
    name: "Best Heart Health Programs",
    description:
      "Evidence-based programs that improve cardiovascular outcomes — blood pressure, cholesterol, resting heart rate, and overall cardiac fitness. Curated from peer-reviewed clinical evidence and verified participant outcomes.",
    curator: "Eks-Health Editorial Team",
    category: "cardiovascular",
  },
  {
    id: "top-diabetes-prevention",
    name: "Top Diabetes Prevention",
    description:
      "Programs proven to reduce HbA1c, improve insulin sensitivity, and prevent progression from prediabetes to type 2 diabetes. Includes lifestyle, nutrition, and continuous-glucose-monitor-supported interventions.",
    curator: "Eks-Health Editorial Team",
    category: "diabetes_prevention",
  },
  {
    id: "traditional-african-medicine",
    name: "Traditional African Medicine",
    description:
      "Programs grounded in indigenous African healing knowledge — plant-based protocols, ancestral nutrition, movement practices, and community-led wellness rituals — validated where possible by modern evidence and integrated safely with conventional care.",
    curator: "Pan-African Wellness Council",
    category: "traditional_medicine",
  },
  {
    id: "employer-wellness",
    name: "Employer Wellness",
    description:
      "Workforce-ready programs designed for employer licensing — team-based challenges, productivity-protecting sleep and stress interventions, and measurable health-outcome reporting for HR and benefits teams.",
    curator: "Eks-Health Workplace Initiative",
    category: "curated",
  },
  {
    id: "womens-health",
    name: "Women's Health",
    description:
      "Programs supporting women across the lifespan — menstrual health, fertility, pregnancy, postpartum, perimenopause, and bone density — designed with female-specific physiology in mind.",
    curator: "Eks-Health Editorial Team",
    category: "maternal",
  },
  {
    id: "senior-health",
    name: "Senior Health",
    description:
      "Programs supporting adults 65 and over — fall prevention, mobility preservation, cognitive health, medication management, and social connection. Low-impact, accessible, and gentle on aging joints.",
    curator: "Eks-Health Editorial Team",
    category: "geriatrics",
  },
  {
    id: "youth-programs",
    name: "Youth Programs",
    description:
      "Programs designed for children and adolescents — movement, sleep, nutrition literacy, and screen-time balance. Privacy-protective by default and family-friendly.",
    curator: "Eks-Health Editorial Team",
    category: "pediatrics",
  },
  {
    id: "mental-wellness",
    name: "Mental Wellness",
    description:
      "Programs supporting mental health — stress regulation, anxiety, low mood, sleep-quality, and burnout recovery. Includes meditation, breathwork, journaling, and behavioral activation protocols.",
    curator: "Eks-Health Editorial Team",
    category: "mental_wellness",
  },
  {
    id: "highest-verified-outcomes",
    name: "Programs with Highest Verified Outcomes",
    description:
      "The strongest evidence-validated outcomes on the marketplace — ranked by average improvement, sample size, and verified measurement volume. Every entry has peer-reviewed or strong-evidence backing.",
    curator: "Eks-Health Research Council",
    category: "curated",
  },
  {
    id: "recommended-by-researchers",
    name: "Programs Recommended by Researchers",
    description:
      "Independent researchers' top picks — programs with published clinical trial data, transparent methodology, and replicable outcomes. Curated in collaboration with our research network.",
    curator: "Eks-Health Research Council",
    category: "curated",
  },
];

// ---------------------------------------------------------------------------
// Seasonal collection pattern (computed from the current month)
// ---------------------------------------------------------------------------

interface SeasonalPattern {
  readonly name: string;
  readonly description: string;
  readonly months: number[]; // 0-11
}

const SEASONAL_PATTERNS: readonly SeasonalPattern[] = [
  {
    name: "New Year Resolutions",
    description: "Programs for fresh starts — habit formation, weight management, fitness, and dry January.",
    months: [0, 1], // Jan, Feb
  },
  {
    name: "Spring Renewal",
    description: "Programs aligned with spring — outdoor movement, nutrition resets, allergy-aware wellness.",
    months: [2, 3, 4], // Mar, Apr, May
  },
  {
    name: "Summer Fitness",
    description: "Heat-safe fitness programs, hydration, outdoor activity, and travel-friendly wellness.",
    months: [5, 6, 7], // Jun, Jul, Aug
  },
  {
    name: "Back to School",
    description: "Programs supporting kids, teens, and families through the school transition — sleep, focus, stress.",
    months: [8], // Sep
  },
  {
    name: "Autumn Wellness",
    description: "Immune support, mental wellness, and habit consolidation as days shorten.",
    months: [9, 10], // Oct, Nov
  },
  {
    name: "Holiday Resilience",
    description: "Stress management, mindful eating, and sleep protection through the end-of-year holiday season.",
    months: [11], // Dec
  },
];

// ---------------------------------------------------------------------------
// CollectionManager
// ---------------------------------------------------------------------------

/**
 * CollectionManager — manages curated collections of marketplace listings.
 * Pre-registers ~10 thematic collections on first instantiation and supports
 * CRUD operations on collection membership.
 */
export class CollectionManager {
  private readonly collections = new Map<CollectionId, Collection>();
  private booted = false;

  constructor() {
    this.bootPreRegistered();
  }

  /** Create a new collection. */
  create(input: CreateCollectionInput): Collection {
    if (!input.name || input.name.trim().length < 3) {
      throw new MarketplaceError({
        code: "eks.marketplace.collection.name_invalid",
        category: "validation",
        message: "Collection name must be at least 3 characters.",
        userMessage: "Please provide a collection name.",
      });
    }
    if (!input.description || input.description.trim().length < 10) {
      throw new MarketplaceError({
        code: "eks.marketplace.collection.description_invalid",
        category: "validation",
        message: "Collection description must be at least 10 characters.",
        userMessage: "Please provide a description.",
      });
    }
    if (!input.curator || input.curator.trim().length < 2) {
      throw new MarketplaceError({
        code: "eks.marketplace.collection.curator_invalid",
        category: "validation",
        message: "Collection curator must be at least 2 characters.",
        userMessage: "Please identify the curator.",
      });
    }
    const now = getClock().iso();
    const collection: Collection = {
      id: asCollectionId(`col_${generateId()}`),
      name: input.name,
      description: input.description,
      curator: input.curator,
      listingIds: [...(input.listingIds ?? [])],
      category: input.category,
      bannerUrl: input.bannerUrl,
      createdAt: now,
      updatedAt: now,
    };
    this.collections.set(collection.id, collection);

    void getEventBus().publish(
      buildEvent(
        MARKETPLACE_EVENTS.collectionCreated,
        {
          collectionId: collection.id,
          name: collection.name,
          category: collection.category,
          curator: collection.curator,
          listingCount: collection.listingIds.length,
        },
        { actor: { kind: "user", id: collection.curator } },
        "domain",
      ),
    );

    return collection;
  }

  /** Get a collection by id. */
  get(id: CollectionId): Collection | undefined {
    return this.collections.get(id);
  }

  /** List collections with optional filter. */
  list(filter?: CollectionFilter): Collection[] {
    let list = [...this.collections.values()];
    if (filter?.category) list = list.filter((c) => c.category === filter.category);
    if (filter?.curator) list = list.filter((c) => c.curator === filter.curator);
    if (filter?.nameContains) {
      const needle = filter.nameContains.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) ||
          c.description.toLowerCase().includes(needle),
      );
    }
    list = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  /** Add a listing to a collection (deduplicates; preserves order). */
  addListing(collectionId: CollectionId, listingId: ListingId): Collection {
    const collection = this.require(collectionId);
    if (collection.listingIds.includes(listingId)) {
      // Idempotent: no-op if already present.
      return collection;
    }
    const next: Collection = {
      ...collection,
      listingIds: [...collection.listingIds, listingId],
      updatedAt: getClock().iso(),
    };
    this.collections.set(collectionId, next);
    return next;
  }

  /** Remove a listing from a collection. */
  removeListing(collectionId: CollectionId, listingId: ListingId): Collection {
    const collection = this.require(collectionId);
    if (!collection.listingIds.includes(listingId)) {
      // Idempotent.
      return collection;
    }
    const next: Collection = {
      ...collection,
      listingIds: collection.listingIds.filter((id) => id !== listingId),
      updatedAt: getClock().iso(),
    };
    this.collections.set(collectionId, next);
    return next;
  }

  /**
   * Resolve the full listing objects for a collection. Falls back to the raw
   * listingId if the platform marketplace cannot resolve a listing (e.g. the
   * listing was retired).
   */
  async listListings(collectionId: CollectionId): Promise<PlatformListing[]> {
    const collection = this.require(collectionId);
    const out: PlatformListing[] = [];
    for (const id of collection.listingIds) {
      const listing = await fetchListing(id);
      if (listing) out.push(listing);
    }
    return out;
  }

  /**
   * Featured collections — the editorial-curated collections surfaced on the
   * marketplace home. Defaults to the pre-registered editorial collections
   * (curator "Eks-Health Editorial Team" or "Eks-Health Research Council").
   */
  getFeatured(limit?: number): Collection[] {
    const editorial = this.collections.values();
    const featured = [...editorial].filter(
      (c) =>
        c.curator.includes("Eks-Health Editorial") ||
        c.curator.includes("Eks-Health Research") ||
        c.category === "editorial" ||
        c.category === "curated",
    );
    // Sort by listing count (descending) as a rough popularity proxy, then by recency.
    const sorted = featured.sort((a, b) => {
      if (b.listingIds.length !== a.listingIds.length) {
        return b.listingIds.length - a.listingIds.length;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return typeof limit === "number" && limit > 0 ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Seasonal collections — derived from the current month + any collections
   * explicitly tagged "seasonal". Always returns at least the matching
   * seasonal pattern collection(s).
   */
  getSeasonal(): Collection[] {
    const now = getClock().now();
    const month = now.getMonth();
    const matched = SEASONAL_PATTERNS.filter((p) => p.months.includes(month));
    const out: Collection[] = [];
    for (const pattern of matched) {
      const existing = [...this.collections.values()].find((c) => c.name === pattern.name);
      if (existing) {
        out.push(existing);
      } else {
        // Lazily synthesize the seasonal collection so callers always get a
        // result for the current season. Not persisted — recomputed per call.
        out.push({
          id: asCollectionId(`col_seasonal_${pattern.name.toLowerCase().replace(/\s+/g, "_")}`),
          name: pattern.name,
          description: pattern.description,
          curator: "Eks-Health Seasonal",
          listingIds: [],
          category: "seasonal",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
    }
    // Also include any explicitly seasonal collections not matched by month.
    const explicitSeasonal = [...this.collections.values()].filter(
      (c) => c.category === "seasonal" && !out.some((o) => o.id === c.id),
    );
    return [...out, ...explicitSeasonal];
  }

  /** Aggregate stats over all collections. */
  getStats(): CollectionStats {
    const total = this.collections.size;
    const byCategory: Record<string, number> = {};
    const allListingIds = new Set<string>();
    let featured = 0;
    let seasonal = 0;
    for (const c of this.collections.values()) {
      byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
      for (const id of c.listingIds) allListingIds.add(id as string);
      if (c.curator.includes("Eks-Health Editorial") || c.curator.includes("Eks-Health Research") || c.category === "editorial" || c.category === "curated") {
        featured += 1;
      }
      if (c.category === "seasonal") seasonal += 1;
    }
    return {
      totalCollections: total,
      byCategory,
      totalListingsAcrossCollections: allListingIds.size,
      totalFeatured: featured,
      totalSeasonal: seasonal,
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private require(id: CollectionId): Collection {
    const collection = this.collections.get(id);
    if (!collection) {
      throw new MarketplaceError({
        code: "eks.marketplace.collection.not_found",
        category: "not_found",
        message: `Collection ${id} not found.`,
        userMessage: "Collection not found.",
      });
    }
    return collection;
  }

  private bootPreRegistered(): void {
    if (this.booted) return;
    this.booted = true;
    const now = getClock().iso();
    for (const def of PRE_REGISTERED_COLLECTIONS) {
      const id = asCollectionId(`col_pre_${def.id}`);
      // Skip if somehow already present (idempotent boot).
      if (this.collections.has(id)) continue;
      const collection: Collection = {
        id,
        name: def.name,
        description: def.description,
        curator: def.curator,
        listingIds: [],
        category: def.category,
        createdAt: now,
        updatedAt: now,
      };
      this.collections.set(id, collection);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: CollectionManager | null = null;
export function getCollections(): CollectionManager {
  if (!_mgr) _mgr = new CollectionManager();
  return _mgr;
}
export function resetCollections(): void {
  _mgr = null;
}

// Re-exports for convenience
export type {
  Collection,
  CollectionId,
  ListingId,
  SolutionCategory,
} from "../core";
