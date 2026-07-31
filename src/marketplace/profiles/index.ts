/**
 * Eks-Health Health Marketplace — Program Profiles & Listing Registry
 *
 * Rich Program profiles and listing lifecycle management.
 */

import "server-only";
import {
  type ListingId,
  type MarketplaceListing,
  type HealthSolution,
  type PricingModel,
  type ListingStatus,
  type ProgramId,
  type OrgId,
  MarketplaceError,
  asListingId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MARKETPLACE_EVENTS } from "../core";
import { getDiscovery } from "../discovery";
import { getEvidence } from "../evidence";
import { getOutcomes } from "../outcomes";
import { getReviews } from "../reviews";
import { db } from "@/lib/db";

export interface PublishListingInput {
  programId: ProgramId;
  name: string;
  tagline: string;
  description: string;
  category: HealthSolution["category"];
  bodySystems: HealthSolution["bodySystems"];
  healthGoals: string[];
  symptoms: string[];
  lifestyleGoals: string[];
  developerId: string;
  developerName: string;
  organizationId?: OrgId;
  organizationName?: string;
  supportedCountries: string[];
  supportedLanguages: string[];
  measurementRequirements: string[];
  technicianRequirements: string[];
  estimatedEffortHoursPerWeek: number;
  competitionDetails?: { competitionId: string; rewardStructure: string };
  pricing: PricingModel;
  supportedDevices: string[];
  privacyPractices: string[];
  version: string;
  tags?: string[];
}

export class ListingRegistry {
  private readonly listings = new Map<ListingId, MarketplaceListing>();
  private readonly byProgram = new Map<ProgramId, ListingId>();
  private readonly bySlug = new Map<string, ListingId>();

  publish(input: PublishListingInput): MarketplaceListing {
    if (this.byProgram.has(input.programId)) {
      throw new MarketplaceError({ code: "eks.marketplace.listing.already_exists", category: "state_conflict", message: "Listing already exists for this program.", userMessage: "This program is already listed." });
    }
    const now = getClock().iso();
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const listing: MarketplaceListing = {
      id: asListingId(generateId("lst_")),
      programId: input.programId,
      solution: {
        id: generateId("sol_") as never,
        listingId: asListingId(generateId("lst_")),
        programId: input.programId,
        name: input.name,
        tagline: input.tagline,
        description: input.description,
        category: input.category,
        bodySystems: input.bodySystems,
        healthGoals: input.healthGoals,
        symptoms: input.symptoms,
        lifestyleGoals: input.lifestyleGoals,
      },
      status: "published",
      developerId: input.developerId,
      developerName: input.developerName,
      organizationId: input.organizationId,
      organizationName: input.organizationName,
      supportedCountries: input.supportedCountries,
      supportedLanguages: input.supportedLanguages,
      measurementRequirements: input.measurementRequirements,
      technicianRequirements: input.technicianRequirements,
      estimatedEffortHoursPerWeek: input.estimatedEffortHoursPerWeek,
      competitionDetails: input.competitionDetails,
      pricing: input.pricing,
      supportedDevices: input.supportedDevices,
      privacyPractices: input.privacyPractices,
      screenshots: [],
      videos: [],
      tutorials: [],
      faq: [],
      version: input.version,
      changelog: [],
      publishedAt: now,
      installCount: 0,
      activeInstallCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    // Fix: solution.listingId should match
    (listing.solution as { listingId: ListingId }).listingId = listing.id;

    this.listings.set(listing.id, listing);
    void this._persist(listing.id);
    this.byProgram.set(input.programId, listing.id);
    this.bySlug.set(slug, listing.id);
    getDiscovery().index_(listing);
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.listingPublished, { listingId: listing.id, programId: input.programId }, {}, "domain"));
    return listing;
  }

  get(id: ListingId): MarketplaceListing | undefined {
    return this.listings.get(id);
  }

  getByProgramId(programId: ProgramId): MarketplaceListing | undefined {
    const id = this.byProgram.get(programId);
    return id ? this.listings.get(id) : undefined;
  }

  getBySlug(slug: string): MarketplaceListing | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.listings.get(id) : undefined;
  }

  list(filter?: { status?: ListingStatus; category?: string; country?: string; developerId?: string }): MarketplaceListing[] {
    let l = [...this.listings.values()];
    if (filter?.status) l = l.filter((x) => x.status === filter.status);
    if (filter?.category) l = l.filter((x) => x.solution.category === filter.category);
    if (filter?.country) l = l.filter((x) => x.supportedCountries.includes(filter.country!) || x.supportedCountries.includes("*"));
    if (filter?.developerId) l = l.filter((x) => x.developerId === filter.developerId);
    return l;
  }

  update(id: ListingId, updates: Partial<MarketplaceListing>): MarketplaceListing {
    const existing = this.listings.get(id);
    if (!existing) throw new MarketplaceError({ code: "eks.marketplace.listing.not_found", category: "not_found", message: "Listing not found." });
    const updated = { ...existing, ...updates, updatedAt: getClock().iso() };
    this.listings.set(id, updated);
    void this._persist(id);
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.programUpdated, { listingId: id }, {}, "domain"));
    return updated;
  }

  retire(id: ListingId, _reason: string): MarketplaceListing {
    const updated = this.update(id, { status: "retired", retiredAt: getClock().iso() } as never);
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.listingRetired, { listingId: id }, {}, "domain"));
    return updated;
  }

  suspend(id: ListingId, _reason: string): MarketplaceListing {
    const updated = this.update(id, { status: "suspended" } as never);
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.listingSuspended, { listingId: id }, {}, "domain"));
    return updated;
  }

  addScreenshot(id: ListingId, url: string): void {
    const l = this.listings.get(id);
    if (!l) return;
    this.listings.set(id, { ...l, screenshots: [...l.screenshots, url], updatedAt: getClock().iso() });
    void this._persist(id);
  }

  addVideo(id: ListingId, url: string): void {
    const l = this.listings.get(id);
    if (!l) return;
    this.listings.set(id, { ...l, videos: [...l.videos, url], updatedAt: getClock().iso() });
    void this._persist(id);
  }

  addFAQ(id: ListingId, question: string, answer: string): void {
    const l = this.listings.get(id);
    if (!l) return;
    this.listings.set(id, { ...l, faq: [...l.faq, { question, answer }], updatedAt: getClock().iso() });
    void this._persist(id);
  }

  addChangelog(id: ListingId, version: string, notes: string): void {
    const l = this.listings.get(id);
    if (!l) return;
    this.listings.set(id, { ...l, changelog: [{ version, notes, date: getClock().iso() }, ...l.changelog], updatedAt: getClock().iso() });
    void this._persist(id);
  }

  incrementInstall(id: ListingId): void {
    const l = this.listings.get(id);
    if (!l) return;
    this.listings.set(id, { ...l, installCount: l.installCount + 1, activeInstallCount: l.activeInstallCount + 1, updatedAt: getClock().iso() });
    void this._persist(id);
  }

  decrementInstall(id: ListingId): void {
    const l = this.listings.get(id);
    if (!l) return;
    this.listings.set(id, { ...l, activeInstallCount: Math.max(0, l.activeInstallCount - 1), updatedAt: getClock().iso() });
    void this._persist(id);
  }

  getFullProfile(id: ListingId): { listing: MarketplaceListing; evidence?: unknown; outcomes?: unknown; reviews?: unknown } | undefined {
    const listing = this.listings.get(id);
    if (!listing) return undefined;
    let evidence: unknown;
    let outcomes: unknown;
    let reviews: unknown;
    try { evidence = getEvidence().getPage(id); } catch { /* */ }
    try { outcomes = getOutcomes().get(id); } catch { /* */ }
    try { reviews = getReviews().getSummary(id); } catch { /* */ }
    return { listing, evidence, outcomes, reviews };
  }

  getStats(): { total: number; published: number; retired: number; suspended: number; totalInstalls: number; activeInstalls: number } {
    const list = [...this.listings.values()];
    return {
      total: list.length,
      published: list.filter((l) => l.status === "published").length,
      retired: list.filter((l) => l.status === "retired").length,
      suspended: list.filter((l) => l.status === "suspended").length,
      totalInstalls: list.reduce((a, l) => a + l.installCount, 0),
      activeInstalls: list.reduce((a, l) => a + l.activeInstallCount, 0),
    };
  }

  /** Per-ID promise chain to serialize concurrent write-behind calls. */
  private readonly _persistChain = new Map<string, Promise<void>>();

  /** Write-behind: upsert listing as JSON snapshot to EksListing. */
  private _persist(id: ListingId): Promise<void> {
    const prev = this._persistChain.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this._doPersist(id));
    this._persistChain.set(id, next);
    void next.then(() => {
      if (this._persistChain.get(id) === next) this._persistChain.delete(id);
    });
    return next;
  }

  private async _doPersist(id: ListingId): Promise<void> {
    const l = this.listings.get(id);
    if (!l) return;
    const slug = l.solution.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    try {
      await db.eksListing.upsert({
        where: { id },
        create: {
          id: l.id,
          slug,
          programId: l.programId,
          developerId: l.developerId ?? null,
          dataJson: JSON.stringify(l),
          status: l.status,
          createdAt: new Date(l.createdAt),
        },
        update: {
          dataJson: JSON.stringify(l),
          status: l.status,
          developerId: l.developerId ?? null,
        },
      });
    } catch (err) {
      console.error("[marketplace] DB write-behind failed for", l.id, err);
    }
  }

  /** Hydrate listings from DB. Rebuilds byProgram/bySlug indexes. */
  async hydrateFromDb(): Promise<number> {
    try {
      const rows = await db.eksListing.findMany();
      let loaded = 0;
      for (const row of rows) {
        if (this.listings.has(row.id as ListingId)) continue;
        try {
          const l = JSON.parse(row.dataJson) as MarketplaceListing;
          this.listings.set(l.id, l);
          this.byProgram.set(l.programId, l.id);
          const slug = l.solution.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          this.bySlug.set(slug, l.id);
          try { getDiscovery().index_(l); } catch { /* discovery may not be ready */ }
          loaded++;
        } catch {
          // skip malformed
        }
      }
      return loaded;
    } catch (err) {
      console.error("[marketplace] DB hydration failed:", err);
      return 0;
    }
  }
}

let _mgr: ListingRegistry | null = null;
export function getProfiles(): ListingRegistry {
  if (!_mgr) _mgr = new ListingRegistry();
  return _mgr;
}
