/**
 * Eks-Health Achievement Engine — Core Primitives
 *
 * Foundational types for the achievement engine: achievements, badges, XP,
 * levels, collections, and milestones. The engine is a generic gamification
 * layer that sits on top of missions (habits/streaks/goals), competitions
 * (scores/rewards), health (measurements), programs (installs), and
 * technicians (sessions). It owns NO healthcare concepts — it only knows how
 * to track progress toward thresholds and reward participants.
 *
 * Built on the kernel (branded ids, events, clock), identity (accounts), and
 * programs (programId). Habit streaks and goal milestones continue to live in
 * the mission engine; this engine references them via AchievementTrigger but
 * never duplicates them.
 */

import "server-only";
import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
} from "@/kernel";
import type { AccountId } from "@/identity";
import type { ProgramId } from "@/programs";

// ---------------------------------------------------------------------------
// Branded achievement identifiers
// ---------------------------------------------------------------------------

export type AchievementId = Brand<string, "AchievementId">;
export type BadgeId = Brand<string, "BadgeId">;
export type LevelId = Brand<string, "LevelId">;
export type CollectionId = Brand<string, "CollectionId">;
export type XpEventId = Brand<string, "XpEventId">;

export function asAchievementId(s: string): AchievementId { return s as AchievementId; }
export function asBadgeId(s: string): BadgeId { return s as BadgeId; }
export function asLevelId(s: string): LevelId { return s as LevelId; }
export function asCollectionId(s: string): CollectionId { return s as CollectionId; }
export function asXpEventId(s: string): XpEventId { return s as XpEventId; }

// ---------------------------------------------------------------------------
// Achievement classification
// ---------------------------------------------------------------------------

export type AchievementType =
  | "badge"
  | "xp"
  | "level"
  | "collection"
  | "milestone";

export type AchievementRarity =
  | "common"
  | "rare"
  | "epic"
  | "legendary"
  | "mythic";

export type AchievementTriggerType =
  | "mission_completed"
  | "streak_reached"
  | "goal_achieved"
  | "measurement_recorded"
  | "competition_won"
  | "program_installed"
  | "level_reached"
  | "custom";

// ---------------------------------------------------------------------------
// Achievement trigger — what causes progress toward this achievement
// ---------------------------------------------------------------------------

export interface AchievementTrigger {
  readonly type: AchievementTriggerType;
  /** Human-readable condition expression, e.g. "habit.streak >= 7". */
  readonly condition: string;
  /** Numeric threshold the participant's progress must reach to complete. */
  readonly threshold: number;
}

// ---------------------------------------------------------------------------
// Achievement progress — per-participant tracking
// ---------------------------------------------------------------------------

export interface AchievementProgress {
  readonly participantId: AccountId;
  readonly achievementId: AchievementId;
  readonly current: number;
  readonly target: number;
  readonly completed: boolean;
  readonly completedAt?: string;
  readonly claimed: boolean;
  readonly claimedAt?: string;
}

// ---------------------------------------------------------------------------
// Achievement definition
// ---------------------------------------------------------------------------

export interface Achievement {
  readonly id: AchievementId;
  readonly programId?: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly type: AchievementType;
  readonly icon: string;
  readonly rarity: AchievementRarity;
  readonly xpReward: number;
  readonly trigger: AchievementTrigger;
  readonly progress: AchievementProgress;
  readonly hidden: boolean;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Badge — a visible token awarded when an achievement is completed
// ---------------------------------------------------------------------------

export interface Badge {
  readonly id: BadgeId;
  readonly achievementId: AchievementId;
  readonly participantId: AccountId;
  readonly earnedAt: string;
  readonly displayed: boolean;
}

// ---------------------------------------------------------------------------
// Level — XP-based progression tier
// ---------------------------------------------------------------------------

export interface Level {
  readonly id: LevelId;
  readonly participantId: AccountId;
  readonly level: number;
  readonly xp: number;
  /** XP needed to advance from current level to the next. */
  readonly xpToNext: number;
  readonly title: string;
  readonly unlockedAt: string;
}

// ---------------------------------------------------------------------------
// Collection — a set of related achievements with a bonus reward
// ---------------------------------------------------------------------------

export interface Collection {
  readonly id: CollectionId;
  readonly name: string;
  readonly description: string;
  readonly achievementIds: AchievementId[];
  readonly reward: number;
  readonly completed: boolean;
}

// ---------------------------------------------------------------------------
// XP event — an immutable ledger entry for every XP grant
// ---------------------------------------------------------------------------

export type XpSource =
  | "mission"
  | "competition"
  | "achievement"
  | "measurement"
  | "streak"
  | "social";

export interface XpEvent {
  readonly id: XpEventId;
  readonly participantId: AccountId;
  readonly amount: number;
  readonly reason: string;
  readonly source: XpSource;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type AchievementErrorCategory =
  | "not_found"
  | "state_conflict"
  | "validation"
  | "already_earned"
  | "not_completed"
  | "duplicate"
  | "quota_exceeded";

export class AchievementError extends Error {
  readonly code: string;
  readonly category: AchievementErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: AchievementErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "AchievementError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "An achievement engine error occurred.";
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
// Achievement event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const ACHIEVEMENT_EVENTS = {
  achievementDefined: "eks.achievement.defined",
  achievementProgressUpdated: "eks.achievement.progress.updated",
  achievementCompleted: "eks.achievement.completed",
  badgeAwarded: "eks.achievement.badge.awarded",
  badgeClaimed: "eks.achievement.badge.claimed",
  badgeDisplayed: "eks.achievement.badge.displayed",
  badgeHidden: "eks.achievement.badge.hidden",
  xpAwarded: "eks.achievement.xp.awarded",
  levelUp: "eks.achievement.level.up",
  collectionCreated: "eks.achievement.collection.created",
  collectionCompleted: "eks.achievement.collection.completed",
  collectionRewardAwarded: "eks.achievement.collection.reward_awarded",
} as const;

export type AchievementEventType =
  (typeof ACHIEVEMENT_EVENTS)[keyof typeof ACHIEVEMENT_EVENTS];

// ---------------------------------------------------------------------------
// Re-export the externally-relevant branded/identity types for convenience
// ---------------------------------------------------------------------------

export { type TenantId, type AccountId, type ProgramId };
