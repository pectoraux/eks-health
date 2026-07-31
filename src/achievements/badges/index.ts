/**
 * Eks-Health Achievement Engine — Badges
 *
 * Badge definitions + per-participant progress + awarded badge records.
 * Pre-registers ten canonical achievements that span the platform
 * (measurements, streaks, competitions, program installs, technician
 * visits). Additional achievements can be defined by programs at runtime.
 */

import "server-only";
import {
  type AchievementId,
  type BadgeId,
  type AccountId,
  type Achievement,
  type AchievementProgress,
  type Badge,
  type AchievementType,
  type AchievementRarity,
  type AchievementTrigger,
  AchievementError,
  asAchievementId,
  asBadgeId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { ACHIEVEMENT_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface DefineAchievementInput {
  readonly programId?: Achievement["programId"];
  readonly name: string;
  readonly description: string;
  readonly type: AchievementType;
  readonly icon: string;
  readonly rarity: AchievementRarity;
  readonly xpReward: number;
  readonly trigger: AchievementTrigger;
  readonly hidden?: boolean;
  /** Stable slug used for de-duplication and lookups by name. */
  readonly slug: string;
}

export interface RecordProgressInput {
  readonly participantId: AccountId;
  readonly achievementId: AchievementId;
  readonly current: number;
  /** Optional override; otherwise taken from the achievement definition. */
  readonly target?: number;
}

// ---------------------------------------------------------------------------
// Badge manager
// ---------------------------------------------------------------------------

export class BadgeManager {
  private readonly definitions = new Map<AchievementId, Achievement>();
  private readonly bySlug = new Map<string, AchievementId>();
  private readonly progress = new Map<string, AchievementProgress>();
  private readonly badges = new Map<BadgeId, Badge>();
  private readonly byParticipant = new Map<AccountId, BadgeId[]>();
  private readonly defaultsRegistered = false;

  constructor() {
    this.registerDefaults();
  }

  // -------------------------------------------------------------------------
  // Definitions
  // -------------------------------------------------------------------------

  define(input: DefineAchievementInput): Achievement {
    if (this.bySlug.has(input.slug)) {
      throw new AchievementError({
        code: "eks.achievement.duplicate_slug",
        category: "duplicate",
        message: `Achievement slug '${input.slug}' is already registered.`,
        userMessage: "This achievement already exists.",
        metadata: { slug: input.slug },
      });
    }
    const id = asAchievementId(generateId("ach_"));
    const now = getClock().iso();
    const achievement: Achievement = {
      id,
      programId: input.programId,
      name: input.name,
      description: input.description,
      type: input.type,
      icon: input.icon,
      rarity: input.rarity,
      xpReward: input.xpReward,
      trigger: input.trigger,
      hidden: input.hidden ?? false,
      createdAt: now,
      progress: {
        participantId: "" as AccountId,
        achievementId: id,
        current: 0,
        target: input.trigger.threshold,
        completed: false,
        claimed: false,
      },
    };
    this.definitions.set(id, achievement);
    this.bySlug.set(input.slug, id);
    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.achievementDefined,
        { achievementId: id, slug: input.slug, name: input.name, rarity: input.rarity },
        {},
        "domain",
      ),
    );
    return achievement;
  }

  getAchievement(id: AchievementId): Achievement | undefined {
    return this.definitions.get(id);
  }

  getAchievementBySlug(slug: string): Achievement | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.definitions.get(id) : undefined;
  }

  listAchievements(filter?: {
    type?: AchievementType;
    rarity?: AchievementRarity;
    includeHidden?: boolean;
  }): Achievement[] {
    let list = [...this.definitions.values()];
    if (!filter?.includeHidden) list = list.filter((a) => !a.hidden);
    if (filter?.type) list = list.filter((a) => a.type === filter.type);
    if (filter?.rarity) list = list.filter((a) => a.rarity === filter.rarity);
    return list;
  }

  // -------------------------------------------------------------------------
  // Progress tracking
  // -------------------------------------------------------------------------

  /** Update a participant's progress toward an achievement. Auto-completes. */
  recordProgress(input: RecordProgressInput): AchievementProgress {
    const ach = this.definitions.get(input.achievementId);
    if (!ach) {
      throw new AchievementError({
        code: "eks.achievement.not_found",
        category: "not_found",
        message: `Achievement ${input.achievementId} not found.`,
      });
    }
    const target = input.target ?? ach.trigger.threshold;
    const key = progressKey(input.participantId, input.achievementId);
    const prev = this.progress.get(key);
    const now = getClock().iso();
    const wasCompleted = prev?.completed ?? false;
    const isCompleted = input.current >= target;
    const updated: AchievementProgress = {
      participantId: input.participantId,
      achievementId: input.achievementId,
      current: input.current,
      target,
      completed: isCompleted,
      completedAt: isCompleted ? (prev?.completedAt ?? now) : undefined,
      claimed: prev?.claimed ?? false,
      claimedAt: prev?.claimedAt,
    };
    this.progress.set(key, updated);

    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.achievementProgressUpdated,
        {
          participantId: input.participantId,
          achievementId: input.achievementId,
          current: input.current,
          target,
          completed: isCompleted,
        },
        {},
        "domain",
      ),
    );

    // Auto-award a badge on first completion (idempotent).
    if (isCompleted && !wasCompleted) {
      this.awardBadge(input.participantId, input.achievementId);
      void getEventBus().publish(
        buildEvent(
          ACHIEVEMENT_EVENTS.achievementCompleted,
          {
            participantId: input.participantId,
            achievementId: input.achievementId,
            rarity: ach.rarity,
            xpReward: ach.xpReward,
          },
          {},
          "domain",
        ),
      );
    }
    return updated;
  }

  getProgress(participantId: AccountId, achievementId: AchievementId): AchievementProgress | undefined {
    return this.progress.get(progressKey(participantId, achievementId));
  }

  listProgress(participantId: AccountId): AchievementProgress[] {
    const out: AchievementProgress[] = [];
    for (const p of this.progress.values()) {
      if (p.participantId === participantId) out.push(p);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Badges
  // -------------------------------------------------------------------------

  /** Award a badge. Idempotent — re-awarding returns the existing badge. */
  awardBadge(participantId: AccountId, achievementId: AchievementId): Badge {
    const ach = this.definitions.get(achievementId);
    if (!ach) {
      throw new AchievementError({
        code: "eks.achievement.not_found",
        category: "not_found",
        message: `Achievement ${achievementId} not found.`,
      });
    }
    const existing = this.findBadge(participantId, achievementId);
    if (existing) return existing;

    const id = asBadgeId(generateId("bdg_"));
    const now = getClock().iso();
    const badge: Badge = {
      id,
      achievementId,
      participantId,
      earnedAt: now,
      displayed: !ach.hidden,
    };
    this.badges.set(id, badge);
    const list = this.byParticipant.get(participantId) ?? [];
    this.byParticipant.set(participantId, [...list, id]);

    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.badgeAwarded,
        {
          badgeId: id,
          participantId,
          achievementId,
          rarity: ach.rarity,
          xpReward: ach.xpReward,
        },
        {},
        "domain",
      ),
    );
    return badge;
  }

  /** Mark a completed achievement's badge as claimed (for rewards). */
  claimBadge(participantId: AccountId, achievementId: AchievementId): AchievementProgress {
    const key = progressKey(participantId, achievementId);
    const p = this.progress.get(key);
    if (!p) {
      throw new AchievementError({
        code: "eks.achievement.progress.not_found",
        category: "not_found",
        message: "No progress record found for this participant/achievement.",
      });
    }
    if (!p.completed) {
      throw new AchievementError({
        code: "eks.achievement.not_completed",
        category: "not_completed",
        message: "Cannot claim an achievement that has not been completed.",
        userMessage: "This achievement is not yet complete.",
      });
    }
    if (p.claimed) return p;
    const now = getClock().iso();
    const updated: AchievementProgress = { ...p, claimed: true, claimedAt: now };
    this.progress.set(key, updated);
    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.badgeClaimed,
        { participantId, achievementId, claimedAt: now },
        {},
        "domain",
      ),
    );
    return updated;
  }

  hasBadge(participantId: AccountId, achievementId: AchievementId): boolean {
    return Boolean(this.findBadge(participantId, achievementId));
  }

  listBadges(participantId: AccountId, opts?: { includeHidden?: boolean }): Badge[] {
    const ids = this.byParticipant.get(participantId) ?? [];
    let list = ids.map((id) => this.badges.get(id)!).filter(Boolean);
    if (!opts?.includeHidden) {
      const hiddenAchievements = new Set(
        [...this.definitions.values()].filter((a) => a.hidden).map((a) => a.id),
      );
      // Hidden badges are kept but their underlying achievement is hidden from
      // listings. We still return the badge record; callers decide visibility.
      list = list.filter((b) => !hiddenAchievements.has(b.achievementId) || opts?.includeHidden);
    }
    return list.sort((a, b) => (a.earnedAt < b.earnedAt ? 1 : -1));
  }

  displayBadge(badgeId: BadgeId): Badge {
    const badge = this.badges.get(badgeId);
    if (!badge) {
      throw new AchievementError({
        code: "eks.achievement.badge.not_found",
        category: "not_found",
        message: `Badge ${badgeId} not found.`,
      });
    }
    const updated: Badge = { ...badge, displayed: true };
    this.badges.set(badgeId, updated);
    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.badgeDisplayed,
        { badgeId, participantId: badge.participantId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  hideBadge(badgeId: BadgeId): Badge {
    const badge = this.badges.get(badgeId);
    if (!badge) {
      throw new AchievementError({
        code: "eks.achievement.badge.not_found",
        category: "not_found",
        message: `Badge ${badgeId} not found.`,
      });
    }
    const updated: Badge = { ...badge, displayed: false };
    this.badges.set(badgeId, updated);
    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.badgeHidden,
        { badgeId, participantId: badge.participantId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Return rare+ badges (rare, epic, legendary, mythic). */
  getRareBadges(participantId?: AccountId): Badge[] {
    const rareSet = new Set<AchievementRarity>(["rare", "epic", "legendary", "mythic"]);
    let list = [...this.badges.values()];
    if (participantId) list = list.filter((b) => b.participantId === participantId);
    return list.filter((b) => {
      const ach = this.definitions.get(b.achievementId);
      return ach && rareSet.has(ach.rarity);
    });
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalAchievements: number;
    totalBadgesAwarded: number;
    byRarity: Record<string, number>;
    byType: Record<string, number>;
    completedProgress: number;
    participantsWithBadges: number;
  } {
    const list = [...this.definitions.values()];
    const byRarity: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const a of list) {
      byRarity[a.rarity] = (byRarity[a.rarity] ?? 0) + 1;
      byType[a.type] = (byType[a.type] ?? 0) + 1;
    }
    let completedProgress = 0;
    for (const p of this.progress.values()) if (p.completed) completedProgress++;
    return {
      totalAchievements: list.length,
      totalBadgesAwarded: this.badges.size,
      byRarity,
      byType,
      completedProgress,
      participantsWithBadges: this.byParticipant.size,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private findBadge(participantId: AccountId, achievementId: AchievementId): Badge | undefined {
    const ids = this.byParticipant.get(participantId) ?? [];
    for (const id of ids) {
      const b = this.badges.get(id);
      if (b && b.achievementId === achievementId) return b;
    }
    return undefined;
  }

  private registerDefaults(): void {
    if (this.defaultsRegistered) return;
    const defaults: DefineAchievementInput[] = [
      {
        slug: "first-measurement",
        name: "First Measurement",
        description: "Record your very first health measurement.",
        type: "milestone",
        icon: "📏",
        rarity: "common",
        xpReward: 10,
        trigger: { type: "measurement_recorded", condition: "measurement.count >= 1", threshold: 1 },
      },
      {
        slug: "7-day-streak",
        name: "7-Day Streak",
        description: "Maintain a habit streak for 7 consecutive days.",
        type: "badge",
        icon: "🔥",
        rarity: "common",
        xpReward: 25,
        trigger: { type: "streak_reached", condition: "habit.streak >= 7", threshold: 7 },
      },
      {
        slug: "30-day-streak",
        name: "30-Day Streak",
        description: "Maintain a habit streak for 30 consecutive days.",
        type: "badge",
        icon: "⚡",
        rarity: "rare",
        xpReward: 100,
        trigger: { type: "streak_reached", condition: "habit.streak >= 30", threshold: 30 },
      },
      {
        slug: "first-competition",
        name: "First Competition",
        description: "Join your first health competition.",
        type: "milestone",
        icon: "🏁",
        rarity: "common",
        xpReward: 15,
        trigger: { type: "competition_won", condition: "competition.participations >= 1", threshold: 1 },
      },
      {
        slug: "competition-winner",
        name: "Competition Winner",
        description: "Win a competition (rank #1 on the podium).",
        type: "badge",
        icon: "🏆",
        rarity: "legendary",
        xpReward: 500,
        trigger: { type: "competition_won", condition: "competition.podium_rank == 1", threshold: 1 },
      },
      {
        slug: "first-program-install",
        name: "First Program Install",
        description: "Install your first health program.",
        type: "milestone",
        icon: "📦",
        rarity: "common",
        xpReward: 10,
        trigger: { type: "program_installed", condition: "program.installs >= 1", threshold: 1 },
      },
      {
        slug: "5-programs-installed",
        name: "5 Programs Installed",
        description: "Install five different health programs.",
        type: "badge",
        icon: "📚",
        rarity: "rare",
        xpReward: 75,
        trigger: { type: "program_installed", condition: "program.installs >= 5", threshold: 5 },
      },
      {
        slug: "first-technician-visit",
        name: "First Technician Visit",
        description: "Complete your first verified technician session.",
        type: "milestone",
        icon: "🩺",
        rarity: "common",
        xpReward: 20,
        trigger: { type: "custom", condition: "technician.sessions >= 1", threshold: 1 },
      },
      {
        slug: "100-measurements",
        name: "100 Measurements",
        description: "Record 100 health measurements.",
        type: "badge",
        icon: "📊",
        rarity: "epic",
        xpReward: 200,
        trigger: { type: "measurement_recorded", condition: "measurement.count >= 100", threshold: 100 },
      },
      {
        slug: "perfect-week",
        name: "Perfect Week",
        description: "Complete every daily habit for 7 consecutive days.",
        type: "badge",
        icon: "✨",
        rarity: "epic",
        xpReward: 150,
        trigger: { type: "mission_completed", condition: "mission.perfect_week == true", threshold: 1 },
      },
    ];
    for (const d of defaults) {
      try {
        this.define(d);
      } catch {
        // already registered — safe to ignore on re-construction
      }
    }
  }
}

function progressKey(participantId: AccountId, achievementId: AchievementId): string {
  return `${participantId}::${achievementId}`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: BadgeManager | null = null;
export function getBadges(): BadgeManager {
  if (!_manager) _manager = new BadgeManager();
  return _manager;
}
export function resetBadges(): void {
  _manager = null;
}
