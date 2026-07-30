/**
 * Eks-Health Health Orchestrator — Shared Goal Engine
 *
 * Programs contribute to common goals. A "Lose 10 kg" goal might be
 * contributed to by Weight, Nutrition, Sleep, Mental Wellness, and Exercise
 * programs — each reporting their own slice of progress (calories burned,
 * meals logged, hours slept, mood score, workouts completed). The participant
 * sees ONE unified goal, not five competing ones.
 *
 * The orchestrator:
 *   - Maintains shared goals per participant
 *   - Aggregates contributions from contributing programs
 *   - Recomputes progress as contributions change
 *   - Detects achievement in real time
 *
 * Built on the orchestrator core. No external deps. Pure TS, strict, ESM.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type SharedGoalId,
  type SharedGoal,
  OrchestratorError,
  asSharedGoalId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Local mutable shape (the public SharedGoal is readonly)
// ---------------------------------------------------------------------------

interface SharedGoalRecord extends SharedGoal {
  contributors: { programId: ProgramId; contribution: number; description: string }[];
}

export interface SharedGoalProgress {
  readonly goalId: SharedGoalId;
  readonly name: string;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly unit?: string;
  readonly progressPercent: number; // 0-100
  readonly achieved: boolean;
  readonly contributorCount: number;
  readonly perProgram: {
    readonly programId: ProgramId;
    readonly contribution: number;
    readonly sharePercent: number; // share of current value (0-100)
    readonly description: string;
  }[];
}

export interface SharedGoalStats {
  readonly totalGoals: number;
  readonly achievedCount: number;
  readonly activeCount: number;
  readonly avgContributors: number;
  readonly avgProgress: number;
  readonly byUnit: Record<string, number>;
}

export interface SharedGoalContributor {
  readonly programId: ProgramId;
  readonly contribution: number;
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SharedGoalEngine {
  private readonly goals = new Map<SharedGoalId, SharedGoalRecord>();

  /** Create a new shared goal for a participant. */
  create(
    participantId: AccountId,
    name: string,
    description: string,
    targetValue: number,
    unit?: string,
  ): SharedGoal {
    if (!name || name.trim().length === 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.missing_name",
        category: "validation",
        message: "Shared goal name is required.",
        userMessage: "A goal name is required.",
      });
    }
    if (!Number.isFinite(targetValue) || targetValue <= 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.invalid_target",
        category: "validation",
        message: `Invalid target value: ${targetValue}.`,
        userMessage: "Target value must be a positive number.",
      });
    }
    const now = getClock().iso();
    const goal: SharedGoalRecord = {
      id: asSharedGoalId(generateId("sg_")),
      participantId,
      name: name.trim(),
      description,
      targetValue,
      currentValue: 0,
      unit,
      contributors: [],
      progress: 0,
      achieved: false,
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(goal.id, goal);
    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.sharedGoalUpdated,
        { goalId: goal.id, participantId, action: "created", name: goal.name, targetValue },
        {},
        "domain",
      ),
    );
    return goal;
  }

  get(id: SharedGoalId): SharedGoal | undefined {
    return this.goals.get(id);
  }

  list(participantId?: AccountId): SharedGoal[] {
    const list = [...this.goals.values()];
    return (participantId ? list.filter((g) => g.participantId === participantId) : list).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  }

  /** A program contributes to a shared goal. */
  addContributor(
    goalId: SharedGoalId,
    programId: ProgramId,
    contribution: number,
    description: string,
  ): SharedGoal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_found",
        category: "not_found",
        message: `Shared goal ${goalId} not found.`,
        userMessage: "Goal not found.",
      });
    }
    if (!Number.isFinite(contribution) || contribution < 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.invalid_contribution",
        category: "validation",
        message: `Invalid contribution: ${contribution}.`,
        userMessage: "Contribution must be a non-negative number.",
      });
    }
    if (goal.contributors.some((c) => c.programId === programId)) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.already_contributing",
        category: "state_conflict",
        message: `Program ${programId} already contributes to goal ${goalId}.`,
        userMessage: "This program already contributes to the goal.",
        metadata: { goalId, programId },
      });
    }
    const contributors = [
      ...goal.contributors,
      { programId, contribution, description },
    ];
    return this.recompute(goal, contributors, "contributor_added", { programId, contribution });
  }

  /** Remove a program's contribution from a shared goal. */
  removeContributor(goalId: SharedGoalId, programId: ProgramId): SharedGoal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_found",
        category: "not_found",
        message: `Shared goal ${goalId} not found.`,
        userMessage: "Goal not found.",
      });
    }
    if (!goal.contributors.some((c) => c.programId === programId)) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_contributing",
        category: "not_found",
        message: `Program ${programId} is not a contributor to goal ${goalId}.`,
        userMessage: "This program is not contributing to the goal.",
        metadata: { goalId, programId },
      });
    }
    const contributors = goal.contributors.filter((c) => c.programId !== programId);
    return this.recompute(goal, contributors, "contributor_removed", { programId });
  }

  /** Update a program's existing contribution to a shared goal. */
  updateContribution(
    goalId: SharedGoalId,
    programId: ProgramId,
    newContribution: number,
  ): SharedGoal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_found",
        category: "not_found",
        message: `Shared goal ${goalId} not found.`,
        userMessage: "Goal not found.",
      });
    }
    if (!Number.isFinite(newContribution) || newContribution < 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.invalid_contribution",
        category: "validation",
        message: `Invalid contribution: ${newContribution}.`,
        userMessage: "Contribution must be a non-negative number.",
      });
    }
    const exists = goal.contributors.some((c) => c.programId === programId);
    if (!exists) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_contributing",
        category: "not_found",
        message: `Program ${programId} is not a contributor to goal ${goalId}.`,
        userMessage: "This program is not contributing to the goal.",
        metadata: { goalId, programId },
      });
    }
    const contributors = goal.contributors.map((c) =>
      c.programId === programId ? { ...c, contribution: newContribution } : c,
    );
    return this.recompute(goal, contributors, "contribution_updated", {
      programId,
      newContribution,
    });
  }

  /** Check whether a goal has been achieved; emit if newly achieved. */
  checkAchievement(goalId: SharedGoalId): { achieved: boolean; newlyAchieved: boolean } {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_found",
        category: "not_found",
        message: `Shared goal ${goalId} not found.`,
        userMessage: "Goal not found.",
      });
    }
    const wasAchieved = goal.achieved;
    const nowAchieved = goal.currentValue >= goal.targetValue;
    if (nowAchieved && !wasAchieved) {
      const updated: SharedGoalRecord = { ...goal, achieved: true, updatedAt: getClock().iso() };
      this.goals.set(goalId, updated);
      void getEventBus().publish(
        buildEvent(
          ORCHESTRATOR_EVENTS.sharedGoalUpdated,
          {
            goalId,
            participantId: goal.participantId,
            action: "achieved",
            name: goal.name,
            currentValue: goal.currentValue,
            targetValue: goal.targetValue,
          },
          {},
          "domain",
        ),
      );
      return { achieved: true, newlyAchieved: true };
    }
    if (!nowAchieved && wasAchieved) {
      // Goal regressed below target (e.g. a contributor was removed).
      const updated: SharedGoalRecord = { ...goal, achieved: false, updatedAt: getClock().iso() };
      this.goals.set(goalId, updated);
    }
    return { achieved: nowAchieved, newlyAchieved: false };
  }

  /** Detailed progress breakdown for a goal. */
  getProgress(goalId: SharedGoalId): SharedGoalProgress {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_goal.not_found",
        category: "not_found",
        message: `Shared goal ${goalId} not found.`,
        userMessage: "Goal not found.",
      });
    }
    const progressPercent = Math.min(100, Math.max(0, (goal.currentValue / goal.targetValue) * 100));
    const total = goal.contributors.reduce((a, c) => a + c.contribution, 0);
    const perProgram = goal.contributors
      .map((c) => ({
        programId: c.programId,
        contribution: c.contribution,
        sharePercent: total > 0 ? (c.contribution / total) * 100 : 0,
        description: c.description,
      }))
      .sort((a, b) => b.contribution - a.contribution);
    return {
      goalId: goal.id,
      name: goal.name,
      targetValue: goal.targetValue,
      currentValue: goal.currentValue,
      unit: goal.unit,
      progressPercent,
      achieved: goal.achieved,
      contributorCount: goal.contributors.length,
      perProgram,
    };
  }

  /** All contributing programs with their contributions. */
  getContributors(goalId: SharedGoalId): SharedGoalContributor[] {
    const goal = this.goals.get(goalId);
    if (!goal) return [];
    return [...goal.contributors].sort((a, b) => b.contribution - a.contribution);
  }

  getStats(): SharedGoalStats {
    const list = [...this.goals.values()];
    const byUnit: Record<string, number> = {};
    let achieved = 0;
    let totalContributors = 0;
    let totalProgress = 0;
    for (const g of list) {
      const u = g.unit ?? "_none_";
      byUnit[u] = (byUnit[u] ?? 0) + 1;
      if (g.achieved) achieved++;
      totalContributors += g.contributors.length;
      totalProgress += Math.min(100, (g.currentValue / g.targetValue) * 100);
    }
    return {
      totalGoals: list.length,
      achievedCount: achieved,
      activeCount: list.length - achieved,
      avgContributors: list.length > 0 ? totalContributors / list.length : 0,
      avgProgress: list.length > 0 ? totalProgress / list.length : 0,
      byUnit,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  /** Recompute currentValue/progress/achieved from contributor list. */
  private recompute(
    goal: SharedGoalRecord,
    contributors: SharedGoalRecord["contributors"],
    action: string,
    detail: Record<string, unknown>,
  ): SharedGoalRecord {
    const currentValue = contributors.reduce((a, c) => a + c.contribution, 0);
    const progress = Math.min(100, Math.max(0, (currentValue / goal.targetValue) * 100));
    const wasAchieved = goal.achieved;
    const nowAchieved = currentValue >= goal.targetValue;
    const updated: SharedGoalRecord = {
      ...goal,
      contributors,
      currentValue,
      progress,
      achieved: nowAchieved,
      updatedAt: getClock().iso(),
    };
    this.goals.set(goal.id, updated);
    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.sharedGoalUpdated,
        {
          goalId: goal.id,
          participantId: goal.participantId,
          action,
          name: goal.name,
          currentValue,
          targetValue: goal.targetValue,
          progress,
          achieved: nowAchieved,
          ...detail,
        },
        {},
        "domain",
      ),
    );
    // Emit a separate achievement event on the rising edge.
    if (nowAchieved && !wasAchieved) {
      void getEventBus().publish(
        buildEvent(
          ORCHESTRATOR_EVENTS.sharedGoalUpdated,
          {
            goalId: goal.id,
            participantId: goal.participantId,
            action: "achieved",
            name: goal.name,
            currentValue,
            targetValue: goal.targetValue,
          },
          {},
          "domain",
        ),
      );
    }
    return updated;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: SharedGoalEngine | null = null;
export function getSharedGoals(): SharedGoalEngine {
  if (!_engine) _engine = new SharedGoalEngine();
  return _engine;
}

// Re-export shared types for consumers
export type {
  AccountId,
  ProgramId,
  SharedGoal,
  SharedGoalId,
} from "../core";
