/**
 * Eks-Health Health Marketplace — Evidence Platform
 *
 * Each Program has a dedicated evidence page. Distinguishes peer-reviewed
 * from anecdotal without excluding either.
 */

import "server-only";
import {
  type ListingId,
  type EvidencePageId,
  type EvidencePage,
  type EvidenceEntry,
  type EvidenceType,
  type EvidenceConfidenceLevel,
  MarketplaceError,
  asEvidencePageId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MARKETPLACE_EVENTS } from "../core";

const CONFIDENCE_RANK: Record<EvidenceConfidenceLevel, number> = {
  anecdotal: 1, preliminary: 2, moderate: 3, strong: 4, peer_reviewed: 5,
};

export class EvidenceManager {
  private readonly pages = new Map<ListingId, EvidencePage>();

  createPage(listingId: ListingId, input: { methodology: string; knownLimitations: string }): EvidencePage {
    if (this.pages.has(listingId)) return this.pages.get(listingId)!;
    const page: EvidencePage = {
      id: asEvidencePageId(generateId("evp_")),
      listingId,
      entries: [],
      methodology: input.methodology,
      knownLimitations: input.knownLimitations,
      overallConfidence: "anecdotal",
      outcomeHistory: [],
      updatedAt: getClock().iso(),
    };
    this.pages.set(listingId, page);
    return page;
  }

  getPage(listingId: ListingId): EvidencePage | undefined {
    return this.pages.get(listingId);
  }

  addEntry(listingId: ListingId, entry: Omit<EvidenceEntry, "id">): EvidencePage {
    const page = this.pages.get(listingId);
    if (!page) throw new MarketplaceError({ code: "eks.marketplace.evidence.page_not_found", category: "not_found", message: "Evidence page not found." });
    const fullEntry: EvidenceEntry = { ...entry, id: generateId("eve_") };
    const updated: EvidencePage = {
      ...page,
      entries: [...page.entries, fullEntry],
      overallConfidence: this.computeConfidence([...page.entries, fullEntry]),
      updatedAt: getClock().iso(),
    };
    this.pages.set(listingId, updated);
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.evidenceUpdated, { listingId }, {}, "domain"));
    return updated;
  }

  removeEntry(listingId: ListingId, entryId: string): void {
    const page = this.pages.get(listingId);
    if (!page) return;
    this.pages.set(listingId, { ...page, entries: page.entries.filter((e) => e.id !== entryId), updatedAt: getClock().iso() });
  }

  updateMethodology(listingId: ListingId, methodology: string): void {
    const page = this.pages.get(listingId);
    if (!page) return;
    this.pages.set(listingId, { ...page, methodology, updatedAt: getClock().iso() });
  }

  updateLimitations(listingId: ListingId, limitations: string): void {
    const page = this.pages.get(listingId);
    if (!page) return;
    this.pages.set(listingId, { ...page, knownLimitations: limitations, updatedAt: getClock().iso() });
  }

  addOutcomeHistory(listingId: ListingId, period: string, improvement: number, sampleSize: number): void {
    const page = this.pages.get(listingId);
    if (!page) return;
    this.pages.set(listingId, { ...page, outcomeHistory: [...page.outcomeHistory, { period, improvement, sampleSize }], updatedAt: getClock().iso() });
  }

  computeConfidence(entries: EvidenceEntry[]): EvidenceConfidenceLevel {
    let best: EvidenceConfidenceLevel = "anecdotal";
    for (const e of entries) {
      if (CONFIDENCE_RANK[e.confidence] > CONFIDENCE_RANK[best]) best = e.confidence;
    }
    return best;
  }

  getEvidenceQualityScore(listingId: ListingId): number {
    const page = this.pages.get(listingId);
    if (!page) return 0;
    let score = 0;
    for (const e of page.entries) {
      switch (e.confidence) {
        case "peer_reviewed": score = Math.min(score + 15, 40); break;
        case "strong": score = Math.min(score + 10, 25); break;
        case "moderate": score = Math.min(score + 7, 15); break;
        case "preliminary": score = Math.min(score + 5, 10); break;
        case "anecdotal": score = Math.min(score + 3, 10); break;
      }
    }
    return score;
  }

  listByConfidence(level: EvidenceConfidenceLevel): EvidencePage[] {
    return [...this.pages.values()].filter((p) => p.overallConfidence === level);
  }

  getStats(): { totalPages: number; byConfidence: Record<string, number>; avgQuality: number } {
    const list = [...this.pages.values()];
    const byConfidence: Record<string, number> = {};
    let totalQuality = 0;
    for (const p of list) {
      byConfidence[p.overallConfidence] = (byConfidence[p.overallConfidence] ?? 0) + 1;
      totalQuality += this.getEvidenceQualityScore(p.listingId);
    }
    return { totalPages: list.length, byConfidence, avgQuality: list.length > 0 ? totalQuality / list.length : 0 };
  }
}

let _mgr: EvidenceManager | null = null;
export function getEvidence(): EvidenceManager {
  if (!_mgr) _mgr = new EvidenceManager();
  return _mgr;
}
