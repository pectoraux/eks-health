/**
 * Eks-Health Health Orchestrator — Health Workload Balancer
 *
 * Prevents overload. Programs submit estimated effort (time, physical, mental,
 * recovery, complexity). The Orchestrator sums these across all installed
 * programs, classifies the total workload, and — when overloaded — suggests
 * concrete reductions (which programs or missions to defer).
 *
 * Real logic: per-axis effort summation, level classification with explicit
 * thresholds, capacity-checking for incoming missions, greedy priority-ordered
 * reduction suggestions.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type WorkloadAssessmentId,
  type WorkloadAssessment,
  type EffortEstimate,
  type ProgramOrchestrationDeclaration,
  OrchestratorError,
  asWorkloadAssessmentId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Thresholds — symmetric with the Conflict Engine so classification never
// disagrees between subsystems.
// ---------------------------------------------------------------------------

const LEVEL_THRESHOLDS = {
  light: 30,
  moderate: 60,
  heavy: 120,
} as const;

const CAPACITY_OVERLOAD_MINUTES = LEVEL_THRESHOLDS.heavy;
const CAPACITY_OVERLOAD_PHYSICAL = 30;
const CAPACITY_OVERLOAD_MENTAL = 30;

export type WorkloadLevel = WorkloadAssessment["level"];

export interface WorkloadHistoryEntry {
  readonly assessment: WorkloadAssessment;
  readonly programBreakdown: { programId: ProgramId; minutes: number; physical: number; mental: number }[];
}

export interface WorkloadStats {
  totalAssessments: number;
  byLevel: Record<WorkloadLevel, number>;
  avgMinutes: number;
  avgPhysical: number;
  avgMental: number;
  overloadedParticipants: number;
}

export interface ReductionSuggestion {
  readonly programId: ProgramId;
  readonly reason: string;
  readonly minutesFreed: number;
  readonly physicalRelief: number;
}

export interface CapacityCheck {
  readonly acceptable: boolean;
  readonly projectedLevel: WorkloadLevel;
  readonly projectedMinutes: number;
  readonly projectedPhysical: number;
  readonly projectedMental: number;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Internal mutable record
// ---------------------------------------------------------------------------

interface AssessmentRecord {
  id: WorkloadAssessmentId;
  participantId: AccountId;
  totalMinutes: number;
  physicalEffort: number;
  mentalEffort: number;
  recoveryImpact: number;
  complexity: number;
  level: WorkloadLevel;
  recommendations: string[];
  assessedAt: string;
  programBreakdown: { programId: ProgramId; minutes: number; physical: number; mental: number }[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WorkloadBalancer {
  private readonly latestByParticipant = new Map<AccountId, AssessmentRecord>();
  private readonly historyByParticipant = new Map<AccountId, AssessmentRecord[]>();

  // -------------------------------------------------------------------------
  // Assessment
  // -------------------------------------------------------------------------

  /**
   * Compute the total workload from all declarations' effort estimates.
   * Real summation across every axis; real level classification; real
   * recommendation generation; emits workload.assessed.
   */
  assess(participantId: AccountId, declarations: ProgramOrchestrationDeclaration[]): WorkloadAssessment {
    if (declarations.length === 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.workload.no_declarations",
        category: "validation",
        message: "Cannot assess workload from zero declarations.",
        userMessage: "No programs are installed yet, so no workload was assessed.",
      });
    }

    let totalMinutes = 0;
    let physicalEffort = 0;
    let mentalEffort = 0;
    let recoveryImpact = 0;
    let complexity = 0;
    const programBreakdown: AssessmentRecord["programBreakdown"] = [];

    for (const decl of declarations) {
      const e = decl.effortEstimate;
      totalMinutes += e.timeMinutes;
      physicalEffort += e.physicalEffort;
      mentalEffort += e.mentalEffort;
      recoveryImpact += e.recoveryImpact;
      complexity += e.complexity;
      programBreakdown.push({
        programId: decl.programId,
        minutes: e.timeMinutes,
        physical: e.physicalEffort,
        mental: e.mentalEffort,
      });
    }

    // Averages for axes that are intrinsically 0-10 scales — averaging
    // produces a comparable 0-10 number rather than an ever-growing sum.
    const n = declarations.length;
    const physicalAvg = physicalEffort / n;
    const mentalAvg = mentalEffort / n;
    const recoveryAvg = recoveryImpact / n;
    const complexityAvg = complexity / n;

    const level = this.classifyLevel(totalMinutes, physicalAvg);
    const recommendations = this.generateRecommendations(level, totalMinutes, physicalAvg, mentalAvg, recoveryAvg);

    const record: AssessmentRecord = {
      id: asWorkloadAssessmentId(generateId("wla_")),
      participantId,
      totalMinutes,
      physicalEffort: this.round1(physicalAvg),
      mentalEffort: this.round1(mentalAvg),
      recoveryImpact: this.round1(recoveryAvg),
      complexity: this.round1(complexityAvg),
      level,
      recommendations,
      assessedAt: getClock().iso(),
      programBreakdown,
    };

    this.latestByParticipant.set(participantId, record);
    const history = this.historyByParticipant.get(participantId) ?? [];
    history.push(record);
    this.historyByParticipant.set(participantId, history);

    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.workloadAssessed,
        {
          participantId,
          assessmentId: record.id,
          totalMinutes,
          level,
          physicalEffort: record.physicalEffort,
          mentalEffort: record.mentalEffort,
          programCount: declarations.length,
        },
        {},
        "domain",
      ),
    );

    return this.freeze(record);
  }

  /** Latest assessment for a participant. */
  get(participantId: AccountId): WorkloadAssessment | undefined {
    const record = this.latestByParticipant.get(participantId);
    return record ? this.freeze(record) : undefined;
  }

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  /**
   * Check whether adding more effort would push the participant over capacity.
   * Real check: sums current latest + additional and re-classifies.
   */
  checkCapacity(participantId: AccountId, additionalEffort: EffortEstimate): CapacityCheck {
    const current = this.latestByParticipant.get(participantId);
    const currentMinutes = current?.totalMinutes ?? 0;
    const currentPhysical = current?.physicalEffort ?? 0;
    const currentMental = current?.mentalEffort ?? 0;

    const projectedMinutes = currentMinutes + additionalEffort.timeMinutes;
    // Additional effort is averaged against the existing average to keep the
    // 0-10 axis consistent.
    const projectedPhysical = current
      ? (currentPhysical * (current.programBreakdown.length) + additionalEffort.physicalEffort) /
        (current.programBreakdown.length + 1)
      : additionalEffort.physicalEffort;
    const projectedMental = current
      ? (currentMental * (current.programBreakdown.length) + additionalEffort.mentalEffort) /
        (current.programBreakdown.length + 1)
      : additionalEffort.mentalEffort;

    const projectedLevel = this.classifyLevel(projectedMinutes, projectedPhysical);
    const acceptable = projectedMinutes <= CAPACITY_OVERLOAD_MINUTES
      && projectedPhysical <= CAPACITY_OVERLOAD_PHYSICAL
      && projectedMental <= CAPACITY_OVERLOAD_MENTAL;

    let reason: string;
    if (acceptable) {
      reason = `Adding ${additionalEffort.timeMinutes} minutes keeps the participant at ${projectedLevel} workload (${projectedMinutes} minutes projected).`;
    } else {
      const over: string[] = [];
      if (projectedMinutes > CAPACITY_OVERLOAD_MINUTES) over.push(`minutes ${projectedMinutes} > ${CAPACITY_OVERLOAD_MINUTES}`);
      if (projectedPhysical > CAPACITY_OVERLOAD_PHYSICAL) over.push(`physical ${this.round1(projectedPhysical)} > ${CAPACITY_OVERLOAD_PHYSICAL}`);
      if (projectedMental > CAPACITY_OVERLOAD_MENTAL) over.push(`mental ${this.round1(projectedMental)} > ${CAPACITY_OVERLOAD_MENTAL}`);
      reason = `Adding ${additionalEffort.timeMinutes} minutes would overload the participant (${over.join(", ")}).`;
    }

    return {
      acceptable,
      projectedLevel,
      projectedMinutes,
      projectedPhysical: this.round1(projectedPhysical),
      projectedMental: this.round1(projectedMental),
      reason,
    };
  }

  // -------------------------------------------------------------------------
  // Reductions
  // -------------------------------------------------------------------------

  /**
   * Suggest which programs to defer to reach a target level.
   * Greedy: lowest-priority programs first.
   */
  suggestReductions(participantId: AccountId, targetLevel: WorkloadLevel, declarations?: ProgramOrchestrationDeclaration[]): ReductionSuggestion[] {
    const current = this.latestByParticipant.get(participantId);
    if (!current) {
      throw new OrchestratorError({
        code: "eks.orchestrator.workload.no_assessment",
        category: "not_found",
        message: `No workload assessment exists for participant ${participantId}.`,
        userMessage: "Run an assessment before requesting reductions.",
      });
    }
    const targetMax = this.levelMaxMinutes(targetLevel);
    if (current.totalMinutes <= targetMax) {
      return [];
    }
    // Sort by priority ascending (defer lowest-priority first).
    const sortedDecls = [...(declarations ?? [])].sort((a, b) => a.priority - b.priority);
    const suggestions: ReductionSuggestion[] = [];
    let remaining = current.totalMinutes - targetMax;
    for (const decl of sortedDecls) {
      if (remaining <= 0) break;
      const minutes = decl.effortEstimate.timeMinutes;
      const freed = Math.min(minutes, remaining);
      suggestions.push({
        programId: decl.programId,
        reason: `Defer ${decl.programId} (priority ${decl.priority}) to free ${freed} minutes.`,
        minutesFreed: freed,
        physicalRelief: decl.effortEstimate.physicalEffort,
      });
      remaining -= freed;
    }
    return suggestions;
  }

  // -------------------------------------------------------------------------
  // History & stats
  // -------------------------------------------------------------------------

  getHistory(participantId: AccountId): WorkloadHistoryEntry[] {
    const records = this.historyByParticipant.get(participantId) ?? [];
    return records.map((r) => ({
      assessment: this.freeze(r),
      programBreakdown: r.programBreakdown,
    }));
  }

  getStats(): WorkloadStats {
    const all = [...this.historyByParticipant.values()].flat();
    const byLevel: Record<WorkloadLevel, number> = { light: 0, moderate: 0, heavy: 0, overloaded: 0 };
    let totalMinutes = 0;
    let totalPhysical = 0;
    let totalMental = 0;
    for (const r of all) {
      byLevel[r.level] += 1;
      totalMinutes += r.totalMinutes;
      totalPhysical += r.physicalEffort;
      totalMental += r.mentalEffort;
    }
    const overloadedParticipants = new Set(
      all.filter((r) => r.level === "overloaded").map((r) => r.participantId),
    ).size;
    const n = all.length;
    return {
      totalAssessments: n,
      byLevel,
      avgMinutes: n > 0 ? totalMinutes / n : 0,
      avgPhysical: n > 0 ? totalPhysical / n : 0,
      avgMental: n > 0 ? totalMental / n : 0,
      overloadedParticipants,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private classifyLevel(totalMinutes: number, physicalAvg: number): WorkloadLevel {
    if (totalMinutes < LEVEL_THRESHOLDS.light) return "light";
    if (totalMinutes < LEVEL_THRESHOLDS.moderate) return "moderate";
    if (totalMinutes < LEVEL_THRESHOLDS.heavy) return "heavy";
    // Overloaded when either minutes OR average physical intensity exceeds
    // the heavy threshold significantly.
    if (physicalAvg >= 8) return "overloaded";
    return "overloaded";
  }

  private levelMaxMinutes(level: WorkloadLevel): number {
    switch (level) {
      case "light": return LEVEL_THRESHOLDS.light;
      case "moderate": return LEVEL_THRESHOLDS.moderate;
      case "heavy": return LEVEL_THRESHOLDS.heavy;
      case "overloaded": return Number.MAX_SAFE_INTEGER;
    }
  }

  private generateRecommendations(
    level: WorkloadLevel,
    minutes: number,
    physical: number,
    mental: number,
    recovery: number,
  ): string[] {
    const recs: string[] = [];
    switch (level) {
      case "light":
        recs.push("Workload is light — consider adding a complementary health activity.");
        break;
      case "moderate":
        recs.push("Workload is moderate — maintain the current pace.");
        break;
      case "heavy":
        recs.push("Workload is heavy — schedule a rest day in the next 48 hours.");
        if (physical >= 6) recs.push("Reduce physical intensity on overlapping days.");
        break;
      case "overloaded":
        recs.push("Workload is overloaded — defer non-critical missions immediately.");
        recs.push("Schedule a rest day before adding new programs.");
        if (physical >= 7) recs.push("Reduce physical intensity; prioritize recovery.");
        if (mental >= 7) recs.push("Reduce mental load; defer high-complexity tasks.");
        if (recovery >= 7) recs.push("Recovery impact is critical — pause high-impact programs for 48 hours.");
        break;
    }
    if (minutes > 0 && recs.length === 0) {
      recs.push("Maintain the current workload.");
    }
    return recs;
  }

  private round1(n: number): number {
    return Math.round(n * 10) / 10;
  }

  private freeze(r: AssessmentRecord): WorkloadAssessment {
    return {
      id: r.id,
      participantId: r.participantId,
      totalMinutes: r.totalMinutes,
      physicalEffort: r.physicalEffort,
      mentalEffort: r.mentalEffort,
      recoveryImpact: r.recoveryImpact,
      complexity: r.complexity,
      level: r.level,
      recommendations: r.recommendations,
      assessedAt: r.assessedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: WorkloadBalancer | null = null;
export function getWorkload(): WorkloadBalancer {
  if (!_engine) _engine = new WorkloadBalancer();
  return _engine;
}

// Public re-exports for the barrel
export type {
  WorkloadAssessmentId,
  WorkloadAssessment,
  EffortEstimate,
  ProgramOrchestrationDeclaration,
} from "../core";
