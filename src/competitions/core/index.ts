/**
 * Eks-Health Competition Platform — Core Primitives
 *
 * Foundational types for competitions, seasons, leagues, divisions, scores,
 * metrics, leaderboards, reward schedules, prize pools, rankings, eligibility,
 * and qualification.
 *
 * The platform understands ONLY generic concepts. It does NOT know what
 * "weight loss", "blood pressure", or "cholesterol" mean. Programs define
 * the metrics, scoring formulas, eligibility rules, competitions, reward
 * structures, and success conditions. The platform executes those rules
 * securely and transparently.
 *
 * Built on the kernel (events, ids, errors), identity (accounts, orgs),
 * programs (capabilities, manifests), health (measurements, verification),
 * and technicians (sessions, verification).
 */

import "server-only";
import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
} from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";
import type { MeasurementId, SchemaId } from "@/health";

// ---------------------------------------------------------------------------
// Branded competition identifiers
// ---------------------------------------------------------------------------

export type CompetitionId = Brand<string, "CompetitionId">;
export type SeasonId = Brand<string, "SeasonId">;
export type DivisionId = Brand<string, "DivisionId">;
export type LeagueId = Brand<string, "LeagueId">;
export type ScoreId = Brand<string, "ScoreId">;
export type ScoreSpecId = Brand<string, "ScoreSpecId">;
export type LeaderboardId = Brand<string, "LeaderboardId">;
export type LeaderboardEntryId = Brand<string, "LeaderboardEntryId">;
export type QualificationId = Brand<string, "QualificationId">;
export type RewardScheduleId = Brand<string, "RewardScheduleId">;
export type RewardEventId = Brand<string, "RewardEventId">;
export type PrizePoolId = Brand<string, "PrizePoolId">;
export type PrizeAllocationId = Brand<string, "PrizeAllocationId">;
export type PodiumId = Brand<string, "PodiumId">;
export type ParticipationId = Brand<string, "ParticipationId">;
export type AntiCheatFlagId = Brand<string, "AntiCheatFlagId">;
export type ScoreComponentId = Brand<string, "ScoreComponentId">;

export function asCompetitionId(s: string): CompetitionId { return s as CompetitionId; }
export function asSeasonId(s: string): SeasonId { return s as SeasonId; }
export function asDivisionId(s: string): DivisionId { return s as DivisionId; }
export function asLeagueId(s: string): LeagueId { return s as LeagueId; }
export function asScoreId(s: string): ScoreId { return s as ScoreId; }
export function asScoreSpecId(s: string): ScoreSpecId { return s as ScoreSpecId; }
export function asLeaderboardId(s: string): LeaderboardId { return s as LeaderboardId; }
export function asQualificationId(s: string): QualificationId { return s as QualificationId; }
export function asRewardScheduleId(s: string): RewardScheduleId { return s as RewardScheduleId; }
export function asRewardEventId(s: string): RewardEventId { return s as RewardEventId; }
export function asPrizePoolId(s: string): PrizePoolId { return s as PrizePoolId; }
export function asPrizeAllocationId(s: string): PrizeAllocationId { return s as PrizeAllocationId; }
export function asPodiumId(s: string): PodiumId { return s as PodiumId; }
export function asParticipationId(s: string): ParticipationId { return s as ParticipationId; }
export function asAntiCheatFlagId(s: string): AntiCheatFlagId { return s as AntiCheatFlagId; }

// ---------------------------------------------------------------------------
// Competition lifecycle
// ---------------------------------------------------------------------------

export type CompetitionState =
  | "draft"
  | "scheduled"
  | "registration"
  | "qualification"
  | "active"
  | "paused"
  | "completed"
  | "archived"
  | "cancelled";

export type CompetitionScope =
  | "global"
  | "national"
  | "regional"
  | "organization"
  | "university"
  | "family"
  | "age_group"
  | "gender"
  | "risk_group"
  | "custom";

// ---------------------------------------------------------------------------
// Season types
// ---------------------------------------------------------------------------

export type SeasonType =
  | "weekly"
  | "monthly"
  | "quarterly"
  | "annual"
  | "rolling"
  | "continuous"
  | "custom";

export type SeasonState = "upcoming" | "active" | "archived" | "cancelled";

// ---------------------------------------------------------------------------
// Division / League
// ---------------------------------------------------------------------------

export type TierName = "bronze" | "silver" | "gold" | "platinum" | "diamond" | "champion" | "custom";

export interface DivisionDefinition {
  readonly id: DivisionId;
  readonly name: string;
  readonly tier: TierName;
  readonly minScore?: number;
  readonly maxScore?: number;
  readonly maxParticipants?: number;
  readonly color?: string;
  readonly iconUrl?: string;
}

export interface PromotionRule {
  readonly promoteTopN: number; // top N promoted each cycle
  readonly relegateBottomN: number;
  readonly cycleType: SeasonType;
  readonly minParticipantsForPromotion: number;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ScoreComponentType =
  | "metric_improvement" // improvement of a health metric
  | "metric_absolute" // absolute value of a metric
  | "mission_completion" // missions completed (future)
  | "consistency" // measurement consistency
  | "participation" // community participation
  | "custom"; // program-defined

export interface ScoreComponent {
  readonly id: ScoreComponentId;
  readonly name: string;
  readonly type: ScoreComponentType;
  readonly weight: number; // percentage, e.g. 40 for 40%
  readonly measurementSchemaId?: SchemaId; // which health schema this tracks
  readonly aggregation: ScoreAggregation;
  readonly timeWindowDays: number;
  readonly decayFunction?: "linear" | "exponential" | "none";
  readonly decayHalfLifeDays?: number;
  readonly baselineMode: "first" | "average" | "previous_season" | "custom";
  readonly formula?: string; // custom formula expression
  readonly bonusConditions?: ScoreBonusCondition[];
  readonly penaltyConditions?: ScorePenaltyCondition[];
  readonly description: string;
}

export type ScoreAggregation =
  | "latest" // most recent value
  | "average" // average over window
  | "max" // best value in window
  | "min" // worst value
  | "improvement" // delta from baseline
  | "improvement_percent" // percent change
  | "count" // number of measurements
  | "sum" // sum of values
  | "custom";

export interface ScoreBonusCondition {
  readonly name: string;
  readonly condition: string; // expression
  readonly bonusPoints: number;
  readonly maxBonus?: number;
}

export interface ScorePenaltyCondition {
  readonly name: string;
  readonly condition: string;
  readonly penaltyPoints: number;
  readonly maxPenalty?: number;
}

export interface ScoreSpec {
  readonly id: ScoreSpecId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly components: ScoreComponent[];
  readonly totalWeight: number; // should sum to 100
  readonly scoreCap?: number;
  readonly scoreFloor?: number;
  readonly roundingPrecision: number;
  readonly createdAt: string;
  readonly deprecatedAt?: string;
}

// ---------------------------------------------------------------------------
// Score record (computed score for a participant)
// ---------------------------------------------------------------------------

export interface ScoreRecord {
  readonly id: ScoreId;
  readonly participantId: AccountId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly specId: ScoreSpecId;
  readonly totalScore: number;
  readonly components: ScoreComponentResult[];
  readonly computedAt: string;
  readonly version: number;
  readonly measurementRefs: MeasurementId[];
  readonly explanation: string; // human-readable breakdown
}

export interface ScoreComponentResult {
  readonly componentId: ScoreComponentId;
  readonly name: string;
  readonly rawValue: number;
  readonly componentScore: number;
  readonly weight: number;
  readonly weightedScore: number;
  readonly detail: string;
  readonly bonuses: { name: string; points: number }[];
  readonly penalties: { name: string; points: number }[];
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export type LeaderboardScope =
  | "global"
  | "country"
  | "state"
  | "city"
  | "district"
  | "organization"
  | "company"
  | "school"
  | "gender"
  | "age"
  | "bmi_category"
  | "risk_profile"
  | "occupation"
  | "custom";

export type RankingMethod =
  | "highest_score"
  | "most_improved"
  | "fastest_improvement"
  | "consistency"
  | "weighted_ranking"
  | "percentile"
  | "elo_rating"
  | "tier_ranking"
  | "hybrid";

export interface LeaderboardDefinition {
  readonly id: LeaderboardId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly name: string;
  readonly scope: LeaderboardScope;
  readonly scopeFilter?: Record<string, unknown>; // e.g. { country: "GH" }
  readonly rankingMethod: RankingMethod;
  readonly divisionId?: DivisionId;
  readonly updatedAt: string;
}

export interface LeaderboardEntry {
  readonly id: LeaderboardEntryId;
  readonly leaderboardId: LeaderboardId;
  readonly participantId: AccountId;
  readonly rank: number;
  readonly previousRank?: number;
  readonly score: number;
  readonly trend: "up" | "down" | "same" | "new";
  readonly changeAmount?: number;
  readonly updatedAt: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------

export type QualificationStatus = "pending" | "qualified" | "not_qualified" | "expired";

export interface QualificationRequirement {
  readonly type: "min_measurements" | "min_activity" | "verified_visits" | "program_completion" | "min_duration" | "min_score" | "custom";
  readonly value: number;
  readonly description: string;
  readonly timeWindowDays?: number;
}

// ---------------------------------------------------------------------------
// Rewards / Prize pools
// ---------------------------------------------------------------------------

export type RewardScheduleType =
  | "weekly"
  | "monthly"
  | "quarterly"
  | "season_end"
  | "milestone"
  | "hybrid"
  | "conditional";

export type RewardEventType =
  | "reward_ready"
  | "prize_pool_updated"
  | "measurement_fee_received"
  | "reward_cancelled"
  | "reward_triggered"
  | "payout_requested";

export type PrizePoolFundingSource =
  | "measurement_ticket_allocation"
  | "program_treasury"
  | "sponsors"
  | "employers"
  | "governments"
  | "insurance_providers"
  | "developer_contributions"
  | "donations"
  | "platform_incentives"
  | "custom";

export interface PrizePoolEntry {
  readonly id: PrizePoolId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly currency: string;
  readonly balance: number;
  readonly allocated: number;
  readonly pending: number;
  readonly fundingSources: { source: PrizePoolFundingSource; amount: number; reference?: string; at: string }[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RewardSchedule {
  readonly id: RewardScheduleId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly name: string;
  readonly type: RewardScheduleType;
  readonly podiumSize: number;
  readonly distribution: { rank: number; percentage: number }[]; // e.g. [{rank:1, percentage:20}, ...]
  readonly minPoolThreshold: number;
  readonly carryOverRules?: { unclaimedGoesTo: "next_season" | "platform" | "rollover"; maxCarryOver?: number };
  readonly maxPayoutCap?: number;
  readonly conditions: RewardCondition[];
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
}

export interface RewardCondition {
  readonly name: string;
  readonly type: "maintain_position_days" | "min_activity" | "recent_measurement" | "no_disputes" | "verified_only" | "min_score_improvement" | "continuous_participation" | "custom";
  readonly value: number;
  readonly description: string;
}

export interface RewardEvent {
  readonly id: RewardEventId;
  readonly scheduleId: RewardScheduleId;
  readonly type: RewardEventType;
  readonly participantId: AccountId;
  readonly rank: number;
  readonly amount: number;
  readonly currency: string;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Podium {
  readonly id: PodiumId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly scheduleId: RewardScheduleId;
  readonly entries: { rank: number; participantId: AccountId; score: number; rewardAmount: number; rewardPercentage: number }[];
  readonly finalizedAt: string;
}

// ---------------------------------------------------------------------------
// Anti-cheating
// ---------------------------------------------------------------------------

export type AntiCheatFlagType =
  | "score_validation"
  | "measurement_validation"
  | "duplicate_detection"
  | "rapid_improvement"
  | "collusion_suspected"
  | "abnormal_ranking_change"
  | "manual_review"
  | "statistical_outlier";

export type AntiCheatFlagSeverity = "low" | "medium" | "high" | "critical";
export type AntiCheatFlagStatus = "open" | "investigating" | "confirmed" | "false_positive" | "resolved";

// ---------------------------------------------------------------------------
// Participation
// ---------------------------------------------------------------------------

export type ParticipationStatus = "registered" | "qualified" | "active" | "eliminated" | "withdrawn" | "banned";

export interface Participation {
  readonly id: ParticipationId;
  readonly competitionId: CompetitionId;
  readonly seasonId: SeasonId;
  readonly participantId: AccountId;
  readonly divisionId?: DivisionId;
  readonly status: ParticipationStatus;
  readonly registeredAt: string;
  readonly qualifiedAt?: string;
  readonly currentScore?: number;
  readonly bestScore?: number;
  readonly currentRank?: number;
  readonly bestRank?: number;
  readonly measurementCount: number;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CompetitionErrorCategory =
  | "not_found"
  | "state_conflict"
  | "not_eligible"
  | "not_qualified"
  | "score_invalid"
  | "leaderboard_invalid"
  | "reward_invalid"
  | "anti_cheat_violation"
  | "validation"
  | "version_conflict"
  | "quota_exceeded";

export class CompetitionError extends Error {
  readonly code: string;
  readonly category: CompetitionErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: CompetitionErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "CompetitionError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A competition platform error occurred.";
    this.timestamp = new Date().toISOString();
    this.correlationId = opts.correlationId;
    this.traceId = opts.traceId;
    this.metadata = opts.metadata ?? {};
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      message: this.message,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      traceId: this.traceId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Competition event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const COMPETITION_EVENTS = {
  competitionCreated: "eks.competition.created",
  competitionStarted: "eks.competition.started",
  competitionPaused: "eks.competition.paused",
  competitionCompleted: "eks.competition.completed",
  competitionCancelled: "eks.competition.cancelled",
  participantJoined: "eks.competition.participant.joined",
  participantWithdrawn: "eks.competition.participant.withdrawn",
  qualificationAchieved: "eks.competition.qualification.achieved",
  scoreUpdated: "eks.competition.score.updated",
  scoreRecalculated: "eks.competition.score.recalculated",
  leaderboardUpdated: "eks.competition.leaderboard.updated",
  podiumChanged: "eks.competition.podium.changed",
  seasonStarted: "eks.competition.season.started",
  seasonClosed: "eks.competition.season.closed",
  divisionPromoted: "eks.competition.division.promoted",
  divisionRelegated: "eks.competition.division.relegated",
  rewardScheduled: "eks.competition.reward.scheduled",
  rewardReady: "eks.competition.reward.ready",
  rewardCancelled: "eks.competition.reward.cancelled",
  rewardTriggered: "eks.competition.reward.triggered",
  prizePoolUpdated: "eks.competition.prize_pool.updated",
  measurementFeeReceived: "eks.competition.prize_pool.fee_received",
  antiCheatFlagCreated: "eks.competition.anticheat.flag",
  payoutRequested: "eks.competition.payout.requested",
} as const;

export type CompetitionEventType = (typeof COMPETITION_EVENTS)[keyof typeof COMPETITION_EVENTS];

export { type TenantId, type AccountId, type OrgId, type ProgramId, type MeasurementId, type SchemaId };
