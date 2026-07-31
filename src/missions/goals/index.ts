/**
 * Eks-Health Mission Engine — Goals & Milestones
 *
 * Programs define goals (measurement targets, behavior targets, completion
 * targets, streak targets, ranking targets, custom). Goals have milestones,
 * dependencies, deadlines, adaptive targets, and success conditions.
 */

import "server-only";
import {
  type GoalId,
  type MilestoneId,
  type ProgramId,
  type AccountId,
  type GoalType,
  type GoalState,
  type Milestone,
  MissionError,
  asGoalId,
  asMilestoneId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { MISSION_EVENTS } from "../core";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

export interface Goal {
  readonly id: GoalId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly name: string;
  readonly description: string;
  readonly type: GoalType;
  readonly state: GoalState;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly unit?: string;
  readonly measurementSchemaId?: string;
  readonly milestones: Milestone[];
  readonly deadline?: string;
  readonly adaptive: boolean;
  readonly adaptationHistory: { at: string; from: number; to: number; reason: string }[];
  readonly createdAt: string;
  readonly achievedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Goal manager
// ---------------------------------------------------------------------------

export class GoalManager {
  private readonly goals = new Map<GoalId, Goal>();
  private readonly byParticipant = new Map<AccountId, GoalId[]>();
  private readonly byProgram = new Map<ProgramId, GoalId[]>();

  create(input: {
    programId: ProgramId;
    participantId: AccountId;
    name: string;
    description: string;
    type: GoalType;
    targetValue: number;
    unit?: string;
    measurementSchemaId?: string;
    deadline?: string;
    adaptive?: boolean;
    milestones?: Array<Omit<Milestone, "id" | "currentValue" | "achievedAt">>;
    metadata?: Record<string, unknown>;
  }): Goal {
    const milestones: Milestone[] = (input.milestones ?? []).map((m) => ({
      ...m,
      id: asMilestoneId(generateId("ms_")),
      currentValue: 0,
    }));
    const goal: Goal = {
      id: asGoalId(generateId("goal_")),
      programId: input.programId,
      participantId: input.participantId,
      name: input.name,
      description: input.description,
      type: input.type,
      state: "active",
      targetValue: input.targetValue,
      currentValue: 0,
      unit: input.unit,
      measurementSchemaId: input.measurementSchemaId,
      milestones,
      deadline: input.deadline,
      adaptive: input.adaptive ?? false,
      adaptationHistory: [],
      createdAt: getClock().iso(),
      metadata: input.metadata,
    };
    this.goals.set(goal.id, goal);
    this.indexBy(goal);
    void this._persist(goal.id);
    return goal;
  }

  get(id: GoalId): Goal | undefined {
    return this.goals.get(id);
  }

  list(filter?: { participantId?: AccountId; programId?: ProgramId; state?: GoalState }): Goal[] {
    let list = [...this.goals.values()];
    if (filter?.participantId) list = list.filter((g) => g.participantId === filter.participantId);
    if (filter?.programId) list = list.filter((g) => g.programId === filter.programId);
    if (filter?.state) list = list.filter((g) => g.state === filter.state);
    return list;
  }

  /** Update progress — checks milestones and achievement. */
  updateProgress(id: GoalId, currentValue: number): Goal {
    const goal = this.goals.get(id);
    if (!goal) throw new MissionError({ code: "eks.mission.goal.not_found", category: "not_found", message: "Goal not found." });
    const updatedMilestones = goal.milestones.map((m) => {
      if (m.achievedAt) return m;
      const achieved = currentValue >= m.targetValue;
      if (achieved) {
        void getEventBus().publish(buildEvent(MISSION_EVENTS.goalMilestoneReached, { goalId: id, milestoneId: m.id, target: m.targetValue, actual: currentValue }, {}, "domain"));
        return { ...m, currentValue, achievedAt: getClock().iso() };
      }
      return { ...m, currentValue };
    });
    const achieved = currentValue >= goal.targetValue;
    const updated: Goal = {
      ...goal,
      currentValue,
      milestones: updatedMilestones,
      state: achieved ? "achieved" : goal.state,
      achievedAt: achieved ? getClock().iso() : undefined,
    };
    this.goals.set(id, updated);
    void this._persist(id);
    if (achieved) {
      void getEventBus().publish(buildEvent(MISSION_EVENTS.goalAchieved, { goalId: id, participantId: goal.participantId, target: goal.targetValue, actual: currentValue }, {}, "domain"));
    }
    return updated;
  }

  /** Adapt the target value (for adaptive goals). */
  adapt(id: GoalId, newTarget: number, reason: string): Goal {
    const goal = this.goals.get(id);
    if (!goal) throw new MissionError({ code: "eks.mission.goal.not_found", category: "not_found", message: "Not found." });
    if (!goal.adaptive) {
      throw new MissionError({ code: "eks.mission.goal.not_adaptive", category: "validation", message: "Goal is not adaptive." });
    }
    const adaptation = { at: getClock().iso(), from: goal.targetValue, to: newTarget, reason };
    const updated: Goal = { ...goal, targetValue: newTarget, adaptationHistory: [...goal.adaptationHistory, adaptation] };
    this.goals.set(id, updated);
    void this._persist(id);
    return updated;
  }

  cancel(id: GoalId): Goal {
    const goal = this.goals.get(id);
    if (!goal) throw new MissionError({ code: "eks.mission.goal.not_found", category: "not_found", message: "Not found." });
    const updated = { ...goal, state: "cancelled" as const };
    this.goals.set(id, updated);
    void this._persist(id);
    return updated;
  }

  getStats(participantId?: AccountId): { total: number; active: number; achieved: number; missed: number; achievementRate: number } {
    let list = [...this.goals.values()];
    if (participantId) list = list.filter((g) => g.participantId === participantId);
    const active = list.filter((g) => g.state === "active").length;
    const achieved = list.filter((g) => g.state === "achieved").length;
    const missed = list.filter((g) => g.state === "missed").length;
    const resolved = achieved + missed;
    return { total: list.length, active, achieved, missed, achievementRate: resolved > 0 ? achieved / resolved : 0 };
  }

  private indexBy(g: Goal): void {
    const pList = this.byParticipant.get(g.participantId) ?? [];
    this.byParticipant.set(g.participantId, [...pList, g.id]);
    const prList = this.byProgram.get(g.programId) ?? [];
    this.byProgram.set(g.programId, [...prList, g.id]);
  }

  /** Write-behind: upsert goal as JSON snapshot to EksGoal. Fire-and-forget. */
  private async _persist(id: GoalId): Promise<void> {
    const g = this.goals.get(id);
    if (!g) return;
    try {
      await db.eksGoal.upsert({
        where: { id },
        create: {
          id: g.id,
          participantId: g.participantId,
          dataJson: JSON.stringify(g),
          state: g.state,
          createdAt: new Date(g.createdAt),
        },
        update: {
          dataJson: JSON.stringify(g),
          state: g.state,
        },
      });
    } catch (err) {
      console.error("[goals] DB write-behind failed for", g.id, err);
    }
  }

  /** Hydrate goals from DB. Rebuilds byParticipant/byProgram indexes. */
  async hydrateFromDb(): Promise<number> {
    try {
      const rows = await db.eksGoal.findMany();
      let loaded = 0;
      for (const row of rows) {
        if (this.goals.has(row.id as GoalId)) continue;
        try {
          const g = JSON.parse(row.dataJson) as Goal;
          this.goals.set(g.id, g);
          this.indexBy(g);
          loaded++;
        } catch {
          // skip malformed
        }
      }
      return loaded;
    } catch (err) {
      console.error("[goals] DB hydration failed:", err);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: GoalManager | null = null;
export function getGoals(): GoalManager {
  if (!_mgr) _mgr = new GoalManager();
  return _mgr;
}
