/**
 * Eks-Health Health Marketplace — AI Solution Matching
 *
 * Instead of "most downloaded", rank Programs using a suitability score.
 * AI explains why each Program is recommended.
 */

import "server-only";
import {
  type ListingId,
  type AccountId,
  type SuitabilityScore,
  type SuitabilityFactor,
  MarketplaceError,
  asSuitabilityScoreId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MARKETPLACE_EVENTS } from "../core";

interface ListingContext {
  listingId: ListingId;
  name: string;
  category: string;
  healthGoals: string[];
  supportedCountries: string[];
  supportedLanguages: string[];
  pricing: { type: string; price?: number };
  estimatedEffortHoursPerWeek: number;
  bodySystems: string[];
  evidenceQuality?: number;
}

export class SolutionMatcher {
  private readonly scores = new Map<string, SuitabilityScore>();

  score(listing: ListingContext, participantId: AccountId, participantContext?: {
    ageRange?: string; gender?: string; country?: string; language?: string;
    healthGoals?: string[]; maxBudget?: number; behaviorHistory?: { missionCompletionRate?: number };
  }): SuitabilityScore {
    const factors: SuitabilityFactor[] = [];
    let totalScore = 0;
    let totalWeight = 0;

    // Goal alignment (weight 25)
    const goalMatch = participantContext?.healthGoals?.filter((g) =>
      listing.healthGoals.some((hg) => hg.toLowerCase().includes(g.toLowerCase())),
    ) ?? [];
    const goalScore = participantContext?.healthGoals?.length ? (goalMatch.length / participantContext.healthGoals.length) * 100 : 50;
    factors.push({ name: "Goal Alignment", value: `${goalMatch.length}/${participantContext?.healthGoals?.length ?? 0} goals matched`, weight: 25, positive: goalScore >= 50 });
    totalScore += goalScore * 25; totalWeight += 25;

    // Demographic fit (weight 15)
    let demoFit = 100;
    if (participantContext?.country && !listing.supportedCountries.includes(participantContext.country) && !listing.supportedCountries.includes("*")) demoFit = 0;
    factors.push({ name: "Demographic Fit", value: demoFit === 100 ? "Supported in your region" : "Not available in your region", weight: 15, positive: demoFit >= 50 });
    totalScore += demoFit * 15; totalWeight += 15;

    // Language match (weight 10)
    const langMatch = participantContext?.language ? (listing.supportedLanguages.includes(participantContext.language) ? 100 : 0) : 50;
    factors.push({ name: "Language", value: langMatch === 100 ? `Available in ${participantContext?.language}` : "Language may differ", weight: 10, positive: langMatch >= 50 });
    totalScore += langMatch * 10; totalWeight += 10;

    // Budget fit (weight 15)
    let budgetFit = 100;
    if (listing.pricing.price !== undefined && participantContext?.maxBudget !== undefined) {
      budgetFit = listing.pricing.price <= participantContext.maxBudget ? 100 : 0;
    }
    factors.push({ name: "Budget", value: listing.pricing.type === "free" ? "Free" : listing.pricing.price !== undefined ? `${listing.pricing.price}` : "Custom pricing", weight: 15, positive: budgetFit >= 50 });
    totalScore += budgetFit * 15; totalWeight += 15;

    // Evidence quality (weight 15)
    const eqScore = listing.evidenceQuality ?? 50;
    factors.push({ name: "Evidence Quality", value: `${eqScore}/100 quality score`, weight: 15, positive: eqScore >= 50 });
    totalScore += eqScore * 15; totalWeight += 15;

    // Effort feasibility (weight 10)
    const completionRate = participantContext?.behaviorHistory?.missionCompletionRate ?? 0.5;
    const effortScore = listing.estimatedEffortHoursPerWeek <= 5 ? 100 : listing.estimatedEffortHoursPerWeek <= 10 ? 70 : 40;
    const feasibilityScore = (effortScore * 0.5) + (completionRate * 100 * 0.5);
    factors.push({ name: "Effort Feasibility", value: `${listing.estimatedEffortHoursPerWeek}h/week estimated`, weight: 10, positive: feasibilityScore >= 50 });
    totalScore += feasibilityScore * 10; totalWeight += 10;

    // Category match (weight 10)
    factors.push({ name: "Solution Type", value: listing.category, weight: 10, positive: true });
    totalScore += 70 * 10; totalWeight += 10;

    const finalScore = Math.round(totalWeight > 0 ? totalScore / totalWeight : 0);

    const explanation = this.generateExplanation(factors, finalScore, listing);
    const result: SuitabilityScore = {
      id: asSuitabilityScoreId(generateId("suit_")),
      listingId: listing.listingId,
      participantId,
      score: finalScore,
      factors,
      explanation,
      estimatedOutcome: finalScore >= 70 ? "Strong likelihood of improvement" : finalScore >= 50 ? "Moderate likelihood of improvement" : "Uncertain outcome",
      estimatedTimeToResults: listing.estimatedEffortHoursPerWeek <= 5 ? "4-8 weeks" : "2-6 weeks",
      estimatedCost: listing.pricing.type === "free" ? "Free" : listing.pricing.price !== undefined ? `${listing.pricing.price}` : "Custom",
      computedAt: getClock().iso(),
    };
    this.scores.set(result.id, result);
    void getEventBus().publish(buildEvent(MARKETPLACE_EVENTS.recommendationGenerated, { listingId: listing.listingId, participantId, score: finalScore }, {}, "domain"));
    return result;
  }

  rank(listings: ListingContext[], participantId: AccountId, participantContext?: Record<string, unknown>): SuitabilityScore[] {
    return listings
      .map((l) => this.score(l, participantId, participantContext as never))
      .sort((a, b) => b.score - a.score);
  }

  recommend(listings: ListingContext[], participantId: AccountId, limit = 10, participantContext?: Record<string, unknown>): SuitabilityScore[] {
    return this.rank(listings, participantId, participantContext).slice(0, limit);
  }

  explain(scoreId: string): SuitabilityScore | undefined {
    return this.scores.get(scoreId);
  }

  getStats(): { totalScores: number; avgScore: number } {
    const list = [...this.scores.values()];
    return { totalScores: list.length, avgScore: list.length > 0 ? list.reduce((a, s) => a + s.score, 0) / list.length : 0 };
  }

  private generateExplanation(factors: SuitabilityFactor[], score: number, listing: ListingContext): string {
    const positives = factors.filter((f) => f.positive).map((f) => f.name);
    const negatives = factors.filter((f) => !f.positive).map((f) => f.name);
    let explanation = `${listing.name} has a ${score}% suitability score for you. `;
    if (positives.length > 0) explanation += `Strengths: ${positives.join(", ")}. `;
    if (negatives.length > 0) explanation += `Considerations: ${negatives.join(", ")}.`;
    return explanation;
  }
}

let _mgr: SolutionMatcher | null = null;
export function getMatching(): SolutionMatcher {
  if (!_mgr) _mgr = new SolutionMatcher();
  return _mgr;
}
