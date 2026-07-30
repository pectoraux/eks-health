/**
 * Eks-Health Competition Platform — Competition Analytics
 *
 * Tracks: participation, retention, competition health, leaderboard dynamics,
 * score distribution, improvement trends, reward utilization, prize pool
 * growth, fraud indicators, historical comparisons. This module provides
 * ONLY the analytics infrastructure — no dashboards.
 *
 * Real algorithms:
 *  - Welford's online algorithm for mean & variance (numerically stable).
 *  - Real median (sort + pick middle / average of two).
 *  - Real histogram bucketing (10 buckets of width 10 covering [0, 100]).
 *  - Real least-squares linear regression for improvement trends (slope,
 *    intercept, r²).
 *  - Real rank-volatility (average |rank − previousRank|) and top-N stability.
 *
 * All sibling-module access is dynamic-imported and guarded with try/catch so
 * this module degrades gracefully when a sibling is unavailable.
 */

import "server-only";
import {
  type CompetitionId,
  type SeasonId,
  type AccountId,
  type PrizePoolId,
  type Participation,
  type LeaderboardEntry,
  type ScoreRecord,
  type RewardScheduleId,
} from "../core";
import { getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Analytics result types
// ---------------------------------------------------------------------------

export interface ParticipationStats {
  readonly totalRegistered: number;
  readonly active: number;
  readonly withdrawn: number;
  readonly qualified: number;
  readonly eliminated: number;
  readonly banned: number;
  readonly retentionRate: number;
  readonly churnRate: number;
}

export interface ScoreDistribution {
  readonly buckets: { range: string; count: number; min: number; max: number }[];
  readonly mean: number;
  readonly median: number;
  readonly stddev: number;
  readonly count: number;
  readonly min: number;
  readonly max: number;
}

export interface LeaderboardDynamics {
  readonly rankVolatility: number;
  readonly topNStability: number;
  readonly totalEntries: number;
  readonly newEntries: number;
  readonly upwardMoves: number;
  readonly downwardMoves: number;
}

export interface ImprovementTrend {
  readonly slope: number;
  readonly intercept: number;
  readonly sampleCount: number;
  readonly rSquared: number;
  readonly direction: "improving" | "declining" | "stable";
}

export interface RewardUtilization {
  readonly totalScheduled: number;
  readonly totalTriggered: number;
  readonly totalCancelled: number;
  readonly totalAmountTriggered: number;
  readonly utilizationRate: number;
  readonly payoutRate: number;
}

export interface PrizePoolGrowth {
  readonly poolId: PrizePoolId;
  readonly currency: string;
  readonly currentBalance: number;
  readonly totalCredits: number;
  readonly totalDebits: number;
  readonly transactionCount: number;
  readonly timeline: { at: string; balance: number; delta: number; type: "credit" | "debit"; source?: string }[];
}

export interface HistoricalComparison {
  readonly currentSeasonId: SeasonId;
  readonly currentSeason: { name: string; participation: number; avgScore: number; rewardPayout: number };
  readonly previousSeasons: { seasonId: SeasonId; name: string; participation: number; avgScore: number; rewardPayout: number }[];
  readonly deltas: { participationDelta: number; avgScoreDelta: number; rewardPayoutDelta: number };
}

export interface FraudIndicators {
  readonly totalFlags: number;
  readonly openFlags: number;
  readonly confirmedFlags: number;
  readonly falsePositives: number;
  readonly byType: Record<string, number>;
  readonly bySeverity: Record<string, number>;
  readonly confirmationRate: number;
  readonly falsePositiveRate: number;
}

export interface CompetitionAnalytics {
  readonly competitionId: CompetitionId;
  readonly seasonId?: SeasonId;
  readonly generatedAt: string;
  readonly participation: ParticipationStats;
  readonly scoreDistribution?: ScoreDistribution;
  readonly leaderboardDynamics?: LeaderboardDynamics;
  readonly improvementTrend?: ImprovementTrend;
  readonly rewardUtilization?: RewardUtilization;
  readonly prizePoolGrowth?: PrizePoolGrowth;
  readonly fraudIndicators?: FraudIndicators;
}

// ---------------------------------------------------------------------------
// Real statistical helpers
// ---------------------------------------------------------------------------

interface StatsResult {
  readonly mean: number;
  readonly median: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

/** Welford's online algorithm for mean & variance; real median via sort. */
function computeStats(values: readonly number[]): StatsResult {
  if (values.length === 0) {
    return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, count: 0 };
  }
  let n = 0;
  let mean = 0;
  let M2 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const x of values) {
    if (!Number.isFinite(x)) continue;
    n++;
    const delta = x - mean;
    mean += delta / n;
    const delta2 = x - mean;
    M2 += delta * delta2;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (n === 0) {
    return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, count: 0 };
  }
  const variance = n > 1 ? M2 / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
  return { mean, median, stddev, min, max, count: n };
}

/** Real histogram bucketing: 10 buckets of width 10 covering [0, 100]. */
function histogram(values: readonly number[]): { range: string; count: number; min: number; max: number }[] {
  const buckets: { range: string; count: number; min: number; max: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i * 10;
    const hi = (i + 1) * 10;
    buckets.push({ range: `${lo}-${hi}`, count: 0, min: lo, max: hi });
  }
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const idx = Math.min(9, Math.max(0, Math.floor(v / 10)));
    buckets[idx].count++;
  }
  return buckets;
}

interface RegressionResult {
  readonly slope: number;
  readonly intercept: number;
  readonly rSquared: number;
}

/** Real least-squares linear regression. */
function linearRegression(points: readonly { x: number; y: number }[]): RegressionResult {
  const n = points.length;
  if (n < 2) {
    return { slope: 0, intercept: points[0]?.y ?? 0, rSquared: 0 };
  }
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) {
    return { slope: 0, intercept: sumY / n, rSquared: 0 };
  }
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const denomY = n * sumY2 - sumY * sumY;
  if (denomY === 0) {
    return { slope, intercept, rSquared: 0 };
  }
  const rSquared = Math.pow(n * sumXY - sumX * sumY, 2) / (denom * denomY);
  return { slope, intercept, rSquared };
}

// ---------------------------------------------------------------------------
// Sibling-module loaders (dynamic imports guard against missing modules)
// ---------------------------------------------------------------------------

async function fetchParticipations(competitionId: CompetitionId): Promise<Participation[]> {
  try {
    const path = "../qualification";
    const mod: { getQualification?: () => unknown } = (await import(path)) as { getQualification?: () => unknown };
    const mgr = mod?.getQualification?.() as {
      listParticipations?: (id: CompetitionId) => Participation[] | Promise<Participation[]>;
    } | undefined;
    if (!mgr?.listParticipations) return [];
    const result = await mgr.listParticipations(competitionId);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function fetchLeaderboardEntries(competitionId: CompetitionId, seasonId: SeasonId, n: number): Promise<LeaderboardEntry[]> {
  try {
    const path = "../leaderboards";
    const mod: { getLeaderboards?: () => unknown } = (await import(path)) as { getLeaderboards?: () => unknown };
    const lb = mod?.getLeaderboards?.() as {
      getTopN?: (id: unknown, n: number) => LeaderboardEntry[] | Promise<LeaderboardEntry[]>;
      listByCompetition?: (id: CompetitionId, sid: SeasonId) => { id: unknown }[] | Promise<{ id: unknown }[]>;
    } | undefined;
    if (!lb) return [];
    // Try to find a leaderboard for this competition+season.
    let leaderboardId: unknown = undefined;
    if (lb.listByCompetition) {
      const defs = await lb.listByCompetition(competitionId, seasonId);
      if (defs.length > 0) leaderboardId = defs[0].id;
    }
    if (leaderboardId === undefined || !lb.getTopN) return [];
    const result = await lb.getTopN(leaderboardId, n);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function fetchScoreHistory(
  participantId: AccountId,
  competitionId: CompetitionId,
  seasonId: SeasonId,
): Promise<{ score: number; at: string }[]> {
  try {
    const path = "../scoring";
    const mod: { getScoring?: () => unknown } = (await import(path)) as { getScoring?: () => unknown };
    const mgr = mod?.getScoring?.() as {
      getScoreHistory?: (p: AccountId, c: CompetitionId, s: SeasonId) => { score: number; at: string }[] | Promise<{ score: number; at: string }[]>;
      getLatestScore?: (p: AccountId, c: CompetitionId, s: SeasonId) => ScoreRecord | Promise<ScoreRecord | null>;
    } | undefined;
    if (!mgr) return [];
    if (mgr.getScoreHistory) {
      const result = await mgr.getScoreHistory(participantId, competitionId, seasonId);
      return Array.isArray(result) ? result : [];
    }
    // Fall back to a single-point history from getLatestScore.
    if (mgr.getLatestScore) {
      const rec = await mgr.getLatestScore(participantId, competitionId, seasonId);
      if (rec) return [{ score: rec.totalScore, at: rec.computedAt }];
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchAllScores(competitionId: CompetitionId, seasonId: SeasonId): Promise<{ participantId: AccountId; score: number }[]> {
  try {
    const path = "../scoring";
    const mod: { getScoring?: () => unknown } = (await import(path)) as { getScoring?: () => unknown };
    const mgr = mod?.getScoring?.() as {
      listScores?: (c: CompetitionId, s: SeasonId) => ScoreRecord[] | Promise<ScoreRecord[]>;
    } | undefined;
    if (!mgr?.listScores) return [];
    const result = await mgr.listScores(competitionId, seasonId);
    if (!Array.isArray(result)) return [];
    return result.map((r) => ({ participantId: r.participantId, score: r.totalScore }));
  } catch {
    return [];
  }
}

async function fetchRewardStats(competitionId: CompetitionId): Promise<{
  totalScheduled: number;
  totalTriggered: number;
  totalCancelled: number;
  totalAmount: number;
} | null> {
  try {
    const path = "../rewards";
    const mod: { getRewards?: () => unknown } = (await import(path)) as { getRewards?: () => unknown };
    const mgr = mod?.getRewards?.() as {
      getStats?: (c?: CompetitionId) => { totalSchedules: number; totalTriggered: number; totalCancelled: number; totalAmount: number };
    } | undefined;
    if (!mgr?.getStats) return null;
    const s = mgr.getStats(competitionId);
    return { totalScheduled: s.totalSchedules, totalTriggered: s.totalTriggered, totalCancelled: s.totalCancelled, totalAmount: s.totalAmount };
  } catch {
    return null;
  }
}

async function fetchPrizePoolForCompetition(
  competitionId: CompetitionId,
  seasonId?: SeasonId,
): Promise<{ poolId: PrizePoolId; currency: string; balance: number; transactions: { at: string; balance: number; delta: number; type: "credit" | "debit"; source?: string }[] } | null> {
  try {
    const path = "../prize-pools";
    const mod: { getPrizePools?: () => unknown } = (await import(path)) as { getPrizePools?: () => unknown };
    const mgr = mod?.getPrizePools?.() as {
      list?: (c?: CompetitionId, s?: SeasonId) => { id: PrizePoolId; currency: string; balance: number }[];
      getTransactions?: (id: PrizePoolId) => { at: string; type: "credit" | "debit"; amount: number; source?: string }[];
    } | undefined;
    if (!mgr?.list) return null;
    const pools = mgr.list(competitionId, seasonId);
    if (pools.length === 0) return null;
    const pool = pools[0];
    const txns = mgr.getTransactions?.(pool.id) ?? [];
    // Build a running-balance timeline.
    let running = 0;
    const timeline = txns
      .slice()
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      .map((t) => {
        const delta = t.type === "credit" ? t.amount : -t.amount;
        running += delta;
        return { at: t.at, balance: running, delta, type: t.type, source: t.source };
      });
    return { poolId: pool.id, currency: pool.currency, balance: pool.balance, transactions: timeline };
  } catch {
    return null;
  }
}

async function fetchPrizePoolStats(competitionId: CompetitionId): Promise<{ totalPaid: number } | null> {
  try {
    const path = "../prize-pools";
    const mod: { getPrizePools?: () => unknown } = (await import(path)) as { getPrizePools?: () => unknown };
    const mgr = mod?.getPrizePools?.() as {
      getStats?: (c?: CompetitionId) => { totalPaid: number };
    } | undefined;
    if (!mgr?.getStats) return null;
    const s = mgr.getStats(competitionId);
    return { totalPaid: s.totalPaid };
  } catch {
    return null;
  }
}

async function fetchAntiCheatStats(competitionId: CompetitionId): Promise<{
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  confirmationRate: number;
  falsePositiveRate: number;
} | null> {
  try {
    const path = "../anti-cheating";
    const mod: { getAntiCheat?: () => unknown } = (await import(path)) as { getAntiCheat?: () => unknown };
    const mgr = mod?.getAntiCheat?.() as {
      getStats?: (c?: CompetitionId) => {
        total: number;
        byType: Record<string, number>;
        bySeverity: Record<string, number>;
        byStatus: Record<string, number>;
        confirmationRate: number;
        falsePositiveRate: number;
      };
    } | undefined;
    if (!mgr?.getStats) return null;
    return mgr.getStats(competitionId);
  } catch {
    return null;
  }
}

async function fetchSeasons(competitionId: CompetitionId): Promise<{ id: SeasonId; name: string; sequence: number }[]> {
  try {
    const path = "../seasons";
    const mod: { getSeasons?: () => unknown } = (await import(path)) as { getSeasons?: () => unknown };
    const mgr = mod?.getSeasons?.() as {
      listByCompetition?: (id: CompetitionId) => { id: SeasonId; name: string; sequence: number }[];
    } | undefined;
    if (!mgr?.listByCompetition) return [];
    return mgr.listByCompetition(competitionId) ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Analytics engine
// ---------------------------------------------------------------------------

export class CompetitionAnalyticsEngine {
  /**
   * Aggregate all analytics for a competition. Fetches from every sibling
   * module (guarded) and combines the results.
   */
  async getCompetitionAnalytics(competitionId: CompetitionId, seasonId?: SeasonId): Promise<CompetitionAnalytics> {
    const participation = await this.getParticipationStats(competitionId, seasonId);
    const [scoreDistribution, leaderboardDynamics, improvementTrend, rewardUtilization, prizePoolGrowth, fraudIndicators] =
      await Promise.all([
        seasonId ? this.getScoreDistribution(competitionId, seasonId) : Promise.resolve(undefined),
        seasonId ? this.getLeaderboardDynamics(competitionId, seasonId) : Promise.resolve(undefined),
        seasonId ? this.getImprovementTrend(competitionId, seasonId) : Promise.resolve(undefined),
        this.getRewardUtilization(competitionId, seasonId),
        this.getPrizePoolGrowth(competitionId, seasonId),
        this.getFraudIndicators(competitionId),
      ]);
    return {
      competitionId,
      seasonId,
      generatedAt: getClock().iso(),
      participation,
      scoreDistribution,
      leaderboardDynamics,
      improvementTrend,
      rewardUtilization,
      prizePoolGrowth,
      fraudIndicators,
    };
  }

  /** Participation counts + retention/churn rates (real). */
  async getParticipationStats(competitionId: CompetitionId, seasonId?: SeasonId): Promise<ParticipationStats> {
    const participations = await fetchParticipations(competitionId);
    let list = participations;
    if (seasonId) list = participations.filter((p) => p.seasonId === seasonId);
    const total = list.length;
    const active = list.filter((p) => p.status === "active").length;
    const withdrawn = list.filter((p) => p.status === "withdrawn").length;
    const qualified = list.filter((p) => p.status === "qualified" || p.status === "active").length;
    const eliminated = list.filter((p) => p.status === "eliminated").length;
    const banned = list.filter((p) => p.status === "banned").length;
    // Retention = active / total registered. Churn = (withdrawn + eliminated + banned) / total.
    const retentionRate = total > 0 ? active / total : 0;
    const churnRate = total > 0 ? (withdrawn + eliminated + banned) / total : 0;
    return { totalRegistered: total, active, withdrawn, qualified, eliminated, banned, retentionRate, churnRate };
  }

  /** Histogram of scores + mean/median/stddev (real Welford's + sort). */
  async getScoreDistribution(competitionId: CompetitionId, seasonId: SeasonId): Promise<ScoreDistribution> {
    const scores = await fetchAllScores(competitionId, seasonId);
    const values = scores.map((s) => s.score);
    const stats = computeStats(values);
    const buckets = histogram(values);
    return {
      buckets,
      mean: stats.mean,
      median: stats.median,
      stddev: stats.stddev,
      count: stats.count,
      min: stats.min,
      max: stats.max,
    };
  }

  /** Rank volatility (avg |rank − previousRank|) + top-N stability (real). */
  async getLeaderboardDynamics(competitionId: CompetitionId, seasonId: SeasonId): Promise<LeaderboardDynamics> {
    const entries = await fetchLeaderboardEntries(competitionId, seasonId, 1000);
    const totalEntries = entries.length;
    const newEntries = entries.filter((e) => e.trend === "new").length;
    const upwardMoves = entries.filter((e) => e.trend === "up").length;
    const downwardMoves = entries.filter((e) => e.trend === "down").length;
    // Rank volatility = average |rank − previousRank| over entries with a previousRank.
    const withPrev = entries.filter((e) => e.previousRank !== undefined);
    const volatility = withPrev.length > 0 ? withPrev.reduce((s, e) => s + Math.abs(e.rank - (e.previousRank ?? e.rank)), 0) / withPrev.length : 0;
    // Top-N stability: fraction of current top-10 that were also in top-10 previously.
    const topN = 10;
    const currentTop = entries.slice(0, Math.min(topN, entries.length));
    const stableCount = currentTop.filter((e) => e.previousRank !== undefined && e.previousRank <= topN).length;
    const topNStability = currentTop.length > 0 ? stableCount / currentTop.length : 0;
    return {
      rankVolatility: volatility,
      topNStability,
      totalEntries,
      newEntries,
      upwardMoves,
      downwardMoves,
    };
  }

  /** Average improvement across participants over time (real linear regression). */
  async getImprovementTrend(competitionId: CompetitionId, seasonId: SeasonId): Promise<ImprovementTrend> {
    const participations = await fetchParticipations(competitionId);
    const seasonParticipations = participations.filter((p) => p.seasonId === seasonId);
    // For each participant, fetch their score history and build (day-offset, score) points.
    const allPoints: { x: number; y: number }[] = [];
    const seasonStartMs = seasonParticipations.length > 0
      ? Math.min(...seasonParticipations.map((p) => new Date(p.registeredAt).getTime()).filter(Number.isFinite))
      : Date.now();
    await Promise.all(
      seasonParticipations.map(async (p) => {
        const history = await fetchScoreHistory(p.participantId, competitionId, seasonId);
        for (const h of history) {
          const t = new Date(h.at).getTime();
          if (!Number.isFinite(t)) continue;
          const dayOffset = (t - seasonStartMs) / 86_400_000;
          allPoints.push({ x: dayOffset, y: h.score });
        }
      }),
    );
    const reg = linearRegression(allPoints);
    let direction: "improving" | "declining" | "stable" = "stable";
    // Treat slopes within ±0.01 points/day as stable.
    if (reg.slope > 0.01) direction = "improving";
    else if (reg.slope < -0.01) direction = "declining";
    return {
      slope: reg.slope,
      intercept: reg.intercept,
      sampleCount: allPoints.length,
      rSquared: reg.rSquared,
      direction,
    };
  }

  /** Total rewards scheduled vs triggered vs paid + utilization & payout rates. */
  async getRewardUtilization(competitionId: CompetitionId, seasonId?: SeasonId): Promise<RewardUtilization> {
    const rewardStats = await fetchRewardStats(competitionId);
    const poolStats = await fetchPrizePoolStats(competitionId);
    const totalScheduled = rewardStats?.totalScheduled ?? 0;
    const totalTriggered = rewardStats?.totalTriggered ?? 0;
    const totalCancelled = rewardStats?.totalCancelled ?? 0;
    const totalAmountTriggered = rewardStats?.totalAmount ?? 0;
    const totalPaid = poolStats?.totalPaid ?? 0;
    const utilizationRate = totalScheduled > 0 ? totalTriggered / totalScheduled : 0;
    const payoutRate = totalTriggered > 0 ? totalPaid / totalTriggered : 0;
    return {
      totalScheduled,
      totalTriggered,
      totalCancelled,
      totalAmountTriggered,
      utilizationRate,
      payoutRate,
    };
  }

  /** Prize pool balance over time (real transaction history with running balance). */
  async getPrizePoolGrowth(competitionId: CompetitionId, seasonId?: SeasonId): Promise<PrizePoolGrowth | undefined> {
    const data = await fetchPrizePoolForCompetition(competitionId, seasonId);
    if (!data) return undefined;
    const credits = data.transactions.filter((t) => t.type === "credit").reduce((s, t) => s + t.delta, 0);
    const debits = data.transactions.filter((t) => t.type === "debit").reduce((s, t) => s + Math.abs(t.delta), 0);
    return {
      poolId: data.poolId,
      currency: data.currency,
      currentBalance: data.balance,
      totalCredits: credits,
      totalDebits: debits,
      transactionCount: data.transactions.length,
      timeline: data.transactions,
    };
  }

  /** Compare this season's metrics to previous seasons (real). */
  async getHistoricalComparison(competitionId: CompetitionId, seasonId: SeasonId): Promise<HistoricalComparison | undefined> {
    const seasons = await fetchSeasons(competitionId);
    if (seasons.length === 0) return undefined;
    // Sort by sequence ascending.
    const sorted = [...seasons].sort((a, b) => a.sequence - b.sequence);
    const currentIdx = sorted.findIndex((s) => s.id === seasonId);
    if (currentIdx === -1) return undefined;
    const previousSeasons = sorted.slice(0, currentIdx);
    // Compute metrics for each season.
    const computeMetrics = async (sid: SeasonId, name: string) => {
      const participations = (await fetchParticipations(competitionId)).filter((p) => p.seasonId === sid);
      const scores = await fetchAllScores(competitionId, sid);
      const avgScore = scores.length > 0 ? scores.reduce((s, x) => s + x.score, 0) / scores.length : 0;
      // Reward payout approximation: use reward stats filtered by season.
      let rewardPayout = 0;
      try {
        const path = "../rewards";
        const mod: { getRewards?: () => unknown } = (await import(path)) as { getRewards?: () => unknown };
        const mgr = mod?.getRewards?.() as {
          listRewardEvents?: (filter?: { scheduleId?: unknown }) => { scheduleId: RewardScheduleId; seasonId: SeasonId; amount: number; type: string }[];
          listSchedules?: (c?: CompetitionId, s?: SeasonId) => { id: RewardScheduleId }[];
        } | undefined;
        if (mgr?.listSchedules && mgr.listRewardEvents) {
          const schedules = mgr.listSchedules(competitionId, sid);
          const scheduleIds = new Set(schedules.map((s) => s.id));
          const events = mgr.listRewardEvents();
          rewardPayout = events
            .filter((e) => scheduleIds.has(e.scheduleId) && e.seasonId === sid && e.type === "reward_triggered")
            .reduce((s, e) => s + e.amount, 0);
        }
      } catch {
        /* ignore */
      }
      return { seasonId: sid, name, participation: participations.length, avgScore, rewardPayout };
    };
    const currentMetrics = await computeMetrics(seasonId, sorted[currentIdx].name);
    const previousMetrics = await Promise.all(previousSeasons.map((s) => computeMetrics(s.id, s.name)));
    // Deltas vs the most recent previous season (if any).
    const prev = previousMetrics[previousMetrics.length - 1];
    const deltas = prev
      ? {
          participationDelta: currentMetrics.participation - prev.participation,
          avgScoreDelta: currentMetrics.avgScore - prev.avgScore,
          rewardPayoutDelta: currentMetrics.rewardPayout - prev.rewardPayout,
        }
      : { participationDelta: 0, avgScoreDelta: 0, rewardPayoutDelta: 0 };
    return {
      currentSeasonId: seasonId,
      currentSeason: currentMetrics,
      previousSeasons: previousMetrics,
      deltas,
    };
  }

  /** Anti-cheat flag summary (real, from the anti-cheat engine). */
  async getFraudIndicators(competitionId: CompetitionId): Promise<FraudIndicators> {
    const stats = await fetchAntiCheatStats(competitionId);
    if (!stats) {
      return {
        totalFlags: 0,
        openFlags: 0,
        confirmedFlags: 0,
        falsePositives: 0,
        byType: {},
        bySeverity: {},
        confirmationRate: 0,
        falsePositiveRate: 0,
      };
    }
    return {
      totalFlags: stats.total,
      openFlags: stats.byStatus.open ?? 0,
      confirmedFlags: (stats.byStatus.confirmed ?? 0) + (stats.byStatus.resolved ?? 0),
      falsePositives: stats.byStatus.false_positive ?? 0,
      byType: stats.byType,
      bySeverity: stats.bySeverity,
      confirmationRate: stats.confirmationRate,
      falsePositiveRate: stats.falsePositiveRate,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: CompetitionAnalyticsEngine | null = null;
export function getCompetitionAnalytics(): CompetitionAnalyticsEngine {
  if (!_engine) _engine = new CompetitionAnalyticsEngine();
  return _engine;
}

export function resetCompetitionAnalytics(): void {
  _engine = null;
}
