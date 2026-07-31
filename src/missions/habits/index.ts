/**
 * Eks-Health Mission Engine — Habits & Streaks
 *
 * Daily habits, weekly habits, streaks, missed days, recovery rules, grace
 * periods, recurring reminders, habit scoring, habit analytics. Programs
 * define habits; the platform executes them.
 */

import "server-only";
import {
  type HabitId,
  type StreakId,
  type ProgramId,
  type AccountId,
  type HabitFrequency,
  MissionError,
  asHabitId,
  asStreakId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MISSION_EVENTS } from "../core";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Habit
// ---------------------------------------------------------------------------

export interface Habit {
  readonly id: HabitId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly name: string;
  readonly description: string;
  readonly frequency: HabitFrequency;
  readonly targetPerPeriod: number; // e.g. 1 for daily, 3 for weekly
  readonly gracePeriodDays: number;
  readonly maxRecoveries: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly streak: Streak;
  readonly totalCompletions: number;
  readonly lastCompletedAt?: string;
  readonly score: number;
  readonly metadata?: Record<string, unknown>;
}

export interface Streak {
  readonly id: StreakId;
  readonly habitId: HabitId;
  readonly current: number;
  readonly best: number;
  readonly lastCompletedAt?: string;
  readonly startedAt: string;
  readonly gracePeriodUsed: number;
  readonly recoveryCount: number;
  readonly brokenAt?: string;
}

export interface HabitCompletion {
  readonly id: string;
  readonly habitId: HabitId;
  readonly participantId: AccountId;
  readonly completedAt: string;
  readonly value?: number;
  readonly notes?: string;
  readonly usedGrace: boolean;
}

// ---------------------------------------------------------------------------
// Habit manager
// ---------------------------------------------------------------------------

export class HabitManager {
  private readonly habits = new Map<HabitId, Habit>();
  private readonly completions: HabitCompletion[] = [];
  private readonly byParticipant = new Map<AccountId, HabitId[]>();

  create(input: {
    programId: ProgramId;
    participantId: AccountId;
    name: string;
    description: string;
    frequency: HabitFrequency;
    targetPerPeriod?: number;
    gracePeriodDays?: number;
    maxRecoveries?: number;
    metadata?: Record<string, unknown>;
  }): Habit {
    const habitId = asHabitId(generateId("hab_"));
    const streak: Streak = {
      id: asStreakId(generateId("str_")),
      habitId,
      current: 0,
      best: 0,
      startedAt: getClock().iso(),
      gracePeriodUsed: 0,
      recoveryCount: 0,
    };
    const habit: Habit = {
      id: habitId,
      programId: input.programId,
      participantId: input.participantId,
      name: input.name,
      description: input.description,
      frequency: input.frequency,
      targetPerPeriod: input.targetPerPeriod ?? 1,
      gracePeriodDays: input.gracePeriodDays ?? 1,
      maxRecoveries: input.maxRecoveries ?? 3,
      active: true,
      createdAt: getClock().iso(),
      streak,
      totalCompletions: 0,
      score: 0,
      metadata: input.metadata,
    };
    this.habits.set(habitId, habit);
    const list = this.byParticipant.get(input.participantId) ?? [];
    this.byParticipant.set(input.participantId, [...list, habitId]);
    void this._persist(habitId);
    return habit;
  }

  get(id: HabitId): Habit | undefined {
    return this.habits.get(id);
  }

  list(filter?: { participantId?: AccountId; programId?: ProgramId; activeOnly?: boolean }): Habit[] {
    let list = [...this.habits.values()];
    if (filter?.participantId) list = list.filter((h) => h.participantId === filter.participantId);
    if (filter?.programId) list = list.filter((h) => h.programId === filter.programId);
    if (filter?.activeOnly) list = list.filter((h) => h.active);
    return list;
  }

  /** Record a habit completion — extends or recovers the streak. */
  complete(habitId: HabitId, value?: number, notes?: string): Habit {
    const habit = this.habits.get(habitId);
    if (!habit) throw new MissionError({ code: "eks.mission.habit.not_found", category: "not_found", message: "Habit not found." });
    if (!habit.active) throw new MissionError({ code: "eks.mission.habit.inactive", category: "state_conflict", message: "Habit is inactive." });

    const now = getClock().iso();
    const nowDate = new Date(now);
    let usedGrace = false;
    let newStreakCurrent = habit.streak.current + 1;

    // Check if streak was broken (more than grace period since last completion)
    if (habit.streak.lastCompletedAt) {
      const lastDate = new Date(habit.streak.lastCompletedAt);
      const daysSince = Math.floor((nowDate.getTime() - lastDate.getTime()) / 86400000);
      if (daysSince > 1) {
        // Streak was potentially broken
        if (daysSince - 1 <= habit.gracePeriodDays && habit.streak.gracePeriodUsed < habit.maxRecoveries) {
          // Use grace period to maintain streak
          usedGrace = true;
        } else {
          // Streak broken
          if (habit.streak.current > 0) {
            void getEventBus().publish(buildEvent(MISSION_EVENTS.habitStreakBroken, { habitId, participantId: habit.participantId, previousStreak: habit.streak.current }, {}, "domain"));
          }
          newStreakCurrent = 1; // reset
        }
      }
    }

    const newBest = Math.max(habit.streak.best, newStreakCurrent);
    const updatedStreak: Streak = {
      ...habit.streak,
      current: newStreakCurrent,
      best: newBest,
      lastCompletedAt: now,
      gracePeriodUsed: habit.streak.gracePeriodUsed + (usedGrace ? 1 : 0),
      recoveryCount: habit.streak.recoveryCount + (usedGrace ? 1 : 0),
      brokenAt: newStreakCurrent === 1 ? undefined : habit.streak.brokenAt,
    };
    const updatedHabit: Habit = {
      ...habit,
      streak: updatedStreak,
      totalCompletions: habit.totalCompletions + 1,
      lastCompletedAt: now,
      score: this.computeScore(newStreakCurrent, habit.totalCompletions + 1),
    };
    this.habits.set(habitId, updatedHabit);
    void this._persist(habitId);
    this.completions.push({ id: generateId("hc_"), habitId, participantId: habit.participantId, completedAt: now, value, notes, usedGrace });

    void getEventBus().publish(buildEvent(MISSION_EVENTS.habitUpdated, { habitId, participantId: habit.participantId, currentStreak: newStreakCurrent }, {}, "domain"));
    if (newStreakCurrent > habit.streak.current) {
      void getEventBus().publish(buildEvent(MISSION_EVENTS.habitStreakExtended, { habitId, participantId: habit.participantId, streak: newStreakCurrent }, {}, "domain"));
    }
    return updatedHabit;
  }

  /** Mark a habit as missed (breaks the streak if grace exhausted). */
  miss(habitId: HabitId): Habit {
    const habit = this.habits.get(habitId);
    if (!habit) throw new MissionError({ code: "eks.mission.habit.not_found", category: "not_found", message: "Not found." });
    if (habit.streak.current === 0) return habit;
    void getEventBus().publish(buildEvent(MISSION_EVENTS.habitStreakBroken, { habitId, participantId: habit.participantId, previousStreak: habit.streak.current }, {}, "domain"));
    const updated: Habit = {
      ...habit,
      streak: { ...habit.streak, current: 0, brokenAt: getClock().iso() },
    };
    this.habits.set(habitId, updated);
    void this._persist(habitId);
    return updated;
  }

  deactivate(habitId: HabitId): Habit {
    const habit = this.habits.get(habitId);
    if (!habit) throw new MissionError({ code: "eks.mission.habit.not_found", category: "not_found", message: "Not found." });
    const updated = { ...habit, active: false };
    this.habits.set(habitId, updated);
    void this._persist(habitId);
    return updated;
  }

  getCompletions(habitId?: HabitId, limit = 50): HabitCompletion[] {
    let list = this.completions;
    if (habitId) list = list.filter((c) => c.habitId === habitId);
    return list.slice(-limit);
  }

  getStats(participantId?: AccountId): { total: number; active: number; totalCompletions: number; avgStreak: number; bestStreak: number } {
    let list = [...this.habits.values()];
    if (participantId) list = list.filter((h) => h.participantId === participantId);
    const totalCompletions = list.reduce((a, h) => a + h.totalCompletions, 0);
    const streaks = list.map((h) => h.streak.current);
    const bestStreaks = list.map((h) => h.streak.best);
    return {
      total: list.length,
      active: list.filter((h) => h.active).length,
      totalCompletions,
      avgStreak: streaks.length > 0 ? streaks.reduce((a, b) => a + b, 0) / streaks.length : 0,
      bestStreak: bestStreaks.length > 0 ? Math.max(...bestStreaks) : 0,
    };
  }

  private computeScore(currentStreak: number, totalCompletions: number): number {
    // Score: streak weight 60%, completion volume weight 40%
    const streakScore = Math.min(currentStreak * 5, 60);
    const volumeScore = Math.min(totalCompletions * 2, 40);
    return streakScore + volumeScore;
  }

  /** Write-behind: upsert habit as JSON snapshot to EksHabit. Fire-and-forget. */
  private async _persist(id: HabitId): Promise<void> {
    const h = this.habits.get(id);
    if (!h) return;
    try {
      await db.eksHabit.upsert({
        where: { id },
        create: {
          id: h.id,
          participantId: h.participantId,
          dataJson: JSON.stringify(h),
          active: h.active,
          createdAt: new Date(h.createdAt),
        },
        update: {
          dataJson: JSON.stringify(h),
          active: h.active,
        },
      });
    } catch (err) {
      console.error("[habits] DB write-behind failed for", h.id, err);
    }
  }

  /** Hydrate habits from DB. Rebuilds byParticipant index. */
  async hydrateFromDb(): Promise<number> {
    try {
      const rows = await db.eksHabit.findMany();
      let loaded = 0;
      for (const row of rows) {
        if (this.habits.has(row.id as HabitId)) continue;
        try {
          const h = JSON.parse(row.dataJson) as Habit;
          this.habits.set(h.id, h);
          const list = this.byParticipant.get(h.participantId) ?? [];
          this.byParticipant.set(h.participantId, [...list, h.id]);
          loaded++;
        } catch {
          // skip malformed
        }
      }
      return loaded;
    } catch (err) {
      console.error("[habits] DB hydration failed:", err);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: HabitManager | null = null;
export function getHabits(): HabitManager {
  if (!_mgr) _mgr = new HabitManager();
  return _mgr;
}
