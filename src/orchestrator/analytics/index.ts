/**
 * Eks-Health Health Orchestrator — Cross-Program Analytics
 *
 * Measures how well the orchestrator is doing its job: recommendation
 * conflicts, mission overlap, participant overload, completion rates,
 * coordination effectiveness, health outcome improvements, and AI
 * coordination quality. Everything is computed from REAL orchestrator data:
 *   - Timeline entries of type "orchestration" (canonical record of every
 *     conflict detection, conflict resolution, mission merge, workload
 *     reduction, shared measurement, unified goal decision).
 *   - Shared measurements (deduplication savings).
 *   - Shared goals (goal coordination).
 *   - Digital Twin (fatigue scores, risk indicators, program progress).
 *   - Health Context (today's workload, recent measurements).
 *
 * The m11-2 conflict / workload / coordinator subsystems populate the
 * timeline with `type: "orchestration"` entries carrying structured
 * `metadata.action` values; this module reads those entries — it does not
 * import the m11-2 subsystems directly. This keeps the analytics module
 * decoupled and forward-compatible.
 *
 * Built on all orchestrator subsystems. Pure TS, strict, ESM. No external deps.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type UnifiedTimelineEntry,
} from "../core";
import { getClock } from "@/kernel";
import { getTimeline } from "../timeline";
import { getSharedGoals } from "../shared-goals";
import { getSharedMeasurements } from "../shared-measurements";
import { getTwin } from "../twin";
import { getContext } from "../context";

// ---------------------------------------------------------------------------
// Public analytics types
// ---------------------------------------------------------------------------

export interface ParticipantAnalytics {
  readonly participantId: AccountId;
  readonly computedAt: string;
  readonly installedPrograms: ProgramId[];
  readonly conflictsDetected: number;
  readonly conflictsResolved: number;
  readonly crossProgramMissions: number;
  readonly sharedMeasurements: number;
  readonly sharedGoals: number;
  readonly achievedGoals: number;
  readonly timelineEntries: number;
  readonly coordinationDecisions: number;
  readonly workloadTrend: {
    readonly timestamp: string;
    readonly level: "light" | "moderate" | "heavy" | "overloaded" | "unknown";
  }[];
  readonly fatigueScore: number;
  readonly riskCount: number;
  readonly measurementDeduplications: number;
}

export interface ConflictAnalytics {
  readonly totalConflicts: number;
  readonly byType: Record<string, number>;
  readonly bySeverity: Record<string, number>;
  readonly autoResolvedCount: number;
  readonly participantOverrideCount: number;
  readonly autoResolvedRate: number; // 0-1
  readonly participantOverrideRate: number; // 0-1
}

export interface WorkloadAnalytics {
  readonly distributionByLevel: Record<string, number>;
  readonly avgMinutes: number;
  readonly avgPhysicalEffort: number;
  readonly avgMentalEffort: number;
  readonly overloadedCount: number;
  readonly overloadedRate: number; // 0-1
  readonly totalAssessments: number;
}

export interface CoordinationEffectiveness {
  readonly missionsMerged: number;
  readonly missionsMergedRate: number; // 0-1
  readonly conflictsAutoResolvedRate: number; // 0-1
  readonly measurementsDeduplicatedRate: number; // 0-1
  readonly participantOverrideRate: number; // 0-1 (lower is better)
  readonly sharedGoalsActive: number;
  readonly sharedGoalsAchieved: number;
  readonly overallScore: number; // 0-100 (composite effectiveness)
}

export interface OutcomeComparison {
  readonly participantId: AccountId;
  readonly computedAt: string;
  readonly orchestrationStart: string | null;
  readonly before: {
    readonly missionCompletionRate: number;
    readonly measurementCount: number;
    readonly timelineEntries: number;
    readonly duration: string | null;
  };
  readonly after: {
    readonly missionCompletionRate: number;
    readonly measurementCount: number;
    readonly timelineEntries: number;
    readonly duration: string | null;
  };
  readonly improvement: {
    readonly missionCompletionDelta: number;
    readonly measurementDelta: number;
    readonly timelineDelta: number;
  };
}

export interface AnalyticsStats {
  readonly totalQueries: number;
  readonly participantQueries: number;
  readonly conflictQueries: number;
  readonly workloadQueries: number;
  readonly effectivenessQueries: number;
  readonly outcomeQueries: number;
}

// ---------------------------------------------------------------------------
// Orchestration action vocabulary (matches metadata.action on timeline entries
// of type "orchestration"). Defined here so analytics and the m11-2
// subsystems share a single vocabulary.
// ---------------------------------------------------------------------------

const ORCH_ACTIONS = {
  conflictDetected: "conflict_detected",
  conflictAutoResolved: "conflict_auto_resolved",
  conflictParticipantDecided: "conflict_participant_decided",
  mergeMissions: "merge_missions",
  crossProgramMission: "cross_program_mission",
  workloadReduction: "workload_reduction",
  sharedMeasurement: "shared_measurement",
  removeDuplicate: "remove_duplicate",
  unifiedGoal: "unified_goal",
  delayRecommendation: "delay_recommendation",
  priorityOverride: "priority_override",
} as const;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class OrchestrationAnalytics {
  private readonly queries = {
    total: 0,
    participant: 0,
    conflict: 0,
    workload: 0,
    effectiveness: 0,
    outcome: 0,
  };

  /** Aggregate orchestration analytics for a single participant. */
  getParticipantAnalytics(participantId: AccountId): ParticipantAnalytics {
    this.queries.total++;
    this.queries.participant++;

    const computedAt = getClock().iso();
    const timeline = getTimeline();
    const allEntries = timeline.get(participantId);

    // Installed programs = distinct programId values across timeline entries.
    const installedPrograms: ProgramId[] = [
      ...new Set(
        allEntries
          .map((e) => e.programId)
          .filter((p): p is ProgramId => p != null),
      ),
    ];

    // Orchestration entries carry conflict / coordination metadata.
    const orchestrationEntries = allEntries.filter((e) => e.type === "orchestration");
    const conflictsDetected = this.countByAction(orchestrationEntries, ORCH_ACTIONS.conflictDetected);
    const conflictsResolved =
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.conflictAutoResolved) +
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.conflictParticipantDecided);
    const crossProgramMissions =
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.crossProgramMission) +
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.mergeMissions);
    const coordinationDecisions = orchestrationEntries.length;
    const measurementDeduplications =
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.sharedMeasurement) +
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.removeDuplicate);

    // Shared measurements + goals.
    let sharedMeasurements = 0;
    try {
      sharedMeasurements = getSharedMeasurements().list(participantId).length;
    } catch { /* skip */ }

    let sharedGoals = 0;
    let achievedGoals = 0;
    try {
      const goals = getSharedGoals().list(participantId);
      sharedGoals = goals.length;
      achievedGoals = goals.filter((g) => g.achieved).length;
    } catch { /* skip */ }

    // Twin: fatigue + risks + workload trend.
    let fatigueScore = 0;
    let riskCount = 0;
    const workloadTrend: ParticipantAnalytics["workloadTrend"] = [];
    try {
      const twin = getTwin().get(participantId);
      if (twin) {
        fatigueScore = twin.fatigueScore;
        riskCount = twin.riskIndicators.length;
        for (const pp of twin.state.programProgress) {
          const level: ParticipantAnalytics["workloadTrend"][number]["level"] =
            pp.activeMissions > 5 ? "overloaded" : pp.activeMissions > 3 ? "heavy" : pp.activeMissions > 1 ? "moderate" : "light";
          workloadTrend.push({ timestamp: pp.lastActive, level });
        }
      }
    } catch { /* skip */ }

    // Augment workload trend with context data, if available.
    try {
      const ctx = getContext().get(participantId);
      if (ctx) {
        workloadTrend.push({
          timestamp: ctx.updatedAt,
          level: ctx.todayWorkload.level,
        });
        fatigueScore = Math.max(fatigueScore, ctx.fatigueScore);
        riskCount = Math.max(riskCount, ctx.currentRisks.length);
      }
    } catch { /* skip */ }

    return {
      participantId,
      computedAt,
      installedPrograms,
      conflictsDetected,
      conflictsResolved,
      crossProgramMissions,
      sharedMeasurements,
      sharedGoals,
      achievedGoals,
      timelineEntries: allEntries.length,
      coordinationDecisions,
      workloadTrend: workloadTrend.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
      fatigueScore,
      riskCount,
      measurementDeduplications,
    };
  }

  /** Global conflict analytics, computed from every participant's timeline. */
  getConflictAnalytics(): ConflictAnalytics {
    this.queries.total++;
    this.queries.conflict++;

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let total = 0;
    let autoResolved = 0;
    let overridden = 0;

    // Iterate ALL orchestration entries across all participants.
    const allEntries = getTimeline().getAllEntries();
    for (const e of allEntries) {
      if (e.type !== "orchestration") continue;
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      const action = typeof meta.action === "string" ? meta.action : "";
      if (!action.startsWith("conflict_")) continue;
      total++;
      const ctype = typeof meta.conflictType === "string" ? meta.conflictType : "unknown";
      const csev = typeof meta.severity === "string" ? meta.severity : "unknown";
      byType[ctype] = (byType[ctype] ?? 0) + 1;
      bySeverity[csev] = (bySeverity[csev] ?? 0) + 1;
      if (action === ORCH_ACTIONS.conflictAutoResolved) autoResolved++;
      if (action === ORCH_ACTIONS.conflictParticipantDecided) overridden++;
    }

    return {
      totalConflicts: total,
      byType,
      bySeverity,
      autoResolvedCount: autoResolved,
      participantOverrideCount: overridden,
      autoResolvedRate: total > 0 ? autoResolved / total : 0,
      participantOverrideRate: total > 0 ? overridden / total : 0,
    };
  }

  /** Global workload analytics, computed from timeline workload entries + twins. */
  getWorkloadAnalytics(): WorkloadAnalytics {
    this.queries.total++;
    this.queries.workload++;

    const distributionByLevel: Record<string, number> = {
      light: 0,
      moderate: 0,
      heavy: 0,
      overloaded: 0,
      unknown: 0,
    };
    let totalMinutes = 0;
    let totalPhysical = 0;
    let totalMental = 0;
    let overloadedCount = 0;
    let totalAssessments = 0;

    // 1) Workload-reduction orchestration entries indicate prior overload.
    const allEntries = getTimeline().getAllEntries();
    for (const e of allEntries) {
      if (e.type !== "orchestration") continue;
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      const action = typeof meta.action === "string" ? meta.action : "";
      if (action !== ORCH_ACTIONS.workloadReduction) continue;
      const level = typeof meta.level === "string" ? meta.level : "unknown";
      distributionByLevel[level] = (distributionByLevel[level] ?? 0) + 1;
      if (level === "overloaded") overloadedCount++;
      totalMinutes += typeof meta.totalMinutes === "number" ? meta.totalMinutes : 0;
      totalPhysical += typeof meta.physicalEffort === "number" ? meta.physicalEffort : 0;
      totalMental += typeof meta.mentalEffort === "number" ? meta.mentalEffort : 0;
      totalAssessments++;
    }

    // 2) Augment with each participant twin's fatigue-derived level.
    try {
      for (const t of getTwin().listTwins()) {
        const level: "light" | "moderate" | "heavy" | "overloaded" =
          t.fatigueScore >= 75 ? "overloaded" : t.fatigueScore >= 50 ? "heavy" : t.fatigueScore >= 25 ? "moderate" : "light";
        distributionByLevel[level] = (distributionByLevel[level] ?? 0) + 1;
        if (level === "overloaded") overloadedCount++;
        totalAssessments++;
      }
    } catch { /* TwinManager unavailable — skip */ }

    return {
      distributionByLevel,
      avgMinutes: totalAssessments > 0 ? totalMinutes / totalAssessments : 0,
      avgPhysicalEffort: totalAssessments > 0 ? totalPhysical / totalAssessments : 0,
      avgMentalEffort: totalAssessments > 0 ? totalMental / totalAssessments : 0,
      overloadedCount,
      overloadedRate: totalAssessments > 0 ? overloadedCount / totalAssessments : 0,
      totalAssessments,
    };
  }

  /**
   * Measures how well the orchestrator is doing globally. Computed from real
   * timeline events + shared measurements + shared goals.
   */
  getCoordinationEffectiveness(): CoordinationEffectiveness {
    this.queries.total++;
    this.queries.effectiveness++;

    const allEntries = getTimeline().getAllEntries();
    const orchestrationEntries = allEntries.filter((e) => e.type === "orchestration");
    const missionEntries = allEntries.filter((e) => e.type === "mission");

    const missionsMerged = this.countByAction(orchestrationEntries, ORCH_ACTIONS.mergeMissions) +
      this.countByAction(orchestrationEntries, ORCH_ACTIONS.crossProgramMission);
    const conflictsAutoResolved = this.countByAction(orchestrationEntries, ORCH_ACTIONS.conflictAutoResolved);
    const totalConflicts = this.countByActionStartsWith(orchestrationEntries, "conflict_");
    const participantOverrides = this.countByAction(orchestrationEntries, ORCH_ACTIONS.conflictParticipantDecided);

    const missionsMergedRate = missionEntries.length > 0 ? missionsMerged / missionEntries.length : 0;
    const autoResolvedRate = totalConflicts > 0 ? conflictsAutoResolved / totalConflicts : 0;
    const overrideRate = totalConflicts > 0 ? participantOverrides / totalConflicts : 0;

    // Measurements deduplicated rate.
    let measurementsDeduplicatedRate = 0;
    try {
      const smStats = getSharedMeasurements().getStats();
      const denom = smStats.totalConsumptions + smStats.deduplicationSavings;
      measurementsDeduplicatedRate = denom > 0 ? smStats.deduplicationSavings / denom : 0;
    } catch { /* skip */ }

    // Shared goals → goal coordination.
    let sharedGoalsActive = 0;
    let sharedGoalsAchieved = 0;
    try {
      const goalStats = getSharedGoals().getStats();
      sharedGoalsActive = goalStats.activeCount;
      sharedGoalsAchieved = goalStats.achievedCount;
    } catch { /* skip */ }

    // Composite effectiveness score (0-100). Higher = better coordination.
    const score =
      (missionsMergedRate * 25) +
      (autoResolvedRate * 25) +
      (measurementsDeduplicatedRate * 25) +
      ((1 - overrideRate) * 25);

    return {
      missionsMerged,
      missionsMergedRate,
      conflictsAutoResolvedRate: autoResolvedRate,
      measurementsDeduplicatedRate,
      participantOverrideRate: overrideRate,
      sharedGoalsActive,
      sharedGoalsAchieved,
      overallScore: Math.round(score * 100) / 100,
    };
  }

  /**
   * Compare outcomes before orchestration (isolated programs) vs after
   * (coordinated). Uses historical timeline data: the orchestration start is
   * the first timeline entry of type "orchestration"; everything before is
   * "before", everything after is "after". REAL comparison.
   */
  getOutcomeComparison(participantId: AccountId): OutcomeComparison {
    this.queries.total++;
    this.queries.outcome++;

    const timeline = getTimeline();
    const entries = timeline.get(participantId);
    // Timeline is sorted newest-first; find the OLDEST orchestration entry
    // as the orchestration start point.
    const orchestrationEntries = entries.filter((e) => e.type === "orchestration");
    const oldestOrch = orchestrationEntries.length > 0
      ? orchestrationEntries[orchestrationEntries.length - 1]
      : undefined;
    const orchestrationStart = oldestOrch?.timestamp ?? null;

    let beforeEntries = entries;
    let afterEntries: UnifiedTimelineEntry[] = [];
    if (orchestrationStart) {
      beforeEntries = entries.filter((e) => e.timestamp < orchestrationStart);
      afterEntries = entries.filter((e) => e.timestamp >= orchestrationStart);
    }

    const compute = (subset: readonly UnifiedTimelineEntry[]) => {
      const missions = subset.filter((e) => e.type === "mission");
      const completed = missions.filter((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        return meta.state === "completed" || /\(completed\)/i.test(e.title);
      }).length;
      const attempted = missions.filter((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        return typeof meta.state === "string" && ["completed", "skipped", "expired"].includes(meta.state);
      }).length;
      const measurements = subset.filter((e) => e.type === "measurement").length;
      const completionRate = attempted > 0 ? completed / attempted : 0;
      const timestamps = subset.map((e) => e.timestamp).sort();
      const duration = timestamps.length > 1
        ? `${timestamps[0]} → ${timestamps[timestamps.length - 1]}`
        : null;
      return {
        missionCompletionRate: completionRate,
        measurementCount: measurements,
        timelineEntries: subset.length,
        duration,
      };
    };

    const before = compute(beforeEntries);
    const after = compute(afterEntries);

    return {
      participantId,
      computedAt: getClock().iso(),
      orchestrationStart,
      before,
      after,
      improvement: {
        missionCompletionDelta: after.missionCompletionRate - before.missionCompletionRate,
        measurementDelta: after.measurementCount - before.measurementCount,
        timelineDelta: after.timelineEntries - before.timelineEntries,
      },
    };
  }

  getStats(): AnalyticsStats {
    return {
      totalQueries: this.queries.total,
      participantQueries: this.queries.participant,
      conflictQueries: this.queries.conflict,
      workloadQueries: this.queries.workload,
      effectivenessQueries: this.queries.effectiveness,
      outcomeQueries: this.queries.outcome,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  /** Count orchestration entries whose metadata.action === action. */
  private countByAction(
    entries: readonly UnifiedTimelineEntry[],
    action: string,
  ): number {
    return entries.filter((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      return typeof meta.action === "string" && meta.action === action;
    }).length;
  }

  /** Count orchestration entries whose metadata.action starts with prefix. */
  private countByActionStartsWith(
    entries: readonly UnifiedTimelineEntry[],
    prefix: string,
  ): number {
    return entries.filter((e) => {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      return typeof meta.action === "string" && meta.action.startsWith(prefix);
    }).length;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: OrchestrationAnalytics | null = null;
export function getOrchestrationAnalytics(): OrchestrationAnalytics {
  if (!_engine) _engine = new OrchestrationAnalytics();
  return _engine;
}

// Re-export shared types for consumers
export type { AccountId, ProgramId } from "../core";
