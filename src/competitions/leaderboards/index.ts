/**
 * Eks-Health Competition Platform — Leaderboards
 *
 * Programs define leaderboard strategies (global, country, state, city,
 * district, org, company, school, gender, age, BMI category, risk profile,
 * occupation, custom). A single competition may generate thousands of
 * leaderboards automatically via dynamic segmentation.
 *
 * Capabilities:
 *  - Create / get / list / list-by-scope leaderboard definitions.
 *  - Insert or update an entry; recompute ranks for ALL entries (real
 *    sort-descending + sequential-rank assignment with previous-rank +
 *    trend tracking: up / down / same / new).
 *  - Paginated entry retrieval (limit / offset).
 *  - getTopN (the podium), getRank (participant + neighbors).
 *  - generateSegmented — auto-generate one leaderboard per segmentation
 *    rule value (e.g. one per country, one per gender).
 *  - snapshot — immutable point-in-time copy for historical replay.
 *  - getHistory — historical snapshots (optionally filtered by participant).
 *
 * Emits:
 *  - eks.competition.leaderboard.updated — on every entry update.
 *  - eks.competition.podium.changed — when the top-N set/order changes.
 */

import "server-only";
import {
  type LeaderboardId,
  type LeaderboardEntry,
  type LeaderboardEntryId,
  type LeaderboardDefinition,
  type LeaderboardScope,
  type RankingMethod,
  type CompetitionId,
  type SeasonId,
  type DivisionId,
  type AccountId,
  CompetitionError,
  COMPETITION_EVENTS,
  asLeaderboardId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types (re-exported)
// ---------------------------------------------------------------------------

export type {
  LeaderboardId,
  LeaderboardEntry,
  LeaderboardEntryId,
  LeaderboardDefinition,
  LeaderboardScope,
  RankingMethod,
};

// ---------------------------------------------------------------------------
// New types
// ---------------------------------------------------------------------------

export interface SegmentationRule {
  readonly field: string; // e.g. "country", "gender", "age_range", "bmi_category"
  readonly value: string | number;
  readonly operator: "eq" | "ne" | "in" | "not_in" | "gt" | "lt" | "gte" | "lte" | "exists";
}

export interface LeaderboardSnapshot {
  readonly id: string;
  readonly leaderboardId: LeaderboardId;
  readonly takenAt: string;
  readonly entries: LeaderboardEntry[];
  readonly participantCount: number;
  readonly topScore?: number;
  readonly bottomScore?: number;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateLeaderboardInput {
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly name: string;
  readonly scope: LeaderboardScope;
  readonly scopeFilter?: Record<string, unknown>;
  readonly rankingMethod: RankingMethod;
  readonly divisionId?: DivisionId;
}

export interface ParticipantRank {
  readonly entry: LeaderboardEntry;
  readonly neighbors: LeaderboardEntry[]; // entries immediately above and below
}

// ---------------------------------------------------------------------------
// Branded-id helper (LeaderboardEntryId has no `as*` in core)
// ---------------------------------------------------------------------------

function asLeaderboardEntryId(s: string): LeaderboardEntryId {
  return s as LeaderboardEntryId;
}

// ---------------------------------------------------------------------------
// Leaderboard manager
// ---------------------------------------------------------------------------

export class LeaderboardManager {
  private readonly boards = new Map<LeaderboardId, LeaderboardDefinition>();
  private readonly byCompetition = new Map<CompetitionId, LeaderboardId[]>();
  private readonly entries = new Map<LeaderboardId, Map<AccountId, LeaderboardEntry>>();
  private readonly insertionOrder = new Map<LeaderboardId, AccountId[]>();
  private readonly snapshots = new Map<LeaderboardId, LeaderboardSnapshot[]>();
  private readonly podiumHistory = new Map<LeaderboardId, AccountId[][]>();

  // -------------------------------------------------------------------------
  // Create / get / list
  // -------------------------------------------------------------------------

  create(input: CreateLeaderboardInput): LeaderboardDefinition {
    const id = asLeaderboardId(generateId("lb_"));
    const now = getClock().iso();
    const def: LeaderboardDefinition = {
      id,
      competitionId: input.competitionId,
      seasonId: input.seasonId,
      name: input.name,
      scope: input.scope,
      scopeFilter: input.scopeFilter,
      rankingMethod: input.rankingMethod,
      divisionId: input.divisionId,
      updatedAt: now,
    };
    this.boards.set(id, def);
    const list = this.byCompetition.get(input.competitionId) ?? [];
    this.byCompetition.set(input.competitionId, [...list, id]);
    this.entries.set(id, new Map());
    this.insertionOrder.set(id, []);
    this.snapshots.set(id, []);
    this.podiumHistory.set(id, []);
    return def;
  }

  get(id: LeaderboardId): LeaderboardDefinition | undefined {
    return this.boards.get(id);
  }

  list(competitionId?: CompetitionId, seasonId?: SeasonId): LeaderboardDefinition[] {
    let ids: LeaderboardId[] = [];
    if (competitionId) {
      ids = this.byCompetition.get(competitionId) ?? [];
    } else {
      ids = [...this.boards.keys()];
    }
    let list = ids.map((id) => this.boards.get(id)!).filter(Boolean);
    if (seasonId) list = list.filter((b) => b.seasonId === seasonId);
    return list;
  }

  listByScope(competitionId: CompetitionId, scope: LeaderboardScope): LeaderboardDefinition[] {
    return this.list(competitionId).filter((b) => b.scope === scope);
  }

  // -------------------------------------------------------------------------
  // Update entry — the core ranking operation
  // -------------------------------------------------------------------------

  updateEntry(
    leaderboardId: LeaderboardId,
    participantId: AccountId,
    score: number,
    metadata?: Record<string, unknown>,
  ): LeaderboardEntry {
    const def = this.boards.get(leaderboardId);
    if (!def) {
      throw new CompetitionError({
        code: "eks.competition.leaderboard.not_found",
        category: "leaderboard_invalid",
        message: `Leaderboard ${leaderboardId} not found.`,
        userMessage: "Leaderboard not found.",
        metadata: { leaderboardId },
      });
    }
    const entriesMap = this.entries.get(leaderboardId)!;
    const insertionList = this.insertionOrder.get(leaderboardId)!;

    // Capture previous top-N (podium) BEFORE the update
    const previousPodium = this.computeTopNParticipantIds(leaderboardId, 3);

    const existing = entriesMap.get(participantId);
    const now = getClock().iso();

    // Insert/update the entry with the OLD rank preserved as `rank` so
    // recomputeRanks can compute trend correctly (it reads entry.rank
    // before reassigning). For brand-new entries we use 0 to signal "new".
    const placeholder: LeaderboardEntry = {
      id: existing?.id ?? asLeaderboardEntryId(generateId("lbe_")),
      leaderboardId,
      participantId,
      rank: existing?.rank ?? 0,
      previousRank: existing?.previousRank,
      score,
      trend: existing ? existing.trend : "new",
      changeAmount: existing ? score - existing.score : undefined,
      updatedAt: now,
      metadata: { ...(existing?.metadata ?? {}), ...(metadata ?? {}) },
    };
    entriesMap.set(participantId, placeholder);
    if (!insertionList.includes(participantId)) {
      insertionList.push(participantId);
    }

    // Recompute ranks for ALL entries
    const recomputed = this.recomputeRanks(leaderboardId);

    // Capture new podium; emit podium.changed if it differs
    const newPodium = this.computeTopNParticipantIds(leaderboardId, 3);
    const def2 = this.boards.get(leaderboardId)!;
    const updatedDef: LeaderboardDefinition = { ...def2, updatedAt: now };
    this.boards.set(leaderboardId, updatedDef);

    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.leaderboardUpdated,
        {
          leaderboardId,
          competitionId: def.competitionId,
          seasonId: def.seasonId,
          participantId,
          score,
          rank: recomputed.get(participantId) ?? 0,
          participantCount: entriesMap.size,
        },
        {},
        "domain",
      ),
    );

    if (!podiumEqual(previousPodium, newPodium)) {
      const podiumHistory = this.podiumHistory.get(leaderboardId) ?? [];
      podiumHistory.push(newPodium);
      this.podiumHistory.set(leaderboardId, podiumHistory);
      void getEventBus().publish(
        buildEvent(
          COMPETITION_EVENTS.podiumChanged,
          {
            leaderboardId,
            competitionId: def.competitionId,
            seasonId: def.seasonId,
            previousPodium,
            newPodium,
          },
          {},
          "domain",
        ),
      );
    }

    return entriesMap.get(participantId)!;
  }

  // -------------------------------------------------------------------------
  // Get entries (paginated)
  // -------------------------------------------------------------------------

  getEntries(leaderboardId: LeaderboardId, limit?: number, offset?: number): LeaderboardEntry[] {
    const entriesMap = this.entries.get(leaderboardId);
    if (!entriesMap) return [];
    const all = [...entriesMap.values()].sort((a, b) => a.rank - b.rank);
    const off = offset ?? 0;
    if (limit !== undefined) return all.slice(off, off + limit);
    return off > 0 ? all.slice(off) : all;
  }

  getTopN(leaderboardId: LeaderboardId, n: number): LeaderboardEntry[] {
    return this.getEntries(leaderboardId, n, 0);
  }

  getRank(leaderboardId: LeaderboardId, participantId: AccountId): ParticipantRank | undefined {
    const entriesMap = this.entries.get(leaderboardId);
    if (!entriesMap) return undefined;
    const entry = entriesMap.get(participantId);
    if (!entry) return undefined;
    const sorted = [...entriesMap.values()].sort((a, b) => a.rank - b.rank);
    const idx = sorted.findIndex((e) => e.participantId === participantId);
    const neighbors: LeaderboardEntry[] = [];
    if (idx > 0) neighbors.push(sorted[idx - 1]!);
    if (idx >= 0 && idx < sorted.length - 1) neighbors.push(sorted[idx + 1]!);
    return { entry, neighbors };
  }

  getParticipantCount(leaderboardId: LeaderboardId): number {
    return this.entries.get(leaderboardId)?.size ?? 0;
  }

  // -------------------------------------------------------------------------
  // Segmented generation — auto-generate multiple leaderboards from rules
  // -------------------------------------------------------------------------

  generateSegmented(
    competitionId: CompetitionId,
    seasonId: SeasonId,
    segmentationRules: SegmentationRule[],
  ): LeaderboardId[] {
    const created: LeaderboardId[] = [];
    for (const rule of segmentationRules) {
      // For "in" / "not_in" operators, value is an array of values; create
      // one leaderboard per value. For "eq", one leaderboard for that value.
      // For "exists", a single leaderboard with no filter value (the field
      // is captured in scopeFilter as { field: "*" }).
      if (rule.operator === "in" && Array.isArray(rule.value)) {
        for (const v of rule.value as readonly (string | number)[]) {
          const lb = this.create({
            competitionId,
            seasonId,
            name: `${rule.field}=${v}`,
            scope: scopeForField(rule.field),
            scopeFilter: { [rule.field]: v },
            rankingMethod: "highest_score",
          });
          created.push(lb.id);
        }
      } else if (rule.operator === "eq") {
        const lb = this.create({
          competitionId,
          seasonId,
          name: `${rule.field}=${rule.value}`,
          scope: scopeForField(rule.field),
          scopeFilter: { [rule.field]: rule.value },
          rankingMethod: "highest_score",
        });
        created.push(lb.id);
      } else if (rule.operator === "exists") {
        const lb = this.create({
          competitionId,
          seasonId,
          name: `${rule.field}=any`,
          scope: scopeForField(rule.field),
          scopeFilter: { [rule.field]: "*" },
          rankingMethod: "highest_score",
        });
        created.push(lb.id);
      } else {
        // gt/lt/gte/lte/ne/not_in — single leaderboard with the rule as filter
        const lb = this.create({
          competitionId,
          seasonId,
          name: `${rule.field}:${rule.operator}:${rule.value}`,
          scope: scopeForField(rule.field),
          scopeFilter: { [rule.field]: rule.value, operator: rule.operator },
          rankingMethod: "highest_score",
        });
        created.push(lb.id);
      }
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // Snapshots & history
  // -------------------------------------------------------------------------

  snapshot(leaderboardId: LeaderboardId, metadata?: Record<string, unknown>): LeaderboardSnapshot {
    const entriesMap = this.entries.get(leaderboardId);
    if (!entriesMap) {
      throw new CompetitionError({
        code: "eks.competition.leaderboard.not_found",
        category: "leaderboard_invalid",
        message: `Leaderboard ${leaderboardId} not found.`,
        userMessage: "Leaderboard not found.",
      });
    }
    const entries = [...entriesMap.values()].sort((a, b) => a.rank - b.rank);
    const scores = entries.map((e) => e.score);
    const snap: LeaderboardSnapshot = {
      id: generateId("lbs_"),
      leaderboardId,
      takenAt: getClock().iso(),
      entries,
      participantCount: entries.length,
      topScore: scores.length > 0 ? Math.max(...scores) : undefined,
      bottomScore: scores.length > 0 ? Math.min(...scores) : undefined,
      metadata,
    };
    const list = this.snapshots.get(leaderboardId) ?? [];
    list.push(snap);
    this.snapshots.set(leaderboardId, list);
    return snap;
  }

  getHistory(leaderboardId: LeaderboardId, participantId?: AccountId): LeaderboardSnapshot[] {
    const list = this.snapshots.get(leaderboardId) ?? [];
    if (!participantId) return [...list];
    return list
      .map((s) => ({
        ...s,
        entries: s.entries.filter((e) => e.participantId === participantId),
      }))
      .filter((s) => s.entries.length > 0);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalLeaderboards: number;
    totalEntries: number;
    totalSnapshots: number;
  } {
    let totalEntries = 0;
    let totalSnapshots = 0;
    for (const m of this.entries.values()) totalEntries += m.size;
    for (const s of this.snapshots.values()) totalSnapshots += s.length;
    return {
      totalLeaderboards: this.boards.size,
      totalEntries,
      totalSnapshots,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: recompute ranks for a leaderboard
  // -------------------------------------------------------------------------

  private recomputeRanks(leaderboardId: LeaderboardId): Map<AccountId, number> {
    const entriesMap = this.entries.get(leaderboardId)!;
    const insertionList = this.insertionOrder.get(leaderboardId)!;
    // Sort by score desc, then by insertion order (stable for ties)
    const all = [...entriesMap.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ai = insertionList.indexOf(a.participantId);
      const bi = insertionList.indexOf(b.participantId);
      return ai - bi;
    });
    const rankMap = new Map<AccountId, number>();
    const now = getClock().iso();
    for (let i = 0; i < all.length; i++) {
      const entry = all[i]!;
      const newRank = i + 1;
      // The "previous" rank is what the entry held BEFORE this recompute.
      // If `entry.previousRank` is undefined, this is the entry's first
      // ranking (trend = "new"). Otherwise compare the CURRENT rank
      // (entry.rank, captured before this recompute) to the new rank.
      const currentRank = entry.rank;
      const wasNew = entry.previousRank === undefined && currentRank === 0;
      const prevForTrend = wasNew ? undefined : (currentRank === 0 ? undefined : currentRank);
      let trend: LeaderboardEntry["trend"];
      if (prevForTrend === undefined) {
        trend = "new";
      } else if (newRank < prevForTrend) {
        trend = "up";
      } else if (newRank > prevForTrend) {
        trend = "down";
      } else {
        trend = "same";
      }
      const updated: LeaderboardEntry = {
        ...entry,
        rank: newRank,
        previousRank: prevForTrend,
        trend,
        updatedAt: now,
      };
      entriesMap.set(entry.participantId, updated);
      rankMap.set(entry.participantId, newRank);
    }
    return rankMap;
  }

  private computeTopNParticipantIds(leaderboardId: LeaderboardId, n: number): AccountId[] {
    const entriesMap = this.entries.get(leaderboardId);
    if (!entriesMap) return [];
    return [...entriesMap.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, n)
      .map((e) => e.participantId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function podiumEqual(a: AccountId[], b: AccountId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function scopeForField(field: string): LeaderboardScope {
  switch (field) {
    case "country": return "country";
    case "state": return "state";
    case "city": return "city";
    case "district": return "district";
    case "organization":
    case "org": return "organization";
    case "company": return "company";
    case "school": return "school";
    case "gender": return "gender";
    case "age":
    case "age_range": return "age";
    case "bmi_category": return "bmi_category";
    case "risk_profile": return "risk_profile";
    case "occupation": return "occupation";
    default: return "custom";
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: LeaderboardManager | null = null;
export function getLeaderboards(): LeaderboardManager {
  if (!_mgr) _mgr = new LeaderboardManager();
  return _mgr;
}
export function resetLeaderboards(): void {
  _mgr = null;
}
