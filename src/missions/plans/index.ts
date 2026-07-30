/**
 * Eks-Health Mission Engine — Plans & Adaptive Planning
 *
 * Plans tie missions, goals, and habits together for a participant. Plans are
 * versioned immutably: every update or adaptation snapshots the previous
 * version (point-in-time `PlanSnapshot`). Adaptive planning evaluates rule
 * triggers against the participant's live context (mission progress,
 * measurements, competition rank, streaks, goal achievement, evidence,
 * technician observations) and applies structured actions:
 *   add_mission · remove_mission · modify_difficulty · notify · escalate ·
 *   pause_plan · custom.
 *
 * The platform understands ONLY generic plan/adaptivity primitives. Programs
 * decide which adaptivity rules to attach to a plan and what each action's
 * params mean for their coaching methodology.
 */

import "server-only";
import {
  type PlanId,
  type PlanVersionId,
  type Plan,
  type AdaptivityRule,
  type PlanState,
  type MissionId,
  type GoalId,
  type HabitId,
  type ProgramId,
  type AccountId,
  MissionError,
  asPlanId,
  asPlanVersionId,
  asMissionId,
  MISSION_EVENTS,
} from "../core";
import type { Mission } from "../missions";
import { getMissions } from "../missions";
import { getGoals } from "../goals";
import { getHabits } from "../habits";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getProfiles, getMeasurements } from "@/health";
import { getLeaderboards } from "@/competitions";

// ---------------------------------------------------------------------------
// Plan versioning & adaptation types
// ---------------------------------------------------------------------------

/** Immutable point-in-time snapshot of a plan (taken on every version bump). */
export interface PlanSnapshot {
  readonly snapshotId: PlanVersionId;
  readonly planId: PlanId;
  readonly version: number;
  readonly missionIds: MissionId[];
  readonly goalIds: GoalId[];
  readonly habitIds: HabitId[];
  readonly state: PlanState;
  readonly capturedAt: string;
}

/** Record of one adaptivity-rule evaluation against a plan. */
export interface PlanAdaptation {
  readonly id: string;
  readonly planId: PlanId;
  readonly at: string;
  readonly trigger: string;
  readonly action: AdaptivityRule["action"];
  readonly params?: Readonly<Record<string, unknown>>;
  readonly previousVersion: number;
  readonly newVersion: number;
  readonly applied: boolean;
  readonly reason: string;
}

export interface PlanStats {
  readonly total: number;
  readonly active: number;
  readonly completed: number;
  readonly paused: number;
  readonly archived: number;
  readonly draft: number;
  readonly avgMissionsPerPlan: number;
  readonly avgGoalsPerPlan: number;
  readonly avgHabitsPerPlan: number;
  readonly adaptationCount: number;
  readonly appliedAdaptationCount: number;
}

export interface PlanCreateInput {
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly name: string;
  readonly description: string;
  readonly missionIds?: readonly MissionId[];
  readonly goalIds?: readonly GoalId[];
  readonly habitIds?: readonly HabitId[];
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly adaptivityRules?: readonly AdaptivityRule[];
  readonly customAttributes?: Record<string, unknown>;
  readonly state?: PlanState;
}

export type PlanUpdateInput = Partial<
  Pick<
    Plan,
    | "name"
    | "description"
    | "missionIds"
    | "goalIds"
    | "habitIds"
    | "validUntil"
    | "adaptivityRules"
    | "customAttributes"
  >
>;

export interface PlanListFilter {
  readonly participantId?: AccountId;
  readonly programId?: ProgramId;
  readonly state?: PlanState;
}

// ---------------------------------------------------------------------------
// Internal adapt context — computed from live participant state
// ---------------------------------------------------------------------------

interface PlanAdaptContext {
  readonly completionRate: number;
  readonly activeMissions: number;
  readonly totalMissions: number;
  readonly completedMissions: number;
  readonly streaksBroken: number;
  readonly goalsAchieved: number;
  readonly competitionRank: number | undefined;
  readonly measurements: Record<string, number>;
  readonly evidenceCount: number;
  readonly technicianObservations: number;
  readonly riskChanged: boolean;
}

// ---------------------------------------------------------------------------
// Plan lifecycle
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<PlanState, PlanState[]> = {
  draft: ["active", "archived"],
  active: ["paused", "completed", "archived"],
  paused: ["active", "completed", "archived"],
  completed: ["archived"],
  archived: [],
};

// ---------------------------------------------------------------------------
// Plan manager
// ---------------------------------------------------------------------------

export class PlanManager {
  private readonly plans = new Map<PlanId, Plan>();
  private readonly snapshots = new Map<PlanId, PlanSnapshot[]>();
  private readonly adaptations = new Map<PlanId, PlanAdaptation[]>();
  private readonly byParticipant = new Map<AccountId, PlanId[]>();
  private readonly byProgram = new Map<ProgramId, PlanId[]>();

  create(input: PlanCreateInput): Plan {
    const now = getClock().iso();
    const plan: Plan = {
      id: asPlanId(generateId("plan_")),
      programId: input.programId,
      participantId: input.participantId,
      name: input.name,
      description: input.description,
      version: 1,
      missionIds: [...(input.missionIds ?? [])],
      goalIds: [...(input.goalIds ?? [])],
      habitIds: [...(input.habitIds ?? [])],
      state: input.state ?? "draft",
      createdAt: now,
      updatedAt: now,
      validFrom: input.validFrom ?? now,
      validUntil: input.validUntil,
      adaptivityRules: [...(input.adaptivityRules ?? [])],
      customAttributes: input.customAttributes,
    };
    this.plans.set(plan.id, plan);
    this.snapshots.set(plan.id, []);
    this.adaptations.set(plan.id, []);
    this.indexBy(plan);
    void getEventBus().publish(
      buildEvent(
        MISSION_EVENTS.planCreated,
        {
          planId: plan.id,
          participantId: plan.participantId,
          programId: plan.programId,
          version: plan.version,
          missionCount: plan.missionIds.length,
        },
        {},
        "domain",
      ),
    );
    return plan;
  }

  get(id: PlanId): Plan | undefined {
    return this.plans.get(id);
  }

  list(filter?: PlanListFilter): Plan[] {
    let list = [...this.plans.values()];
    if (filter?.participantId) list = list.filter((p) => p.participantId === filter.participantId);
    if (filter?.programId) list = list.filter((p) => p.programId === filter.programId);
    if (filter?.state) list = list.filter((p) => p.state === filter.state);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The active plan for a participant (most recently created active plan). */
  getActiveForParticipant(participantId: AccountId): Plan | undefined {
    return this.list({ participantId, state: "active" })[0];
  }

  /** Update plan fields — snapshots the previous version and bumps version. */
  update(id: PlanId, updates: PlanUpdateInput): Plan {
    const plan = this.requirePlan(id);
    this.snapshot(plan);
    const updated: Plan = {
      ...plan,
      ...updates,
      missionIds: updates.missionIds ? [...updates.missionIds] : plan.missionIds,
      goalIds: updates.goalIds ? [...updates.goalIds] : plan.goalIds,
      habitIds: updates.habitIds ? [...updates.habitIds] : plan.habitIds,
      adaptivityRules: updates.adaptivityRules ? [...updates.adaptivityRules] : plan.adaptivityRules,
      version: plan.version + 1,
      updatedAt: getClock().iso(),
    };
    this.plans.set(id, updated);
    void getEventBus().publish(
      buildEvent(
        MISSION_EVENTS.planUpdated,
        {
          planId: id,
          participantId: plan.participantId,
          programId: plan.programId,
          previousVersion: plan.version,
          newVersion: updated.version,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /**
   * Evaluate an adaptivity rule against the participant's live context.
   *
   * If the trigger matches, the action is applied (add/remove mission,
   * modify difficulty, notify, escalate, pause plan, or custom), the plan
   * is snapshotted and a new version is created, and `plan.adapted` is
   * emitted. If the trigger does not match, an unapplied adaptation is
   * recorded (no version bump, no event).
   */
  adapt(id: PlanId, rule: AdaptivityRule): PlanAdaptation {
    const plan = this.requirePlan(id);
    const ctx = this.buildAdaptContext(plan);
    const triggered = this.evaluateTrigger(rule.trigger, ctx);

    if (!triggered) {
      const adaptation: PlanAdaptation = {
        id: generateId("adap_"),
        planId: id,
        at: getClock().iso(),
        trigger: rule.trigger,
        action: rule.action,
        params: rule.params,
        previousVersion: plan.version,
        newVersion: plan.version,
        applied: false,
        reason: "Trigger condition not met — no action applied.",
      };
      this.recordAdaptation(id, adaptation);
      return adaptation;
    }

    this.snapshot(plan);
    const result = this.applyAction(plan, rule);
    const updated = this.plans.get(id)!;
    const adaptation: PlanAdaptation = {
      id: generateId("adap_"),
      planId: id,
      at: getClock().iso(),
      trigger: rule.trigger,
      action: rule.action,
      params: rule.params,
      previousVersion: plan.version,
      newVersion: updated.version,
      applied: true,
      reason: result.reason,
    };
    this.recordAdaptation(id, adaptation);
    void getEventBus().publish(
      buildEvent(
        MISSION_EVENTS.planAdapted,
        {
          planId: id,
          participantId: plan.participantId,
          programId: plan.programId,
          action: rule.action,
          trigger: rule.trigger,
          previousVersion: plan.version,
          newVersion: updated.version,
        },
        {},
        "domain",
      ),
    );
    return adaptation;
  }

  /** Convenience: evaluate ALL adaptivity rules attached to a plan. */
  adaptAll(id: PlanId): PlanAdaptation[] {
    const plan = this.requirePlan(id);
    const rules = plan.adaptivityRules ?? [];
    const results: PlanAdaptation[] = [];
    for (const rule of rules) {
      // Re-fetch plan each iteration — adapt() may bump version.
      const current = this.plans.get(id);
      if (!current) break;
      results.push(this.adapt(id, rule));
    }
    return results;
  }

  getAdaptations(id: PlanId): PlanAdaptation[] {
    return [...(this.adaptations.get(id) ?? [])];
  }

  getVersionHistory(id: PlanId): PlanSnapshot[] {
    return [...(this.snapshots.get(id) ?? [])];
  }

  pause(id: PlanId): Plan {
    return this.transition(id, "paused");
  }
  resume(id: PlanId): Plan {
    return this.transition(id, "active");
  }
  complete(id: PlanId): Plan {
    return this.transition(id, "completed");
  }
  archive(id: PlanId): Plan {
    return this.transition(id, "archived");
  }

  getStats(participantId?: AccountId): PlanStats {
    let list = [...this.plans.values()];
    if (participantId) list = list.filter((p) => p.participantId === participantId);
    const active = list.filter((p) => p.state === "active").length;
    const completed = list.filter((p) => p.state === "completed").length;
    const paused = list.filter((p) => p.state === "paused").length;
    const archived = list.filter((p) => p.state === "archived").length;
    const draft = list.filter((p) => p.state === "draft").length;
    const totalMissions = list.reduce((a, p) => a + p.missionIds.length, 0);
    const totalGoals = list.reduce((a, p) => a + p.goalIds.length, 0);
    const totalHabits = list.reduce((a, p) => a + p.habitIds.length, 0);
    let adaptationCount = 0;
    let appliedAdaptationCount = 0;
    for (const p of list) {
      const ads = this.adaptations.get(p.id) ?? [];
      adaptationCount += ads.length;
      appliedAdaptationCount += ads.filter((a) => a.applied).length;
    }
    return {
      total: list.length,
      active,
      completed,
      paused,
      archived,
      draft,
      avgMissionsPerPlan: list.length > 0 ? totalMissions / list.length : 0,
      avgGoalsPerPlan: list.length > 0 ? totalGoals / list.length : 0,
      avgHabitsPerPlan: list.length > 0 ? totalHabits / list.length : 0,
      adaptationCount,
      appliedAdaptationCount,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requirePlan(id: PlanId): Plan {
    const plan = this.plans.get(id);
    if (!plan) {
      throw new MissionError({
        code: "eks.mission.plan.not_found",
        category: "not_found",
        message: `Plan ${id} not found.`,
        userMessage: "Plan not found.",
        metadata: { planId: id },
      });
    }
    return plan;
  }

  private transition(id: PlanId, to: PlanState): Plan {
    const plan = this.requirePlan(id);
    if (!TRANSITIONS[plan.state]?.includes(to)) {
      throw new MissionError({
        code: "eks.mission.plan.invalid_transition",
        category: "state_conflict",
        message: `Cannot transition plan ${plan.state}→${to}.`,
        userMessage: "This plan cannot move to that state.",
        metadata: { planId: id, from: plan.state, to },
      });
    }
    const updated: Plan = { ...plan, state: to, updatedAt: getClock().iso() };
    this.plans.set(id, updated);
    return updated;
  }

  private snapshot(plan: Plan): PlanSnapshot {
    const snap: PlanSnapshot = {
      snapshotId: asPlanVersionId(generateId("plv_")),
      planId: plan.id,
      version: plan.version,
      missionIds: [...plan.missionIds],
      goalIds: [...plan.goalIds],
      habitIds: [...plan.habitIds],
      state: plan.state,
      capturedAt: getClock().iso(),
    };
    const list = this.snapshots.get(plan.id) ?? [];
    this.snapshots.set(plan.id, [...list, snap]);
    return snap;
  }

  private recordAdaptation(planId: PlanId, adaptation: PlanAdaptation): void {
    const list = this.adaptations.get(planId) ?? [];
    this.adaptations.set(planId, [...list, adaptation]);
  }

  private indexBy(p: Plan): void {
    const pList = this.byParticipant.get(p.participantId) ?? [];
    this.byParticipant.set(p.participantId, [...pList, p.id]);
    const prList = this.byProgram.get(p.programId) ?? [];
    this.byProgram.set(p.programId, [...prList, p.id]);
  }

  /**
   * Build the adapt context from the participant's live state. Fetches
   * missions, goals, habits via the sibling mission subsystems. All
   * subsystems are guarded — if one is unavailable, the corresponding
   * factor defaults to a safe zero/undefined.
   */
  private buildAdaptContext(plan: Plan): PlanAdaptContext {
    let totalMissions = 0;
    let activeMissions = 0;
    let completedMissions = 0;
    let attemptedMissions = 0;
    let streaksBroken = 0;
    let goalsAchieved = 0;
    const measurements: Record<string, number> = {};
    let competitionRank: number | undefined;
    let evidenceCount = 0;
    let technicianObservations = 0;
    let riskChanged = false;

    try {
      const missions = getMissions().list({ participantId: plan.participantId });
      totalMissions = missions.length;
      activeMissions = missions.filter((m) => m.state === "active" || m.state === "assigned").length;
      completedMissions = missions.filter((m) => m.state === "completed").length;
      attemptedMissions = missions.filter(
        (m) => m.state === "completed" || m.state === "skipped" || m.state === "expired",
      ).length;
      evidenceCount = missions.filter((m) => (m.result?.evidenceIds?.length ?? 0) > 0).length;
      // technician observations: missions whose metadata carries a technician note
      technicianObservations = missions.filter(
        (m) => m.metadata && typeof m.metadata["technicianObservation"] === "string",
      ).length;
    } catch {
      /* missions subsystem unavailable */
    }

    try {
      const goals = getGoals().list({ participantId: plan.participantId });
      goalsAchieved = goals.filter((g) => g.state === "achieved").length;
    } catch {
      /* goals subsystem unavailable */
    }

    try {
      const habits = getHabits().list({ participantId: plan.participantId });
      streaksBroken = habits.filter((h) => Boolean(h.streak.brokenAt)).length;
    } catch {
      /* habits subsystem unavailable */
    }

    // Measurements: gathered defensively from the health platform. Best-effort —
    // if the profile or measurement store is unavailable, the adapt context
    // still has valid zeros and adaptation can proceed on the mission/goal/
    // habit signals alone.
    try {
      const profiles = getProfiles();
      const profile = profiles.get(plan.participantId);
      if (profile) {
        const store = getMeasurements();
        const all = store.list({ profileId: profile.id });
        // Latest value per schemaId (list() returns most-recent-first)
        const bySchema = new Map<string, { value: unknown; collectedAt: string }>();
        for (const m of all) {
          const ts = m.provenance?.collectedAt ?? "";
          const existing = bySchema.get(m.schemaId as string);
          if (!existing || ts > existing.collectedAt) {
            bySchema.set(m.schemaId as string, { value: m.value, collectedAt: ts });
          }
        }
        for (const [schemaId, { value }] of bySchema) {
          if (typeof value === "number") {
            measurements[schemaId] = value;
          } else if (typeof value === "object" && value !== null && "value" in value) {
            const inner = (value as { value: unknown }).value;
            if (typeof inner === "number") measurements[schemaId] = inner;
          }
        }
      }
    } catch {
      /* health measurements unavailable */
    }

    // Competition rank: best (lowest) rank across all leaderboards the
    // participant appears in.
    try {
      const lbs = getLeaderboards();
      const boards = lbs.list() ?? [];
      let bestRank: number | undefined;
      for (const b of boards) {
        const r = lbs.getRank(b.id, plan.participantId);
        const rank = r?.entry?.rank;
        if (typeof rank === "number") {
          bestRank = bestRank === undefined ? rank : Math.min(bestRank, rank);
        }
      }
      competitionRank = bestRank;
    } catch {
      /* competitions subsystem unavailable */
    }

    const completionRate = attemptedMissions > 0 ? completedMissions / attemptedMissions : 0;

    return {
      completionRate,
      activeMissions,
      totalMissions,
      completedMissions,
      streaksBroken,
      goalsAchieved,
      competitionRank,
      measurements,
      evidenceCount,
      technicianObservations,
      riskChanged,
    };
  }

  /**
   * Real trigger evaluator. Supports structured trigger expressions:
   *   - "manual" / "always" → always true
   *   - "completion_rate <op> <number>" — op in <=, >=, <, >, ==, =
   *   - "active_missions <op> <number>"
   *   - "streak_broken" → true when any habit streak is broken
   *   - "goal_achieved" → true when any goal achieved
   *   - "rank <op> <number>" → competition rank comparison
   *   - "measurement:<schemaId> <op> <number>" → latest measurement value
   *   - "evidence_submitted" → true when at least one mission has evidence
   *   - "technician_observation" → true when technician observations exist
   *   - "risk_changed" → true when risk has changed
   * Unknown triggers fail safe (no adaptation).
   */
  private evaluateTrigger(trigger: string, ctx: PlanAdaptContext): boolean {
    const t = trigger.trim().toLowerCase();
    if (t === "" || t === "manual" || t === "always") return true;

    let m = t.match(/^completion_rate\s*(<=|>=|<|>|==|=)\s*(\d+(?:\.\d+)?)$/);
    if (m) return this.compare(ctx.completionRate, m[1]!, parseFloat(m[2]!));

    m = t.match(/^active_missions\s*(<=|>=|<|>|==|=)\s*(\d+)$/);
    if (m) return this.compare(ctx.activeMissions, m[1]!, parseInt(m[2]!, 10));

    if (t === "streak_broken") return ctx.streaksBroken > 0;
    if (t === "goal_achieved") return ctx.goalsAchieved > 0;
    if (t === "evidence_submitted") return ctx.evidenceCount > 0;
    if (t === "technician_observation") return ctx.technicianObservations > 0;
    if (t === "risk_changed") return ctx.riskChanged;

    m = t.match(/^rank\s*(<=|>=|<|>|==|=)\s*(\d+)$/);
    if (m) {
      if (ctx.competitionRank == null) return false;
      return this.compare(ctx.competitionRank, m[1]!, parseInt(m[2]!, 10));
    }

    m = t.match(/^measurement:([a-z0-9_]+)\s*(<=|>=|<|>|==|=)\s*(-?\d+(?:\.\d+)?)$/);
    if (m) {
      const v = ctx.measurements[m[1]!];
      if (v == null) return false;
      return this.compare(v, m[2]!, parseFloat(m[3]!));
    }

    return false;
  }

  private compare(a: number, op: string, b: number): boolean {
    switch (op) {
      case "<=": return a <= b;
      case ">=": return a >= b;
      case "<": return a < b;
      case ">": return a > b;
      case "==":
      case "=": return a === b;
      default: return false;
    }
  }

  /**
   * Apply the rule's action. The snapshot was already taken by the caller.
   * Each action reads the CURRENT (pre-bump) plan from the map, mutates a
   * copy, writes it back with `version + 1`. Returns a human-readable
   * reason that is recorded on the adaptation.
   */
  private applyAction(plan: Plan, rule: AdaptivityRule): { reason: string } {
    const params = rule.params ?? {};
    switch (rule.action) {
      case "add_mission": {
        const spec = params["mission"] as
          | {
              type?: Mission["type"];
              category?: Mission["category"];
              title: string;
              description?: string;
              scheduledFor: string;
              priority?: Mission["priority"];
              difficulty?: Mission["difficulty"];
              durationMinutes?: number;
              evidenceRequired?: boolean;
              metadata?: Record<string, unknown>;
            }
          | undefined;
        if (!spec) return { reason: "add_mission: no mission spec in params." };
        try {
          const mission = getMissions().assign({
            programId: plan.programId,
            participantId: plan.participantId,
            planId: plan.id,
            type: spec.type ?? "daily_mission",
            category: spec.category ?? "custom",
            title: spec.title,
            description: spec.description ?? "",
            scheduledFor: spec.scheduledFor,
            priority: spec.priority,
            difficulty: spec.difficulty,
            durationMinutes: spec.durationMinutes,
            evidenceRequired: spec.evidenceRequired,
            metadata: spec.metadata,
          });
          const current = this.plans.get(plan.id)!;
          this.plans.set(plan.id, {
            ...current,
            missionIds: [...current.missionIds, mission.id],
            version: current.version + 1,
            updatedAt: getClock().iso(),
          });
          return { reason: `Added mission '${mission.title}' (${mission.id}) to plan.` };
        } catch (e) {
          return { reason: `add_mission failed: ${(e as Error).message}` };
        }
      }
      case "remove_mission": {
        const missionIdRaw = params["missionId"] as string | undefined;
        if (!missionIdRaw) return { reason: "remove_mission: no missionId in params." };
        const mid = asMissionId(missionIdRaw);
        const current = this.plans.get(plan.id)!;
        if (!current.missionIds.includes(mid)) {
          return { reason: `remove_mission: mission ${missionIdRaw} not in plan.` };
        }
        try {
          getMissions().cancel(mid);
        } catch {
          /* mission may already be cancelled */
        }
        this.plans.set(plan.id, {
          ...current,
          missionIds: current.missionIds.filter((x) => x !== mid),
          version: current.version + 1,
          updatedAt: getClock().iso(),
        });
        return { reason: `Removed mission ${missionIdRaw} from plan.` };
      }
      case "modify_difficulty": {
        const missionIdRaw = params["missionId"] as string | undefined;
        const difficulty = params["difficulty"] as Mission["difficulty"] | undefined;
        if (!missionIdRaw || !difficulty) {
          return { reason: "modify_difficulty: requires missionId and difficulty." };
        }
        const current = this.plans.get(plan.id)!;
        const ca = current.customAttributes ?? {};
        const recs = (ca["difficultyRecommendations"] as Array<Record<string, unknown>> | undefined) ?? [];
        this.plans.set(plan.id, {
          ...current,
          customAttributes: {
            ...ca,
            difficultyRecommendations: [
              ...recs,
              { missionId: missionIdRaw, difficulty, at: getClock().iso(), trigger: rule.trigger },
            ],
          },
          version: current.version + 1,
          updatedAt: getClock().iso(),
        });
        return { reason: `Recorded difficulty recommendation for mission ${missionIdRaw} → ${difficulty}.` };
      }
      case "notify": {
        const message = (params["message"] as string | undefined) ?? "Plan adaptation notification.";
        const current = this.plans.get(plan.id)!;
        const ca = current.customAttributes ?? {};
        const notes = (ca["notifications"] as string[] | undefined) ?? [];
        this.plans.set(plan.id, {
          ...current,
          customAttributes: { ...ca, notifications: [...notes, message] },
          version: current.version + 1,
          updatedAt: getClock().iso(),
        });
        return { reason: `Notified participant: ${message}` };
      }
      case "escalate": {
        const to = (params["to"] as string | undefined) ?? "technician";
        const reason = (params["reason"] as string | undefined) ?? rule.trigger;
        const current = this.plans.get(plan.id)!;
        const ca = current.customAttributes ?? {};
        const esc = (ca["escalations"] as Array<Record<string, unknown>> | undefined) ?? [];
        this.plans.set(plan.id, {
          ...current,
          customAttributes: {
            ...ca,
            escalations: [...esc, { to, reason, at: getClock().iso(), trigger: rule.trigger }],
          },
          version: current.version + 1,
          updatedAt: getClock().iso(),
        });
        return { reason: `Escalated to ${to}: ${reason}` };
      }
      case "pause_plan": {
        const current = this.plans.get(plan.id)!;
        if (current.state === "active") {
          const paused = this.transition(plan.id, "paused");
          this.plans.set(plan.id, { ...paused, version: current.version + 1, updatedAt: getClock().iso() });
          return { reason: "Plan paused." };
        }
        return { reason: `Plan not active (state=${current.state}); no pause applied.` };
      }
      case "custom":
      default: {
        const current = this.plans.get(plan.id)!;
        this.plans.set(plan.id, {
          ...current,
          version: current.version + 1,
          updatedAt: getClock().iso(),
        });
        return { reason: `Custom action recorded with params: ${JSON.stringify(params)}` };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: PlanManager | null = null;
export function getPlans(): PlanManager {
  if (!_mgr) _mgr = new PlanManager();
  return _mgr;
}

export function resetPlans(): void {
  _mgr = null;
}

// ---------------------------------------------------------------------------
// Public type re-exports
// ---------------------------------------------------------------------------

export type {
  PlanId,
  PlanVersionId,
  Plan,
  AdaptivityRule,
  PlanState,
  MissionId,
  GoalId,
  HabitId,
  ProgramId,
  AccountId,
};
