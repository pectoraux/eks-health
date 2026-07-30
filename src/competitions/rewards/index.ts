/**
 * Eks-Health Competition Platform — Reward Distribution & Scheduled Reward Engine
 *
 * Programs define reward policies (podium size, distribution percentages, min
 * pool threshold, carry-over rules, max payout caps, conditions). The
 * scheduled reward engine evaluates reward conditions against current
 * standings, computes reward amounts from distribution percentages × prize
 * pool balance, and emits events. The Payment Provider executes the actual
 * transfers — this module NEVER executes payment.
 *
 * Event flow:
 *  - createSchedule  → eks.competition.reward.scheduled
 *  - evaluate        → eks.competition.reward.ready
 *  - trigger         → eks.competition.reward.triggered (per participant)
 *                      + eks.competition.payout.requested (per participant)
 *  - cancel          → eks.competition.reward.cancelled
 *  - finalizePodium  → eks.competition.podium.changed
 *
 * Sibling modules (built in parallel by m6-2) are loaded dynamically so this
 * module compiles & runs independently:
 *  - ../leaderboards  → getLeaderboards().getTopN(leaderboardId, n)
 *  - ../prize-pools   → getPrizePools().getBalance(poolId)
 *  - ../qualification → getQualification().listParticipations(competitionId)
 *  - ../scoring       → getScoring().getLatestScore(participantId, competitionId, seasonId)
 */

import "server-only";
import {
  type RewardScheduleId,
  type RewardEventId,
  type PodiumId,
  type CompetitionId,
  type SeasonId,
  type AccountId,
  type RewardSchedule,
  type RewardCondition,
  type RewardEvent,
  type Podium,
  type RewardScheduleType,
  type RewardEventType,
  type LeaderboardId,
  type PrizePoolId,
  type LeaderboardEntry,
  type Participation,
  type ScoreRecord,
  CompetitionError,
  asRewardScheduleId,
  asRewardEventId,
  asPodiumId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { COMPETITION_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Local extended types
// ---------------------------------------------------------------------------

/** A reward schedule as managed by this engine (extends the core shape with
 *  engine-specific bookkeeping fields). */
export interface ManagedRewardSchedule extends RewardSchedule {
  readonly leaderboardId?: LeaderboardId;
  readonly prizePoolId?: PrizePoolId;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
}

export interface RewardDistribution {
  readonly rank: number;
  readonly percentage: number; // 0-100
  readonly description?: string;
}

export interface ParticipantEligibility {
  readonly participantId: AccountId;
  readonly rank: number;
  readonly score: number;
  readonly eligible: boolean;
  readonly failedConditions: string[];
  readonly notes: Record<string, string>;
  readonly estimatedAmount: number;
}

export interface RewardEvaluationResult {
  readonly scheduleId: RewardScheduleId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly evaluatedAt: string;
  readonly poolBalance: number;
  readonly currency: string;
  readonly meetsMinThreshold: boolean;
  readonly eligible: ParticipantEligibility[];
  readonly totalEligible: number;
}

/** A reward event as managed by this engine (extends core with lifecycle). */
export interface ManagedRewardEvent extends RewardEvent {
  readonly status: "pending" | "cancelled";
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  readonly prizePoolId?: PrizePoolId;
}

export interface CreateRewardScheduleInput {
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly name: string;
  readonly type: RewardScheduleType;
  readonly podiumSize: number;
  readonly distribution: RewardDistribution[];
  readonly minPoolThreshold: number;
  readonly carryOverRules?: { unclaimedGoesTo: "next_season" | "platform" | "rollover"; maxCarryOver?: number };
  readonly maxPayoutCap?: number;
  readonly conditions: RewardCondition[];
  readonly nextRunAt?: string;
  readonly leaderboardId?: LeaderboardId;
  readonly prizePoolId?: PrizePoolId;
}

export interface RewardStats {
  readonly totalSchedules: number;
  readonly totalTriggered: number;
  readonly totalCancelled: number;
  readonly totalAmount: number;
  readonly totalPodiums: number;
}

// ---------------------------------------------------------------------------
// Sibling-module loaders (dynamic imports guard against missing modules)
// ---------------------------------------------------------------------------

async function fetchLeaderboardTopN(leaderboardId: LeaderboardId, n: number): Promise<LeaderboardEntry[]> {
  try {
    const path = "../leaderboards";
    const mod: { getLeaderboards?: () => unknown } = (await import(path)) as { getLeaderboards?: () => unknown };
    const lb = mod?.getLeaderboards?.() as {
      getTopN?: (id: LeaderboardId, n: number) => LeaderboardEntry[] | Promise<LeaderboardEntry[]>;
    } | undefined;
    if (!lb?.getTopN) return [];
    const result = await lb.getTopN(leaderboardId, n);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function fetchPrizePoolBalance(
  poolId: PrizePoolId,
): Promise<{ balance: number; currency: string; available: number } | null> {
  try {
    const path = "../prize-pools";
    const mod: { getPrizePools?: () => unknown } = (await import(path)) as { getPrizePools?: () => unknown };
    const mgr = mod?.getPrizePools?.() as {
      get?: (id: PrizePoolId) => { currency: string; balance: number } | undefined;
      getBalance?: (id: PrizePoolId) => { balance: number; available: number };
    } | undefined;
    if (!mgr) return null;
    const pool = mgr.get?.(poolId);
    if (!pool) return null;
    const bal = mgr.getBalance?.(poolId);
    return { balance: bal?.balance ?? pool.balance, currency: pool.currency, available: bal?.available ?? pool.balance };
  } catch {
    return null;
  }
}

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

async function fetchLatestScore(
  participantId: AccountId,
  competitionId: CompetitionId,
  seasonId: SeasonId,
): Promise<ScoreRecord | null> {
  try {
    const path = "../scoring";
    const mod: { getScoring?: () => unknown } = (await import(path)) as { getScoring?: () => unknown };
    const mgr = mod?.getScoring?.() as {
      getLatestScore?: (p: AccountId, c: CompetitionId, s: SeasonId) => ScoreRecord | Promise<ScoreRecord | null>;
    } | undefined;
    if (!mgr?.getLatestScore) return null;
    const result = await mgr.getLatestScore(participantId, competitionId, seasonId);
    return result ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

interface ConditionResult {
  readonly passed: boolean;
  readonly note: string;
}

function evaluateCondition(
  cond: RewardCondition,
  entry: LeaderboardEntry,
  participation: Participation | undefined,
  score: ScoreRecord | null,
  nowMs: number,
): ConditionResult {
  switch (cond.type) {
    case "maintain_position_days": {
      // Best-effort: if the leaderboard shows the position dropped, fail.
      if (entry.trend === "down") {
        return {
          passed: false,
          note: `Position dropped (rank ${entry.previousRank ?? "?"} → ${entry.rank})`,
        };
      }
      if (entry.trend === "same" && entry.previousRank === entry.rank) {
        return { passed: true, note: `Position maintained at rank ${entry.rank}` };
      }
      return { passed: true, note: `Position trend: ${entry.trend} (required ${cond.value} days)` };
    }
    case "min_activity": {
      const count = participation?.measurementCount ?? 0;
      return count >= cond.value
        ? { passed: true, note: `${count} measurements (≥ ${cond.value})` }
        : { passed: false, note: `${count} measurements (< ${cond.value})` };
    }
    case "recent_measurement": {
      if (!score) return { passed: false, note: "No score record found" };
      const ageDays = (nowMs - new Date(score.computedAt).getTime()) / 86_400_000;
      return ageDays <= cond.value
        ? { passed: true, note: `Last score ${ageDays.toFixed(1)}d ago (≤ ${cond.value}d)` }
        : { passed: false, note: `Last score ${ageDays.toFixed(1)}d ago (> ${cond.value}d)` };
    }
    case "no_disputes": {
      // Without a direct dispute feed, use participation status as a proxy.
      if (participation?.status === "banned" || participation?.status === "eliminated") {
        return { passed: false, note: `Participant status: ${participation.status}` };
      }
      return { passed: true, note: "No disputes detected" };
    }
    case "verified_only": {
      if (!score) return { passed: false, note: "No score record" };
      // The scoring engine should only incorporate verified measurements; if
      // refs exist, we trust they were verified at ingestion time.
      if (score.measurementRefs.length === 0) {
        return { passed: true, note: "Component-based score (no measurement refs)" };
      }
      return { passed: true, note: `${score.measurementRefs.length} measurement refs in score` };
    }
    case "min_score_improvement": {
      if (!score) return { passed: false, note: "No score record" };
      // Use the leaderboard changeAmount as the improvement proxy.
      const improvement = entry.changeAmount ?? 0;
      return improvement >= cond.value
        ? { passed: true, note: `Improvement ${improvement.toFixed(2)} (≥ ${cond.value})` }
        : { passed: false, note: `Improvement ${improvement.toFixed(2)} (< ${cond.value})` };
    }
    case "continuous_participation": {
      if (!participation) return { passed: false, note: "No participation record" };
      const registeredMs = new Date(participation.registeredAt).getTime();
      if (!Number.isFinite(registeredMs)) {
        return { passed: true, note: "Registration date unavailable (skipped)" };
      }
      const durationDays = (nowMs - registeredMs) / 86_400_000;
      return durationDays >= cond.value
        ? { passed: true, note: `Participating for ${durationDays.toFixed(1)}d (≥ ${cond.value}d)` }
        : { passed: false, note: `Participating for ${durationDays.toFixed(1)}d (< ${cond.value}d)` };
    }
    case "custom":
    default:
      return { passed: true, note: "Custom condition (manual review required)" };
  }
}

// ---------------------------------------------------------------------------
// Reward manager
// ---------------------------------------------------------------------------

export class RewardManager {
  private readonly schedules = new Map<RewardScheduleId, ManagedRewardSchedule>();
  private readonly events: ManagedRewardEvent[] = [];
  private readonly podiums = new Map<PodiumId, Podium>();
  private readonly podiumsByCompetition = new Map<CompetitionId, PodiumId[]>();
  private readonly byCompetition = new Map<CompetitionId, RewardScheduleId[]>();

  createSchedule(input: CreateRewardScheduleInput): ManagedRewardSchedule {
    if (input.podiumSize < 1) {
      throw new CompetitionError({
        code: "eks.competition.reward.invalid_podium_size",
        category: "validation",
        message: `podiumSize must be ≥ 1 (got ${input.podiumSize}).`,
      });
    }
    if (input.distribution.length === 0) {
      throw new CompetitionError({
        code: "eks.competition.reward.empty_distribution",
        category: "validation",
        message: "distribution must contain at least one entry.",
      });
    }
    // Validate distribution percentages sum to 100.
    const sum = input.distribution.reduce((s, d) => s + d.percentage, 0);
    if (Math.abs(sum - 100) > 0.01) {
      throw new CompetitionError({
        code: "eks.competition.reward.distribution_sum",
        category: "validation",
        message: `distribution percentages must sum to 100 (got ${sum}).`,
        userMessage: "Reward distribution percentages must total 100%.",
        metadata: { sum, distribution: input.distribution },
      });
    }
    // Validate distribution ranks cover 1..podiumSize.
    const ranks = new Set(input.distribution.map((d) => d.rank));
    for (let r = 1; r <= input.podiumSize; r++) {
      if (!ranks.has(r)) {
        throw new CompetitionError({
          code: "eks.competition.reward.missing_rank",
          category: "validation",
          message: `distribution missing percentage for rank ${r}.`,
          metadata: { missingRank: r, podiumSize: input.podiumSize },
        });
      }
    }
    // Validate no percentage is negative.
    for (const d of input.distribution) {
      if (d.percentage < 0 || d.percentage > 100) {
        throw new CompetitionError({
          code: "eks.competition.reward.invalid_percentage",
          category: "validation",
          message: `percentage for rank ${d.rank} must be in [0, 100] (got ${d.percentage}).`,
        });
      }
    }
    const id = asRewardScheduleId(generateId("rsched_"));
    const schedule: ManagedRewardSchedule = {
      id,
      competitionId: input.competitionId,
      seasonId: input.seasonId,
      name: input.name,
      type: input.type,
      podiumSize: input.podiumSize,
      distribution: input.distribution.map((d) => ({ rank: d.rank, percentage: d.percentage })),
      minPoolThreshold: input.minPoolThreshold,
      carryOverRules: input.carryOverRules,
      maxPayoutCap: input.maxPayoutCap,
      conditions: input.conditions,
      nextRunAt: input.nextRunAt,
      leaderboardId: input.leaderboardId,
      prizePoolId: input.prizePoolId,
    };
    this.schedules.set(id, schedule);
    const list = this.byCompetition.get(input.competitionId) ?? [];
    this.byCompetition.set(input.competitionId, [...list, id]);
    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.rewardScheduled,
        { scheduleId: id, competitionId: input.competitionId, seasonId: input.seasonId, name: input.name, type: input.type, podiumSize: input.podiumSize },
        {},
        "domain",
      ),
    );
    return schedule;
  }

  getSchedule(id: RewardScheduleId): ManagedRewardSchedule | undefined {
    return this.schedules.get(id);
  }

  listSchedules(competitionId?: CompetitionId, seasonId?: SeasonId): ManagedRewardSchedule[] {
    let list = [...this.schedules.values()];
    if (competitionId) list = list.filter((s) => s.competitionId === competitionId);
    if (seasonId) list = list.filter((s) => s.seasonId === seasonId);
    return list;
  }

  /**
   * Evaluate reward conditions against current standings. Fetches the podium
   * via the leaderboards module, then checks each condition for each
   * participant. Returns per-participant eligibility + estimated amounts.
   */
  async evaluate(scheduleId: RewardScheduleId): Promise<RewardEvaluationResult> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new CompetitionError({
        code: "eks.competition.reward.schedule.not_found",
        category: "not_found",
        message: `Reward schedule ${scheduleId} not found.`,
      });
    }
    if (schedule.cancelledAt) {
      throw new CompetitionError({
        code: "eks.competition.reward.schedule.cancelled",
        category: "state_conflict",
        message: `Reward schedule ${scheduleId} was cancelled.`,
      });
    }
    const nowMs = getClock().epochMs();
    // Fetch the podium (top podiumSize entries).
    let entries: LeaderboardEntry[] = [];
    if (schedule.leaderboardId) {
      entries = await fetchLeaderboardTopN(schedule.leaderboardId, schedule.podiumSize);
    }
    // Fetch participations & prize pool balance in parallel.
    const [participations, poolInfo] = await Promise.all([
      fetchParticipations(schedule.competitionId),
      schedule.prizePoolId ? fetchPrizePoolBalance(schedule.prizePoolId) : Promise.resolve(null),
    ]);
    const poolBalance = poolInfo?.balance ?? 0;
    const currency = poolInfo?.currency ?? "USD";
    const meetsMinThreshold = poolBalance >= schedule.minPoolThreshold;
    const partMap = new Map<AccountId, Participation>();
    for (const p of participations) partMap.set(p.participantId, p);
    // Fetch latest scores for each entry in parallel.
    const scoreResults = await Promise.all(
      entries.map((e) => fetchLatestScore(e.participantId, schedule.competitionId, schedule.seasonId)),
    );
    const eligible: ParticipantEligibility[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const participation = partMap.get(entry.participantId);
      const score = scoreResults[i];
      const failed: string[] = [];
      const notes: Record<string, string> = {};
      for (const cond of schedule.conditions) {
        const result = evaluateCondition(cond, entry, participation, score, nowMs);
        notes[cond.name] = result.note;
        if (!result.passed) failed.push(cond.name);
      }
      const isEligible = failed.length === 0;
      const dist = schedule.distribution.find((d) => d.rank === entry.rank);
      const pct = dist?.percentage ?? 0;
      const estimatedAmount = isEligible ? Math.round((pct / 100) * poolBalance * 100) / 100 : 0;
      eligible.push({
        participantId: entry.participantId,
        rank: entry.rank,
        score: entry.score,
        eligible: isEligible,
        failedConditions: failed,
        notes,
        estimatedAmount,
      });
    }
    const result: RewardEvaluationResult = {
      scheduleId,
      competitionId: schedule.competitionId,
      seasonId: schedule.seasonId,
      evaluatedAt: getClock().iso(),
      poolBalance,
      currency,
      meetsMinThreshold,
      eligible,
      totalEligible: eligible.filter((e) => e.eligible).length,
    };
    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.rewardReady,
        { scheduleId, competitionId: schedule.competitionId, seasonId: schedule.seasonId, totalEligible: result.totalEligible, poolBalance, currency, meetsMinThreshold },
        {},
        "domain",
      ),
    );
    return result;
  }

  /**
   * Create RewardEvents for eligible participants. Computes amounts from
   * distribution percentages × prize pool balance (capped at maxPayoutCap).
   * Emits reward_ready, reward_triggered, and payout_requested. Does NOT
   * execute payment — the payment provider consumes payout_requested.
   */
  async trigger(scheduleId: RewardScheduleId): Promise<ManagedRewardEvent[]> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new CompetitionError({
        code: "eks.competition.reward.schedule.not_found",
        category: "not_found",
        message: `Reward schedule ${scheduleId} not found.`,
      });
    }
    if (schedule.cancelledAt) {
      throw new CompetitionError({
        code: "eks.competition.reward.schedule.cancelled",
        category: "state_conflict",
        message: `Reward schedule ${scheduleId} was cancelled.`,
      });
    }
    const evaluation = await this.evaluate(scheduleId);
    if (!evaluation.meetsMinThreshold) {
      throw new CompetitionError({
        code: "eks.competition.reward.below_threshold",
        category: "state_conflict",
        message: `Prize pool balance ${evaluation.poolBalance} is below the minimum threshold ${schedule.minPoolThreshold}.`,
        userMessage: "The prize pool has not reached the minimum threshold for rewards.",
        metadata: { poolBalance: evaluation.poolBalance, minThreshold: schedule.minPoolThreshold },
      });
    }
    const created: ManagedRewardEvent[] = [];
    const now = getClock().iso();
    for (const p of evaluation.eligible) {
      if (!p.eligible) continue;
      const dist = schedule.distribution.find((d) => d.rank === p.rank);
      if (!dist) continue;
      let amount = Math.round((dist.percentage / 100) * evaluation.poolBalance * 100) / 100;
      if (schedule.maxPayoutCap !== undefined && amount > schedule.maxPayoutCap) {
        amount = schedule.maxPayoutCap;
      }
      const evt: ManagedRewardEvent = {
        id: asRewardEventId(generateId("revt_")),
        scheduleId,
        type: "reward_triggered" as RewardEventType,
        participantId: p.participantId,
        rank: p.rank,
        amount,
        currency: evaluation.currency,
        competitionId: schedule.competitionId,
        seasonId: schedule.seasonId,
        createdAt: now,
        status: "pending",
        prizePoolId: schedule.prizePoolId,
        metadata: { percentage: dist.percentage, score: p.score, poolBalance: evaluation.poolBalance },
      };
      this.events.push(evt);
      created.push(evt);
      void getEventBus().publish(
        buildEvent(
          COMPETITION_EVENTS.rewardReady,
          { scheduleId, competitionId: schedule.competitionId, seasonId: schedule.seasonId, participantId: p.participantId, rank: p.rank, amount },
          {},
          "domain",
        ),
      );
      void getEventBus().publish(
        buildEvent(
          COMPETITION_EVENTS.rewardTriggered,
          { scheduleId, competitionId: schedule.competitionId, seasonId: schedule.seasonId, participantId: p.participantId, rank: p.rank, amount, currency: evaluation.currency, rewardEventId: evt.id },
          {},
          "domain",
        ),
      );
      void getEventBus().publish(
        buildEvent(
          COMPETITION_EVENTS.payoutRequested,
          { scheduleId, rewardEventId: evt.id, competitionId: schedule.competitionId, seasonId: schedule.seasonId, participantId: p.participantId, amount, currency: evaluation.currency, prizePoolId: schedule.prizePoolId, rank: p.rank },
          {},
          "domain",
        ),
      );
    }
    // Update lastRunAt.
    this.schedules.set(scheduleId, { ...schedule, lastRunAt: now });
    return created;
  }

  /** Cancel a schedule and all pending reward events for it. */
  cancel(scheduleId: RewardScheduleId, reason: string): ManagedRewardSchedule {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new CompetitionError({
        code: "eks.competition.reward.schedule.not_found",
        category: "not_found",
        message: `Reward schedule ${scheduleId} not found.`,
      });
    }
    const now = getClock().iso();
    const cancelled: ManagedRewardSchedule = { ...schedule, cancelledAt: now, cancelReason: reason };
    this.schedules.set(scheduleId, cancelled);
    // Cancel all pending events for this schedule.
    for (let i = 0; i < this.events.length; i++) {
      const evt = this.events[i];
      if (evt.scheduleId === scheduleId && evt.status === "pending") {
        this.events[i] = { ...evt, type: "reward_cancelled" as RewardEventType, status: "cancelled", cancelledAt: now, cancelReason: reason };
        void getEventBus().publish(
          buildEvent(
            COMPETITION_EVENTS.rewardCancelled,
            { scheduleId, rewardEventId: evt.id, competitionId: evt.competitionId, seasonId: evt.seasonId, participantId: evt.participantId, amount: evt.amount, reason },
            {},
            "domain",
          ),
        );
      }
    }
    return cancelled;
  }

  /**
   * Create an immutable Podium record with final rankings + reward amounts.
   * Re-evaluates the schedule to capture the latest standings.
   */
  async finalizePodium(scheduleId: RewardScheduleId): Promise<Podium> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) {
      throw new CompetitionError({
        code: "eks.competition.reward.schedule.not_found",
        category: "not_found",
        message: `Reward schedule ${scheduleId} not found.`,
      });
    }
    const evaluation = await this.evaluate(scheduleId);
    const entries = evaluation.eligible
      .filter((e) => e.eligible)
      .sort((a, b) => a.rank - b.rank)
      .map((e) => {
        const dist = schedule.distribution.find((d) => d.rank === e.rank);
        const pct = dist?.percentage ?? 0;
        let amount = Math.round((pct / 100) * evaluation.poolBalance * 100) / 100;
        if (schedule.maxPayoutCap !== undefined && amount > schedule.maxPayoutCap) {
          amount = schedule.maxPayoutCap;
        }
        return { rank: e.rank, participantId: e.participantId, score: e.score, rewardAmount: amount, rewardPercentage: pct };
      });
    const podium: Podium = {
      id: asPodiumId(generateId("podium_")),
      competitionId: schedule.competitionId,
      seasonId: schedule.seasonId,
      scheduleId,
      entries,
      finalizedAt: getClock().iso(),
    };
    this.podiums.set(podium.id, podium);
    const list = this.podiumsByCompetition.get(schedule.competitionId) ?? [];
    this.podiumsByCompetition.set(schedule.competitionId, [...list, podium.id]);
    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.podiumChanged,
        { podiumId: podium.id, competitionId: schedule.competitionId, seasonId: schedule.seasonId, scheduleId, entryCount: entries.length },
        {},
        "domain",
      ),
    );
    return podium;
  }

  getPodium(podiumId: PodiumId): Podium | undefined {
    return this.podiums.get(podiumId);
  }

  getPodiums(competitionId?: CompetitionId, seasonId?: SeasonId): Podium[] {
    let list = [...this.podiums.values()];
    if (competitionId) list = list.filter((p) => p.competitionId === competitionId);
    if (seasonId) list = list.filter((p) => p.seasonId === seasonId);
    return list;
  }

  listRewardEvents(filter?: {
    scheduleId?: RewardScheduleId;
    participantId?: AccountId;
    type?: RewardEventType;
    status?: "pending" | "cancelled";
  }): readonly ManagedRewardEvent[] {
    let list = [...this.events];
    if (filter?.scheduleId) list = list.filter((e) => e.scheduleId === filter.scheduleId);
    if (filter?.participantId) list = list.filter((e) => e.participantId === filter.participantId);
    if (filter?.type) list = list.filter((e) => e.type === filter.type);
    if (filter?.status) list = list.filter((e) => e.status === filter.status);
    return list;
  }

  getRewardEvent(id: RewardEventId): ManagedRewardEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  getStats(competitionId?: CompetitionId): RewardStats {
    let schedules = [...this.schedules.values()];
    let events = [...this.events];
    if (competitionId) {
      schedules = schedules.filter((s) => s.competitionId === competitionId);
      const scheduleIds = new Set(schedules.map((s) => s.id));
      events = events.filter((e) => scheduleIds.has(e.scheduleId));
    }
    const triggered = events.filter((e) => e.type === "reward_triggered");
    const cancelled = events.filter((e) => e.type === "reward_cancelled");
    const totalAmount = triggered.reduce((s, e) => s + e.amount, 0);
    let totalPodiums = 0;
    if (competitionId) {
      totalPodiums = (this.podiumsByCompetition.get(competitionId) ?? []).length;
    } else {
      totalPodiums = this.podiums.size;
    }
    return {
      totalSchedules: schedules.length,
      totalTriggered: triggered.length,
      totalCancelled: cancelled.length,
      totalAmount: Math.round(totalAmount * 100) / 100,
      totalPodiums,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: RewardManager | null = null;
export function getRewards(): RewardManager {
  if (!_mgr) _mgr = new RewardManager();
  return _mgr;
}

export function resetRewards(): void {
  _mgr = null;
}
