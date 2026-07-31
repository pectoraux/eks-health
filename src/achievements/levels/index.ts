/**
 * Eks-Health Achievement Engine — Levels & XP
 *
 * XP ledger + level progression. Each participant accumulates XP from
 * missions, competitions, achievements, measurements, streaks, and social
 * activity. Crossing an XP threshold promotes them to the next level and
 * unlocks a title.
 *
 * Title tiers:
 *   1–5    Beginner
 *   6–15   Health Enthusiast
 *   16–30  Health Advocate
 *   31–50  Health Champion
 *   51–100 Health Legend
 *   >100   Health Mythic (extension tier)
 *
 * XP curve: xpToNext(level) = 100 * level (linear, predictable, generous).
 */

import "server-only";
import {
  type LevelId,
  type AccountId,
  type Level,
  type XpEvent,
  type XpSource,
  AchievementError,
  asLevelId,
  asXpEventId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { ACHIEVEMENT_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Level title tiers
// ---------------------------------------------------------------------------

export interface LevelTier {
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly title: string;
}

export const LEVEL_TIERS: readonly LevelTier[] = [
  { minLevel: 1, maxLevel: 5, title: "Beginner" },
  { minLevel: 6, maxLevel: 15, title: "Health Enthusiast" },
  { minLevel: 16, maxLevel: 30, title: "Health Advocate" },
  { minLevel: 31, maxLevel: 50, title: "Health Champion" },
  { minLevel: 51, maxLevel: 100, title: "Health Legend" },
  { minLevel: 101, maxLevel: Number.MAX_SAFE_INTEGER, title: "Health Mythic" },
];

export function titleForLevel(level: number): string {
  const tier = LEVEL_TIERS.find((t) => level >= t.minLevel && level <= t.maxLevel);
  return tier?.title ?? "Beginner";
}

/** XP required to advance from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  if (level < 1) return 100;
  return 100 * level;
}

// ---------------------------------------------------------------------------
// Add-Xp result
// ---------------------------------------------------------------------------

export interface AddXpResult {
  readonly level: Level;
  readonly xpEvent: XpEvent;
  readonly leveledUp: boolean;
  readonly levelsGained: number;
  readonly previousLevel: number;
  readonly newTitleUnlocked: boolean;
}

// ---------------------------------------------------------------------------
// Level manager
// ---------------------------------------------------------------------------

export class LevelManager {
  private readonly levels = new Map<AccountId, Level>();
  private readonly events: XpEvent[] = [];
  private readonly byParticipant = new Map<AccountId, XpEvent[]>();

  /** Add XP to a participant. Handles cascading level-ups. */
  addXp(
    participantId: AccountId,
    amount: number,
    reason: string,
    source: XpSource,
  ): AddXpResult {
    if (!Number.isFinite(amount) || amount === 0) {
      throw new AchievementError({
        code: "eks.achievement.xp.invalid_amount",
        category: "validation",
        message: `XP amount must be a non-zero finite number (got ${amount}).`,
      });
    }
    const evt: XpEvent = {
      id: asXpEventId(generateId("xp_")),
      participantId,
      amount,
      reason,
      source,
      createdAt: getClock().iso(),
    };
    this.events.push(evt);
    const list = this.byParticipant.get(participantId) ?? [];
    this.byParticipant.set(participantId, [...list, evt]);

    void getEventBus().publish(
      buildEvent(
        ACHIEVEMENT_EVENTS.xpAwarded,
        {
          xpEventId: evt.id,
          participantId,
          amount,
          reason,
          source,
        },
        {},
        "domain",
      ),
    );

    const prev = this.levels.get(participantId);
    const previousLevel = prev?.level ?? 0;
    let levelNum = Math.max(1, previousLevel);
    let xp = (prev?.xp ?? 0) + amount;
    if (xp < 0) xp = 0; // XP can be deducted but never go below zero

    // Cascade level-ups while XP exceeds the threshold.
    let levelsGained = 0;
    let needsNext = xpToNext(levelNum);
    while (xp >= needsNext && levelNum < Number.MAX_SAFE_INTEGER) {
      xp -= needsNext;
      levelNum++;
      levelsGained++;
      needsNext = xpToNext(levelNum);
    }
    // If a deduction dropped a participant below zero threshold on the
    // current level, walk them back down (rare, but keep the invariant).
    while (levelNum > 1 && xp < 0) {
      levelNum--;
      xp += xpToNext(levelNum);
    }

    const leveledUp = levelsGained > 0;
    const oldTitle = titleForLevel(previousLevel || 1);
    const newTitle = titleForLevel(levelNum);
    const newTitleUnlocked = leveledUp && oldTitle !== newTitle;

    const level: Level = {
      id: prev?.id ?? asLevelId(generateId("lvl_")),
      participantId,
      level: levelNum,
      xp,
      xpToNext: xpToNext(levelNum),
      title: newTitle,
      unlockedAt: prev?.unlockedAt ?? getClock().iso(),
    };
    this.levels.set(participantId, level);

    if (leveledUp) {
      void getEventBus().publish(
        buildEvent(
          ACHIEVEMENT_EVENTS.levelUp,
          {
            participantId,
            previousLevel,
            newLevel: levelNum,
            levelsGained,
            title: newTitle,
            titleUnlocked: newTitleUnlocked,
          },
          {},
          "domain",
        ),
      );
    }
    return { level, xpEvent: evt, leveledUp, levelsGained, previousLevel, newTitleUnlocked };
  }

  getLevel(participantId: AccountId): Level | undefined {
    return this.levels.get(participantId);
  }

  /** Ensure a participant has a level record (creates level 1 if missing). */
  ensureLevel(participantId: AccountId): Level {
    const existing = this.levels.get(participantId);
    if (existing) return existing;
    const level: Level = {
      id: asLevelId(generateId("lvl_")),
      participantId,
      level: 1,
      xp: 0,
      xpToNext: xpToNext(1),
      title: titleForLevel(1),
      unlockedAt: getClock().iso(),
    };
    this.levels.set(participantId, level);
    return level;
  }

  /** Top participants by level (then by XP, then by earliest unlock). */
  getLeaderboard(limit = 10): Level[] {
    const list = [...this.levels.values()];
    list.sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      if (b.xp !== a.xp) return b.xp - a.xp;
      return a.unlockedAt < b.unlockedAt ? -1 : 1;
    });
    return list.slice(0, Math.max(0, limit));
  }

  listXpEvents(participantId?: AccountId, limit?: number): XpEvent[] {
    let list = participantId
      ? (this.byParticipant.get(participantId) ?? [])
      : this.events;
    list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return limit ? list.slice(0, limit) : list;
  }

  getStats(): {
    totalParticipants: number;
    totalXpEvents: number;
    totalXpAwarded: number;
    bySource: Record<string, number>;
    highestLevel: number;
    byTier: Record<string, number>;
  } {
    const bySource: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    let totalXpAwarded = 0;
    let highestLevel = 0;
    for (const e of this.events) {
      bySource[e.source] = (bySource[e.source] ?? 0) + e.amount;
      totalXpAwarded += e.amount;
    }
    for (const l of this.levels.values()) {
      highestLevel = Math.max(highestLevel, l.level);
      byTier[l.title] = (byTier[l.title] ?? 0) + 1;
    }
    return {
      totalParticipants: this.levels.size,
      totalXpEvents: this.events.length,
      totalXpAwarded,
      bySource,
      highestLevel,
      byTier,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: LevelManager | null = null;
export function getLevels(): LevelManager {
  if (!_manager) _manager = new LevelManager();
  return _manager;
}
export function resetLevels(): void {
  _manager = null;
}
