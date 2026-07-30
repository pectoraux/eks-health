/**
 * Eks-Health Competition Platform — Divisions & Leagues
 *
 * Programs organize participants into divisions (Bronze, Silver, Gold,
 * Platinum, Diamond, Champion, or custom). Promotion and relegation rules
 * are configurable.
 */

import "server-only";
import {
  type DivisionId,
  type CompetitionId,
  type TierName,
  type PromotionRule,
  type DivisionDefinition,
  CompetitionError,
  asDivisionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { COMPETITION_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Division manager
// ---------------------------------------------------------------------------

export class DivisionManager {
  private readonly divisions = new Map<DivisionId, DivisionDefinition>();
  private readonly byCompetition = new Map<CompetitionId, DivisionId[]>();

  define(input: Omit<DivisionDefinition, "id">): DivisionDefinition {
    const div: DivisionDefinition = { ...input, id: asDivisionId(generateId("div_")) };
    this.divisions.set(div.id, div);
    return div;
  }

  defineTierSet(competitionId: CompetitionId, customTiers?: { name: string; tier: TierName; minScore?: number; maxScore?: number }[]): DivisionDefinition[] {
    const tiers = customTiers ?? [
      { name: "Bronze", tier: "bronze" as const, minScore: 0, maxScore: 20 },
      { name: "Silver", tier: "silver" as const, minScore: 20, maxScore: 40 },
      { name: "Gold", tier: "gold" as const, minScore: 40, maxScore: 60 },
      { name: "Platinum", tier: "platinum" as const, minScore: 60, maxScore: 80 },
      { name: "Diamond", tier: "diamond" as const, minScore: 80, maxScore: 95 },
      { name: "Champion", tier: "champion" as const, minScore: 95, maxScore: 100 },
    ];
    const defined = tiers.map((t) => {
      const div = this.define({ name: t.name, tier: t.tier, minScore: t.minScore, maxScore: t.maxScore });
      const list = this.byCompetition.get(competitionId) ?? [];
      this.byCompetition.set(competitionId, [...list, div.id]);
      return div;
    });
    return defined;
  }

  get(id: DivisionId): DivisionDefinition | undefined {
    return this.divisions.get(id);
  }

  listByCompetition(competitionId: CompetitionId): DivisionDefinition[] {
    return (this.byCompetition.get(competitionId) ?? []).map((id) => this.divisions.get(id)!).filter(Boolean);
  }

  list(): DivisionDefinition[] {
    return [...this.divisions.values()];
  }

  /** Determine which division a score falls into. */
  getDivisionForScore(competitionId: CompetitionId, score: number): DivisionDefinition | undefined {
    const divs = this.listByCompetition(competitionId);
    return divs.find((d) => (d.minScore === undefined || score >= d.minScore) && (d.maxScore === undefined || score < d.maxScore));
  }

  /** Execute promotion/relegation based on a promotion rule and current standings. */
  executePromotionRelegation(input: {
    competitionId: CompetitionId;
    rule: PromotionRule;
    standings: { participantId: string; divisionId: DivisionId; rank: number; score: number }[];
  }): { promoted: { participantId: string; from: DivisionId; to: DivisionId }[]; relegated: { participantId: string; from: DivisionId; to: DivisionId }[] } {
    const divs = this.listByCompetition(input.competitionId).sort((a, b) => (b.minScore ?? 0) - (a.minScore ?? 0)); // highest tier first
    const promoted: { participantId: string; from: DivisionId; to: DivisionId }[] = [];
    const relegated: { participantId: string; from: DivisionId; to: DivisionId }[] = [];

    // Group standings by division
    const byDiv = new Map<DivisionId, typeof input.standings>();
    for (const s of input.standings) {
      const list = byDiv.get(s.divisionId) ?? [];
      byDiv.set(s.divisionId, [...list, s]);
    }

    for (let i = 0; i < divs.length; i++) {
      const div = divs[i];
      const upperDiv = divs[i - 1]; // higher tier
      const lowerDiv = divs[i + 1]; // lower tier
      const standings = (byDiv.get(div.id) ?? []).sort((a, b) => a.rank - b.rank);

      if (standings.length < input.rule.minParticipantsForPromotion) continue;

      // Promote top N
      if (upperDiv) {
        for (let j = 0; j < Math.min(input.rule.promoteTopN, standings.length); j++) {
          promoted.push({ participantId: standings[j].participantId, from: div.id, to: upperDiv.id });
        }
      }
      // Relegate bottom N
      if (lowerDiv) {
        for (let j = standings.length - 1; j >= Math.max(0, standings.length - input.rule.relegateBottomN); j--) {
          relegated.push({ participantId: standings[j].participantId, from: div.id, to: lowerDiv.id });
        }
      }
    }

    for (const p of promoted) {
      void getEventBus().publish(buildEvent(COMPETITION_EVENTS.divisionPromoted, { competitionId: input.competitionId, participantId: p.participantId, from: p.from, to: p.to }, {}, "domain"));
    }
    for (const r of relegated) {
      void getEventBus().publish(buildEvent(COMPETITION_EVENTS.divisionRelegated, { competitionId: input.competitionId, participantId: r.participantId, from: r.from, to: r.to }, {}, "domain"));
    }
    return { promoted, relegated };
  }

  getStats(): { total: number; byTier: Record<string, number> } {
    const list = [...this.divisions.values()];
    const byTier: Record<string, number> = {};
    for (const d of list) {
      byTier[d.tier] = (byTier[d.tier] ?? 0) + 1;
    }
    return { total: list.length, byTier };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: DivisionManager | null = null;
export function getDivisions(): DivisionManager {
  if (!_mgr) _mgr = new DivisionManager();
  return _mgr;
}
