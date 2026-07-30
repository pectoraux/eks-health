/**
 * Eks-Health Competition Platform — Ranking Engine
 *
 * Multiple ranking methods, pluggable per leaderboard / competition:
 *   - highest_score      : sort by score descending
 *   - most_improved      : sort by improvement delta
 *   - fastest_improvement: sort by improvement rate (delta / time)
 *   - consistency        : sort by lowest variance in scores
 *   - percentile         : assign percentile ranks
 *   - elo_rating         : Elo-like rating (K=32, expected = 1/(1+10^((opp-player)/400)))
 *   - tier_ranking       : group by tier/division then rank within
 *   - weighted_ranking   : alias for hybrid
 *   - hybrid             : weighted combination of multiple methods
 *
 * Pure functions over input arrays — no I/O, no global state. All math
 * is REAL (real sorting, real stddev, real percentile nearest-rank,
 * real Elo expected-score formula).
 */

import "server-only";
import {
  type RankingMethod,
  type DivisionId,
  type DivisionDefinition,
  type AccountId,
} from "../core";

// ---------------------------------------------------------------------------
// Public types (re-exported)
// ---------------------------------------------------------------------------

export type { RankingMethod };

// ---------------------------------------------------------------------------
// New types
// ---------------------------------------------------------------------------

/** A single input to the ranking engine. */
export interface RankingEntry {
  readonly participantId: AccountId | string;
  readonly score: number;
  readonly divisionId?: DivisionId;
  readonly metadata?: Record<string, unknown>;
}

/** Historical score sample for improvement / consistency methods. */
export interface HistoricalScore {
  readonly participantId: AccountId | string;
  readonly score: number;
  readonly at: string; // ISO timestamp
}

/** A pairwise match result for Elo. */
export interface MatchResult {
  readonly participantA: AccountId | string;
  readonly participantB: AccountId | string;
  /** 1 = A wins, 0 = B wins, 0.5 = draw. */
  readonly outcome: number;
  readonly at?: string;
}

export interface EloRating {
  readonly participantId: AccountId | string;
  readonly rating: number;
  readonly matchesPlayed: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
}

export interface PercentileRank {
  readonly participantId: AccountId | string;
  readonly percentile: number; // 0-100
  readonly rank: number;
  readonly totalEntries: number;
}

export interface RankingContext {
  /** Historical scores keyed by participantId (for most_improved, fastest_improvement, consistency). */
  readonly historicalScores?: ReadonlyArray<HistoricalScore>;
  /** Pairwise match history for Elo. */
  readonly matchHistory?: ReadonlyArray<MatchResult>;
  /** Divisions for tier ranking. */
  readonly divisions?: ReadonlyArray<DivisionDefinition>;
  /** Weights for hybrid method: { method: weight }. Weights need not sum to 1. */
  readonly hybridWeights?: Partial<Record<Exclude<RankingMethod, "hybrid" | "weighted_ranking">, number>>;
  /** K-factor for Elo (default 32). */
  readonly eloK?: number;
  /** Initial Elo rating (default 1200). */
  readonly eloInitial?: number;
}

export interface RankedEntry {
  readonly rank: number;
  readonly participantId: AccountId | string;
  readonly score: number;
  readonly trend?: "up" | "down" | "same" | "new";
  readonly metadata?: Record<string, unknown>;
  readonly methodMetadata?: Record<string, unknown>;
}

export interface RankingResult {
  readonly method: RankingMethod;
  readonly entries: RankedEntry[];
  readonly computedAt: string;
  readonly context?: RankingContext;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Ranking engine
// ---------------------------------------------------------------------------

export class RankingEngine {
  /**
   * Rank a set of entries using the specified method.
   */
  rank(entries: ReadonlyArray<RankingEntry>, method: RankingMethod, context?: RankingContext): RankingResult {
    const now = new Date().toISOString();
    switch (method) {
      case "highest_score":
        return this.wrapResult(this.rankByHighestScore(entries), "highest_score", context, now);
      case "most_improved":
        return this.wrapResult(this.rankByMostImproved(entries, context?.historicalScores ?? []), "most_improved", context, now);
      case "fastest_improvement":
        return this.wrapResult(this.rankByFastestImprovement(entries, context?.historicalScores ?? []), "fastest_improvement", context, now);
      case "consistency":
        return this.wrapResult(this.rankByConsistency(entries, context?.historicalScores ?? []), "consistency", context, now);
      case "percentile":
        return this.wrapPercentileResult(this.rankByPercentile(entries), entries, "percentile", context, now);
      case "elo_rating":
        return this.wrapEloResult(this.rankByElo(entries, context?.matchHistory ?? [], context), "elo_rating", context, now);
      case "tier_ranking":
        return this.wrapResult(this.rankByTier(entries, context?.divisions ?? []), "tier_ranking", context, now);
      case "weighted_ranking":
      case "hybrid":
        return this.wrapResult(this.rankHybrid(entries, context?.hybridWeights ?? {}), "hybrid", context, now);
      default:
        throw new Error(`Unknown ranking method: ${method}`);
    }
  }

  // -------------------------------------------------------------------------
  // Highest score
  // -------------------------------------------------------------------------

  rankByHighestScore(entries: ReadonlyArray<RankingEntry>): RankedEntry[] {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    return sorted.map((e, i) => ({
      rank: i + 1,
      participantId: e.participantId,
      score: e.score,
      metadata: e.metadata,
      methodMetadata: {},
    }));
  }

  // -------------------------------------------------------------------------
  // Most improved — sort by improvement delta (latest - earliest) desc
  // -------------------------------------------------------------------------

  rankByMostImproved(
    entries: ReadonlyArray<RankingEntry>,
    historicalScores: ReadonlyArray<HistoricalScore>,
  ): RankedEntry[] {
    const deltas = new Map<string, number>();
    for (const e of entries) {
      const hist = historicalScores.filter((h) => h.participantId === e.participantId);
      if (hist.length < 2) {
        deltas.set(String(e.participantId), 0);
        continue;
      }
      const sorted = [...hist].sort((a, b) => a.at.localeCompare(b.at));
      const first = sorted[0]!.score;
      const last = sorted[sorted.length - 1]!.score;
      deltas.set(String(e.participantId), last - first);
    }
    const sorted = [...entries].sort((a, b) => (deltas.get(String(b.participantId)) ?? 0) - (deltas.get(String(a.participantId)) ?? 0));
    return sorted.map((e, i) => ({
      rank: i + 1,
      participantId: e.participantId,
      score: e.score,
      metadata: e.metadata,
      methodMetadata: { improvement: deltas.get(String(e.participantId)) ?? 0 },
    }));
  }

  // -------------------------------------------------------------------------
  // Fastest improvement — sort by improvement rate (delta / time) desc
  // -------------------------------------------------------------------------

  rankByFastestImprovement(
    entries: ReadonlyArray<RankingEntry>,
    historicalScores: ReadonlyArray<HistoricalScore>,
  ): RankedEntry[] {
    const rates = new Map<string, number>();
    for (const e of entries) {
      const hist = historicalScores.filter((h) => h.participantId === e.participantId);
      if (hist.length < 2) {
        rates.set(String(e.participantId), 0);
        continue;
      }
      const sorted = [...hist].sort((a, b) => a.at.localeCompare(b.at));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const delta = last.score - first.score;
      const timeDays = (new Date(last.at).getTime() - new Date(first.at).getTime()) / (1000 * 60 * 60 * 24);
      const rate = timeDays > 0 ? delta / timeDays : 0;
      rates.set(String(e.participantId), rate);
    }
    const sorted = [...entries].sort((a, b) => (rates.get(String(b.participantId)) ?? 0) - (rates.get(String(a.participantId)) ?? 0));
    return sorted.map((e, i) => ({
      rank: i + 1,
      participantId: e.participantId,
      score: e.score,
      metadata: e.metadata,
      methodMetadata: { improvementRate: rates.get(String(e.participantId)) ?? 0 },
    }));
  }

  // -------------------------------------------------------------------------
  // Consistency — sort by lowest variance (most consistent first)
  // -------------------------------------------------------------------------

  rankByConsistency(
    entries: ReadonlyArray<RankingEntry>,
    historicalScores: ReadonlyArray<HistoricalScore>,
  ): RankedEntry[] {
    const stddevMap = new Map<string, number>();
    for (const e of entries) {
      const hist = historicalScores.filter((h) => h.participantId === e.participantId);
      if (hist.length < 2) {
        // No history → treat as maximum variance (least consistent)
        stddevMap.set(String(e.participantId), Number.POSITIVE_INFINITY);
        continue;
      }
      const nums = hist.map((h) => h.score);
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const variance = nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length;
      stddevMap.set(String(e.participantId), Math.sqrt(variance));
    }
    // Lowest stddev first (most consistent)
    const sorted = [...entries].sort((a, b) => (stddevMap.get(String(a.participantId)) ?? Infinity) - (stddevMap.get(String(b.participantId)) ?? Infinity));
    return sorted.map((e, i) => ({
      rank: i + 1,
      participantId: e.participantId,
      score: e.score,
      metadata: e.metadata,
      methodMetadata: { stddev: stddevMap.get(String(e.participantId)) ?? 0 },
    }));
  }

  // -------------------------------------------------------------------------
  // Percentile — assign percentile ranks (nearest-rank method)
  // -------------------------------------------------------------------------

  rankByPercentile(entries: ReadonlyArray<RankingEntry>): RankedEntry[] {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const n = sorted.length;
    return sorted.map((e, i) => {
      const rank = i + 1;
      // Nearest-rank percentile: P = (n - rank + 1) / n * 100
      const percentile = n > 0 ? ((n - rank + 1) / n) * 100 : 0;
      return {
        rank,
        participantId: e.participantId,
        score: e.score,
        metadata: e.metadata,
        methodMetadata: { percentile },
      };
    });
  }

  /**
   * What percentile does a given score fall into, relative to allScores?
   * Uses the nearest-rank method: percentile = (count of scores <= score) / total * 100.
   */
  getPercentile(score: number, allScores: ReadonlyArray<number>): number {
    if (allScores.length === 0) return 0;
    const count = allScores.filter((s) => s <= score).length;
    return (count / allScores.length) * 100;
  }

  // -------------------------------------------------------------------------
  // Elo rating — REAL Elo expected-score formula
  //   expected_A = 1 / (1 + 10^((ratingB - ratingA) / 400))
  //   newA = ratingA + K * (outcomeA - expectedA)
  //   K default = 32, initial = 1200
  // -------------------------------------------------------------------------

  rankByElo(
    entries: ReadonlyArray<RankingEntry>,
    matchHistory: ReadonlyArray<MatchResult>,
    context?: RankingContext,
  ): EloRating[] {
    const K = context?.eloK ?? 32;
    const initial = context?.eloInitial ?? 1200;
    const ratings = new Map<string, number>();
    const stats = new Map<string, { matches: number; wins: number; losses: number; draws: number }>();

    for (const e of entries) {
      ratings.set(String(e.participantId), initial);
      stats.set(String(e.participantId), { matches: 0, wins: 0, losses: 0, draws: 0 });
    }

    // Process matches in chronological order (if at is provided)
    const sortedMatches = [...matchHistory].sort((a, b) => {
      const ta = a.at ?? "";
      const tb = b.at ?? "";
      return ta.localeCompare(tb);
    });

    for (const m of sortedMatches) {
      const aId = String(m.participantA);
      const bId = String(m.participantB);
      const ra = ratings.get(aId) ?? initial;
      const rb = ratings.get(bId) ?? initial;
      const expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 400));
      const expectedB = 1 - expectedA;
      const outcomeA = m.outcome;
      const outcomeB = 1 - m.outcome;
      ratings.set(aId, ra + K * (outcomeA - expectedA));
      ratings.set(bId, rb + K * (outcomeB - expectedB));
      const sa = stats.get(aId) ?? { matches: 0, wins: 0, losses: 0, draws: 0 };
      const sb = stats.get(bId) ?? { matches: 0, wins: 0, losses: 0, draws: 0 };
      sa.matches++;
      sb.matches++;
      if (outcomeA > 0.5) { sa.wins++; sb.losses++; }
      else if (outcomeA < 0.5) { sa.losses++; sb.wins++; }
      else { sa.draws++; sb.draws++; }
      stats.set(aId, sa);
      stats.set(bId, sb);
    }

    const list: EloRating[] = entries.map((e) => {
      const id = String(e.participantId);
      const s = stats.get(id) ?? { matches: 0, wins: 0, losses: 0, draws: 0 };
      return {
        participantId: e.participantId,
        rating: ratings.get(id) ?? initial,
        matchesPlayed: s.matches,
        wins: s.wins,
        losses: s.losses,
        draws: s.draws,
      };
    });
    return list.sort((a, b) => b.rating - a.rating);
  }

  // -------------------------------------------------------------------------
  // Tier ranking — group by division, then rank within each tier
  // -------------------------------------------------------------------------

  rankByTier(
    entries: ReadonlyArray<RankingEntry>,
    divisions: ReadonlyArray<DivisionDefinition>,
  ): RankedEntry[] {
    // Sort divisions by minScore desc (highest tier first)
    const sortedDivs = [...divisions].sort((a, b) => (b.minScore ?? 0) - (a.minScore ?? 0));
    const result: RankedEntry[] = [];
    let rank = 1;
    for (const div of sortedDivs) {
      const inTier = entries.filter((e) =>
        (div.minScore === undefined || e.score >= div.minScore) &&
        (div.maxScore === undefined || e.score < div.maxScore),
      );
      const sorted = [...inTier].sort((a, b) => b.score - a.score);
      for (const e of sorted) {
        result.push({
          rank,
          participantId: e.participantId,
          score: e.score,
          metadata: e.metadata,
          methodMetadata: { division: div.name, tier: div.tier },
        });
        rank++;
      }
    }
    // Any entries that didn't fit any division go last
    const placed = new Set(result.map((r) => String(r.participantId)));
    for (const e of entries) {
      if (placed.has(String(e.participantId))) continue;
      result.push({
        rank,
        participantId: e.participantId,
        score: e.score,
        metadata: e.metadata,
        methodMetadata: { division: "unranked", tier: "custom" },
      });
      rank++;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Hybrid — weighted combination of multiple methods
  // -------------------------------------------------------------------------

  rankHybrid(
    entries: ReadonlyArray<RankingEntry>,
    weights: Partial<Record<Exclude<RankingMethod, "hybrid" | "weighted_ranking">, number>>,
  ): RankedEntry[] {
    // Default: equal weighting across the methods provided
    const methods = Object.keys(weights) as Array<Exclude<RankingMethod, "hybrid" | "weighted_ranking">>;
    if (methods.length === 0) {
      // No weights → fall back to highest_score
      return this.rankByHighestScore(entries);
    }
    const totalWeight = methods.reduce((s, m) => s + (weights[m] ?? 0), 0);
    if (totalWeight === 0) return this.rankByHighestScore(entries);

    // Compute ranks per method, then convert to normalized scores (0-1) where
    // higher is better. For consistency, lower stddev = higher normalized.
    const normalizedByMethod = new Map<string, Map<string, number>>();
    for (const m of methods) {
      let ranks: RankedEntry[];
      switch (m) {
        case "highest_score": ranks = this.rankByHighestScore(entries); break;
        case "most_improved": ranks = this.rankByMostImproved(entries, []); break;
        case "fastest_improvement": ranks = this.rankByFastestImprovement(entries, []); break;
        case "consistency": ranks = this.rankByConsistency(entries, []); break;
        case "percentile": ranks = this.rankByPercentile(entries); break;
        case "elo_rating": ranks = this.rankByElo(entries, []).map((r, i) => ({
          rank: i + 1, participantId: r.participantId, score: r.rating,
          metadata: {}, methodMetadata: { rating: r.rating },
        })); break;
        case "tier_ranking": ranks = this.rankByTier(entries, []); break;
        default: ranks = this.rankByHighestScore(entries); break;
      }
      const n = ranks.length;
      const map = new Map<string, number>();
      for (const r of ranks) {
        // Normalize rank to 0-1 where rank 1 → 1.0, last rank → 0.0
        const norm = n > 1 ? (n - r.rank) / (n - 1) : 1;
        map.set(String(r.participantId), norm);
      }
      normalizedByMethod.set(m, map);
    }

    // Compute weighted aggregate
    const aggregates = new Map<string, number>();
    for (const e of entries) {
      const id = String(e.participantId);
      let agg = 0;
      for (const m of methods) {
        const w = (weights[m] ?? 0) / totalWeight;
        const v = normalizedByMethod.get(m)?.get(id) ?? 0;
        agg += w * v;
      }
      aggregates.set(id, agg);
    }
    const sorted = [...entries].sort((a, b) => (aggregates.get(String(b.participantId)) ?? 0) - (aggregates.get(String(a.participantId)) ?? 0));
    return sorted.map((e, i) => ({
      rank: i + 1,
      participantId: e.participantId,
      score: e.score,
      metadata: e.metadata,
      methodMetadata: { hybridScore: aggregates.get(String(e.participantId)) ?? 0 },
    }));
  }

  // -------------------------------------------------------------------------
  // Wrap helpers — convert RankedEntry[] to RankingResult
  // -------------------------------------------------------------------------

  private wrapResult(
    ranked: RankedEntry[],
    method: RankingMethod,
    context: RankingContext | undefined,
    now: string,
  ): RankingResult {
    return {
      method,
      entries: ranked,
      computedAt: now,
      context,
      metadata: { count: ranked.length },
    };
  }

  private wrapPercentileResult(
    ranked: RankedEntry[],
    entries: ReadonlyArray<RankingEntry>,
    method: RankingMethod,
    context: RankingContext | undefined,
    now: string,
  ): RankingResult {
    const percentiles: PercentileRank[] = ranked.map((r) => ({
      participantId: r.participantId,
      percentile: (r.methodMetadata?.percentile as number | undefined) ?? 0,
      rank: r.rank,
      totalEntries: entries.length,
    }));
    return {
      method,
      entries: ranked,
      computedAt: now,
      context,
      metadata: { count: ranked.length, percentiles },
    };
  }

  private wrapEloResult(
    ratings: EloRating[],
    method: RankingMethod,
    context: RankingContext | undefined,
    now: string,
  ): RankingResult {
    const entries: RankedEntry[] = ratings.map((r, i) => ({
      rank: i + 1,
      participantId: r.participantId,
      score: r.rating,
      metadata: {},
      methodMetadata: {
        rating: r.rating,
        matchesPlayed: r.matchesPlayed,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
      },
    }));
    return {
      method,
      entries,
      computedAt: now,
      context,
      metadata: { count: entries.length, eloRatings: ratings },
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: RankingEngine | null = null;
export function getRanking(): RankingEngine {
  if (!_engine) _engine = new RankingEngine();
  return _engine;
}
export function resetRanking(): void {
  _engine = null;
}

// ---------------------------------------------------------------------------
// Re-export DivisionDefinition for callers using tier ranking
// ---------------------------------------------------------------------------

export type { DivisionDefinition } from "../core";
