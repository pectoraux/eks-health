/**
 * Eks-Health Health Marketplace — Solution Discovery Engine
 *
 * Users search by health goals, body systems, symptoms, lifestyle goals,
 * age, gender, country, language, budget, evidence level, competition rewards.
 * Everything filterable. Tokenized text search + structured filtering.
 */

import "server-only";
import {
  type ListingId,
  type MarketplaceListing,
  type DiscoveryQuery,
  type SolutionCategory,
  type BodySystem,
  MarketplaceError,
  asListingId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MARKETPLACE_EVENTS } from "../core";

interface IndexedListing {
  listing: MarketplaceListing;
  tokens: Map<string, number>; // token -> weight
}

export class DiscoveryEngine {
  private readonly index = new Map<ListingId, IndexedListing>();
  private readonly allTokens = new Map<string, Set<ListingId>>();

  index_(listing: MarketplaceListing): void {
    const tokens = this.tokenize(listing);
    const entry: IndexedListing = { listing, tokens };
    this.index.set(listing.id, entry);
    for (const tok of tokens.keys()) {
      const set = this.allTokens.get(tok) ?? new Set();
      set.add(listing.id);
      this.allTokens.set(tok, set);
    }
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.solutionSearched, { listingId: listing.id, action: "indexed" }, {}, "domain"));
  }

  remove(listingId: ListingId): void {
    const entry = this.index.get(listingId);
    if (!entry) return;
    for (const tok of entry.tokens.keys()) {
      this.allTokens.get(tok)?.delete(listingId);
    }
    this.index.delete(listingId);
  }

  search(query: DiscoveryQuery): { listingId: ListingId; score: number; listing: MarketplaceListing }[] {
    const results: { listingId: ListingId; score: number; listing: MarketplaceListing }[] = [];
    for (const [id, entry] of this.index) {
      const l = entry.listing;
      if (l.status !== "published") continue;

      // Structured filters
      if (query.category && l.solution.category !== query.category) continue;
      if (query.country && !l.supportedCountries.includes(query.country) && !l.supportedCountries.includes("*")) continue;
      if (query.language && !l.supportedLanguages.includes(query.language)) continue;
      if (query.bodySystems && query.bodySystems.length > 0) {
        if (!query.bodySystems.some((bs) => l.solution.bodySystems.includes(bs))) continue;
      }
      if (query.healthGoals && query.healthGoals.length > 0) {
        if (!query.healthGoals.some((g) => l.solution.healthGoals.some((hg) => hg.toLowerCase().includes(g.toLowerCase())))) continue;
      }
      if (query.symptoms && query.symptoms.length > 0) {
        if (!query.symptoms.some((s) => l.solution.symptoms.some((sy) => sy.toLowerCase().includes(s.toLowerCase())))) continue;
      }
      if (query.lifestyleGoals && query.lifestyleGoals.length > 0) {
        if (!query.lifestyleGoals.some((g) => l.solution.lifestyleGoals.some((lg) => lg.toLowerCase().includes(g.toLowerCase())))) continue;
      }
      if (query.maxBudget !== undefined && l.pricing.price !== undefined && l.pricing.price > query.maxBudget) continue;
      if (query.developerId && l.developerId !== query.developerId) continue;
      if (query.organizationId && l.organizationId !== query.organizationId) continue;
      if (query.competitionRewardsOnly && !l.competitionDetails) continue;

      // Text search score
      let score = 0;
      if (query.text) {
        const queryTokens = query.text.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
        for (const qt of queryTokens) {
          for (const [tok, weight] of entry.tokens) {
            if (tok.includes(qt)) score += weight;
          }
        }
        if (score === 0 && queryTokens.length > 0) continue; // must match at least one token
      }

      // Boost for filter matches
      if (query.category) score += 10;
      if (query.country) score += 5;
      if (query.language) score += 3;
      if (query.healthGoals) score += query.healthGoals.length * 8;
      if (query.bodySystems) score += query.bodySystems.length * 6;
      if (query.symptoms) score += query.symptoms.length * 5;

      results.push({ listingId: id, score, listing: l });
    }

    // Sort
    const sortField = query.sortBy ?? "popularity";
    results.sort((a, b) => {
      switch (sortField) {
        case "popularity": return b.listing.installCount - a.listing.installCount;
        case "recent": return b.listing.publishedAt?.localeCompare(a.listing.publishedAt ?? "") ?? 0;
        case "price_low": return (a.listing.pricing.price ?? 0) - (b.listing.pricing.price ?? 0);
        case "price_high": return (b.listing.pricing.price ?? 0) - (a.listing.pricing.price ?? 0);
        default: return b.score - a.score;
      }
    });

    return results;
  }

  searchByGoal(goal: string): { listingId: ListingId; score: number; listing: MarketplaceListing }[] {
    return this.search({ text: goal, healthGoals: [goal], sortBy: "outcomes" });
  }

  getSuggestions(partial: string): string[] {
    const lower = partial.toLowerCase();
    const matches: string[] = [];
    for (const tok of this.allTokens.keys()) {
      if (tok.startsWith(lower) && tok.length > 2) matches.push(tok);
    }
    return matches.slice(0, 10);
  }

  getStats(): { totalListings: number; byCategory: Record<string, number>; byBodySystem: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    const byBodySystem: Record<string, number> = {};
    for (const entry of this.index.values()) {
      byCategory[entry.listing.solution.category] = (byCategory[entry.listing.solution.category] ?? 0) + 1;
      for (const bs of entry.listing.solution.bodySystems) {
        byBodySystem[bs] = (byBodySystem[bs] ?? 0) + 1;
      }
    }
    return { totalListings: this.index.size, byCategory, byBodySystem };
  }

  private tokenize(l: MarketplaceListing): Map<string, number> {
    const tokens = new Map<string, number>();
    const add = (text: string, weight: number) => {
      for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1)) {
        tokens.set(tok, (tokens.get(tok) ?? 0) + weight);
      }
    };
    add(l.solution.name, 10);
    add(l.solution.tagline, 6);
    add(l.solution.description, 3);
    l.solution.healthGoals.forEach((g) => add(g, 8));
    l.solution.symptoms.forEach((s) => add(s, 5));
    l.solution.lifestyleGoals.forEach((g) => add(g, 5));
    add(l.solution.category, 4);
    l.solution.bodySystems.forEach((bs) => add(bs, 4));
    add(l.developerName, 2);
    l.faq.forEach((f) => { add(f.question, 2); });
    return tokens;
  }
}

let _engine: DiscoveryEngine | null = null;
export function getDiscovery(): DiscoveryEngine {
  if (!_engine) _engine = new DiscoveryEngine();
  return _engine;
}
