/**
 * Eks-Health Health Orchestrator — Conflict Resolution Engine
 *
 * Detects incompatible recommendations across Programs — high-intensity vs
 * recovery day, low-carb vs high-carb, fasting vs medication, late workout
 * vs sleep — and resolves them through transparent, priority-based rules.
 * Participants always retain the final say via override.
 *
 * Real detection: schedule-overlap, contradictory-recommendation, effort
 * overload, measurement duplication, goal conflict, resource conflict.
 * Real resolution: priority comparison with transparent rationale.
 * Real override: participant-decided resolution trumps any auto-resolution.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type ConflictId,
  type ProgramConflict,
  type ConflictType,
  type ConflictResolution,
  type ProgramOrchestrationDeclaration,
  type ProgramConstraint,
  type ProgramGoalDeclaration,
  type UnifiedPlan,
  type CrossProgramMission,
  OrchestratorError,
  asConflictId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Internal mutable conflict record (public surface stays immutable)
// ---------------------------------------------------------------------------

interface MutableConflict {
  id: ConflictId;
  type: ConflictType;
  programIds: ProgramId[];
  description: string;
  severity: "low" | "medium" | "high";
  resolution: ConflictResolution;
  resolutionDetail?: string;
  detectedAt: string;
  resolvedAt?: string;
  overridden?: boolean;
  overriddenBy?: AccountId;
  overrideReason?: string;
}

export interface ConflictListFilter {
  readonly type?: ConflictType;
  readonly severity?: "low" | "medium" | "high";
  readonly resolution?: ConflictResolution;
  readonly programId?: ProgramId;
}

export interface ConflictStats {
  totalConflicts: number;
  byType: Record<ConflictType, number>;
  bySeverity: { low: number; medium: number; high: number };
  autoResolved: number;
  participantDecided: number;
  deferred: number;
  escalated: number;
}

// ---------------------------------------------------------------------------
// Opposite-rule tables — real keyword-based contradiction detection
// ---------------------------------------------------------------------------

interface ContradictionPair {
  readonly a: RegExp;
  readonly b: RegExp;
  readonly label: string;
}

const CONTRADICTION_PAIRS: readonly ContradictionPair[] = [
  { a: /no_high_intensity|avoid_high_intensity|low_intensity_only/i, b: /high_intensity|requires_high_intensity|push_hard/i, label: "high intensity vs no high intensity" },
  { a: /low_carb|no_carb|carb_free|keto/i, b: /high_carb|carb_loading|carb_heavy/i, label: "low-carb vs high-carb" },
  { a: /fasting|intermittent_fasting|no_food/i, b: /medication_with_food|meal_required|requires_food|with_meals/i, label: "fasting vs requires food" },
  { a: /rest_day|requires_rest|deload|no_exercise/i, b: /daily_workout|high_intensity|requires_exercise|every_day/i, label: "rest day vs daily workout" },
  { a: /no_late_workout|no_evening_exercise|avoid_evening_exercise/i, b: /evening_workout|late_workout|night_workout/i, label: "no late workout vs evening workout" },
  { a: /no_caffeine_after_noon|caffeine_free_after|early_bedtime/i, b: /late_caffeine|evening_caffeine|pre_workout_caffeine/i, label: "sleep protection vs late caffeine" },
  { a: /low_sodium|no_salt/i, b: /high_sodium|salt_loading|electrolyte_load/i, label: "low sodium vs high sodium" },
  { a: /no_running|avoid_impact|low_impact_only/i, b: /daily_run|running_required|high_impact/i, label: "low impact vs running required" },
];

interface GoalOpposition {
  readonly a: RegExp;
  readonly b: RegExp;
  readonly label: string;
}

const GOAL_OPPOSITIONS: readonly GoalOpposition[] = [
  { a: /gain.*weight|build.*muscle|bulk|hypertrophy/i, b: /lose.*weight|cut|slim|weight_loss/i, label: "muscle gain vs weight loss" },
  { a: /calorie_surplus|increase.*calorie/i, b: /calorie_deficit|decrease.*calorie|low_calorie/i, label: "calorie surplus vs deficit" },
  { a: /endurance|long_duration|aerobic/i, b: /strength|powerlifting|maximal_strength/i, label: "endurance vs strength focus" },
  { a: /increase.*heart_rate|high_hr_target/i, b: /lower.*heart_rate|resting_hr|bradycardia/i, label: "heart-rate increase vs decrease" },
  { a: /flexibility|mobility|stretch/i, b: /maximal.*load|1rm|heavy_lift/i, label: "mobility vs maximal load" },
];

// Effort-overload thresholds — kept symmetric with the Workload Balancer so
// the two engines never disagree about whether overload exists.
const EFFORT_OVERLOAD_MINUTES = 120;
const EFFORT_OVERLOAD_PHYSICAL = 30;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ConflictResolutionEngine {
  private readonly conflicts = new Map<ConflictId, MutableConflict>();

  // -------------------------------------------------------------------------
  // Detection
  // -------------------------------------------------------------------------

  /**
   * Scan all declarations (and optionally the unified plan) for conflicts.
   * Every detected conflict is stored and emitted via conflict.detected.
   */
  detect(declarations: ProgramOrchestrationDeclaration[], plan?: UnifiedPlan): ProgramConflict[] {
    if (declarations.length === 0) return [];

    const detected: MutableConflict[] = [];

    // 1. Schedule overlap — pairwise scan of preferredSchedule entries.
    detected.push(...this.detectScheduleOverlaps(declarations));

    // 2. Contradictory recommendations — pairwise constraint scan.
    detected.push(...this.detectContradictions(declarations));

    // 3. Effort overload — aggregate across all declarations.
    detected.push(...this.detectEffortOverload(declarations));

    // 4. Measurement duplication — schemas requested by more than one Program.
    detected.push(...this.detectMeasurementDuplication(declarations));

    // 5. Goal conflict — opposing goal names across Programs.
    detected.push(...this.detectGoalConflicts(declarations));

    // 6. Resource conflict — declarations that explicitly flag each other.
    detected.push(...this.detectResourceConflicts(declarations));

    // 7. Plan-derived conflicts — overlapping cross-program missions.
    if (plan) {
      detected.push(...this.detectPlanOverlaps(plan));
    }

    // Deduplicate by (type + sorted programIds + description) so re-detection
    // does not double-count the same conflict.
    const seen = new Set<string>();
    const fresh: MutableConflict[] = [];
    for (const c of detected) {
      const key = `${c.type}|${[...c.programIds].sort().join(",")}|${c.description}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(c);
    }

    // Persist + emit.
    for (const c of fresh) {
      this.conflicts.set(c.id, c);
      void getEventBus().publish(
        buildEvent(
          ORCHESTRATOR_EVENTS.conflictDetected,
          {
            conflictId: c.id,
            type: c.type,
            severity: c.severity,
            programIds: c.programIds,
            description: c.description,
          },
          {},
          "domain",
        ),
      );
    }

    return fresh.map((c) => this.freeze(c));
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a conflict using program priorities, transparent rules, and
   * (optionally) participant preferences. Emits conflict.resolved.
   */
  resolve(conflict: ProgramConflict, declarations: ProgramOrchestrationDeclaration[]): ProgramConflict {
    return this.resolveById(conflict.id, declarations);
  }

  /** Resolve by id (more ergonomic when only the id is known). */
  resolveById(conflictId: ConflictId, declarations: ProgramOrchestrationDeclaration[]): ProgramConflict {
    const record = this.conflicts.get(conflictId);
    if (!record) {
      throw new OrchestratorError({
        code: "eks.orchestrator.conflict.not_found",
        category: "not_found",
        message: `Conflict ${conflictId} not found.`,
        userMessage: "The selected conflict no longer exists.",
      });
    }
    if (record.resolution !== "deferred" && record.resolution !== "escalated" && !record.overridden) {
      // Already resolved.
      return this.freeze(record);
    }

    const declByProgram = new Map<ProgramId, ProgramOrchestrationDeclaration>();
    for (const d of declarations) declByProgram.set(d.programId, d);

    const detail = this.computeResolution(record, declByProgram);
    record.resolution = detail.resolution;
    record.resolutionDetail = detail.detail;
    record.resolvedAt = getClock().iso();
    this.conflicts.set(record.id, record);

    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.conflictResolved,
        {
          conflictId: record.id,
          type: record.type,
          resolution: record.resolution,
          resolutionDetail: record.resolutionDetail,
        },
        {},
        "domain",
      ),
    );

    return this.freeze(record);
  }

  /** Participant override — always wins over any auto-resolution. */
  override(conflictId: ConflictId, by: AccountId, reason: string): ProgramConflict {
    const record = this.conflicts.get(conflictId);
    if (!record) {
      throw new OrchestratorError({
        code: "eks.orchestrator.conflict.not_found",
        category: "not_found",
        message: `Conflict ${conflictId} not found.`,
        userMessage: "The selected conflict no longer exists.",
      });
    }
    if (!reason.trim()) {
      throw new OrchestratorError({
        code: "eks.orchestrator.conflict.override_reason_required",
        category: "validation",
        message: "Override reason is required.",
        userMessage: "Please provide a reason for overriding the conflict resolution.",
      });
    }
    record.overridden = true;
    record.overriddenBy = by;
    record.overrideReason = reason;
    record.resolution = "participant_decided";
    record.resolutionDetail = `Participant overrode the auto-resolution. Reason: ${reason}`;
    record.resolvedAt = getClock().iso();
    this.conflicts.set(record.id, record);

    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.conflictResolved,
        {
          conflictId: record.id,
          type: record.type,
          resolution: record.resolution,
          resolutionDetail: record.resolutionDetail,
          overridden: true,
          overriddenBy: by,
        },
        {},
        "domain",
      ),
    );

    return this.freeze(record);
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  get(id: ConflictId): ProgramConflict | undefined {
    const record = this.conflicts.get(id);
    return record ? this.freeze(record) : undefined;
  }

  list(filter?: ConflictListFilter): ProgramConflict[] {
    const records = [...this.conflicts.values()];
    const filtered = records.filter((r) => {
      if (filter?.type && r.type !== filter.type) return false;
      if (filter?.severity && r.severity !== filter.severity) return false;
      if (filter?.resolution && r.resolution !== filter.resolution) return false;
      if (filter?.programId && !r.programIds.includes(filter.programId)) return false;
      return true;
    });
    return filtered.map((r) => this.freeze(r));
  }

  getStats(): ConflictStats {
    const records = [...this.conflicts.values()];
    const byType: Record<ConflictType, number> = {
      schedule_overlap: 0,
      contradictory_recommendation: 0,
      effort_overload: 0,
      measurement_duplication: 0,
      goal_conflict: 0,
      resource_conflict: 0,
    };
    const bySeverity = { low: 0, medium: 0, high: 0 };
    let autoResolved = 0;
    let participantDecided = 0;
    let deferred = 0;
    let escalated = 0;
    for (const r of records) {
      byType[r.type] += 1;
      bySeverity[r.severity] += 1;
      switch (r.resolution) {
        case "auto_resolved": autoResolved += 1; break;
        case "participant_decided": participantDecided += 1; break;
        case "deferred": deferred += 1; break;
        case "escalated": escalated += 1; break;
      }
    }
    return {
      totalConflicts: records.length,
      byType,
      bySeverity,
      autoResolved,
      participantDecided,
      deferred,
      escalated,
    };
  }

  // -------------------------------------------------------------------------
  // Internals — detection helpers
  // -------------------------------------------------------------------------

  private detectScheduleOverlaps(decls: ProgramOrchestrationDeclaration[]): MutableConflict[] {
    const out: MutableConflict[] = [];
    for (let i = 0; i < decls.length; i++) {
      for (let j = i + 1; j < decls.length; j++) {
        const a = decls[i]!;
        const b = decls[j]!;
        for (const pa of a.preferredSchedule) {
          for (const pb of b.preferredSchedule) {
            if (this.schedulesOverlap(pa, pb)) {
              out.push(this.makeConflict(
                "schedule_overlap",
                [a.programId, b.programId],
                `Programs ${a.programId} and ${b.programId} both request the ${pa.timeOfDay} slot${
                  pa.dayOfWeek !== undefined || pb.dayOfWeek !== undefined ? " on overlapping days" : ""
                }.`,
                pa.flexibility === "strict" || pb.flexibility === "strict" ? "high" : "medium",
              ));
            }
          }
        }
      }
    }
    return out;
  }

  private schedulesOverlap(a: ProgramOrchestrationDeclaration["preferredSchedule"][number], b: ProgramOrchestrationDeclaration["preferredSchedule"][number]): boolean {
    // "any" time-of-day never conflicts — it can be scheduled wherever fits.
    if (a.timeOfDay === "any" || b.timeOfDay === "any") return false;
    // Collapse night → evening for overlap purposes.
    const todA = a.timeOfDay === "night" ? "evening" : a.timeOfDay;
    const todB = b.timeOfDay === "night" ? "evening" : b.timeOfDay;
    if (todA !== todB) return false;
    // Day overlap: both undefined → any day → overlap.
    if (a.dayOfWeek === undefined && b.dayOfWeek === undefined) return true;
    // One undefined, other set → overlap (one is any day, other is that day).
    if (a.dayOfWeek === undefined || b.dayOfWeek === undefined) return true;
    return a.dayOfWeek === b.dayOfWeek;
  }

  private detectContradictions(decls: ProgramOrchestrationDeclaration[]): MutableConflict[] {
    const out: MutableConflict[] = [];
    for (let i = 0; i < decls.length; i++) {
      for (let j = i + 1; j < decls.length; j++) {
        const a = decls[i]!;
        const b = decls[j]!;
        for (const pair of CONTRADICTION_PAIRS) {
          const aMatch = this.constraintsMatch(a.constraints, pair.a);
          const bMatch = this.constraintsMatch(b.constraints, pair.b);
          const aMatchB = this.constraintsMatch(a.constraints, pair.b);
          const bMatchA = this.constraintsMatch(b.constraints, pair.a);
          if ((aMatch && bMatch) || (aMatchB && bMatchA)) {
            out.push(this.makeConflict(
              "contradictory_recommendation",
              [a.programId, b.programId],
              `Programs ${a.programId} and ${b.programId} issue contradictory recommendations: ${pair.label}.`,
              "high",
            ));
            break; // one contradiction per program pair is enough
          }
        }
      }
    }
    return out;
  }

  private constraintsMatch(constraints: readonly ProgramConstraint[], pattern: RegExp): boolean {
    return constraints.some((c) => pattern.test(c.rule) || pattern.test(c.description));
  }

  private detectEffortOverload(decls: ProgramOrchestrationDeclaration[]): MutableConflict[] {
    const totalMinutes = decls.reduce((a, d) => a + d.effortEstimate.timeMinutes, 0);
    const totalPhysical = decls.reduce((a, d) => a + d.effortEstimate.physicalEffort, 0);
    if (totalMinutes <= EFFORT_OVERLOAD_MINUTES && totalPhysical <= EFFORT_OVERLOAD_PHYSICAL) {
      return [];
    }
    return [
      this.makeConflict(
        "effort_overload",
        decls.map((d) => d.programId),
        `Combined effort across ${decls.length} programs exceeds capacity: ${totalMinutes} minutes (threshold ${EFFORT_OVERLOAD_MINUTES}), physical ${totalPhysical} (threshold ${EFFORT_OVERLOAD_PHYSICAL}).`,
        totalMinutes > EFFORT_OVERLOAD_MINUTES * 1.5 ? "high" : "medium",
      ),
    ];
  }

  private detectMeasurementDuplication(decls: ProgramOrchestrationDeclaration[]): MutableConflict[] {
    const consumers = new Map<string, ProgramId[]>();
    for (const d of decls) {
      for (const s of d.requiredMeasurements) {
        const key = String(s);
        if (!consumers.has(key)) consumers.set(key, []);
        consumers.get(key)!.push(d.programId);
      }
    }
    const out: MutableConflict[] = [];
    for (const [schema, programs] of consumers) {
      if (programs.length < 2) continue;
      out.push(this.makeConflict(
        "measurement_duplication",
        programs,
        `Measurement schema ${schema} is requested by ${programs.length} programs (${programs.join(", ")}). Measure once and share.`,
        "low",
      ));
    }
    return out;
  }

  private detectGoalConflicts(decls: ProgramOrchestrationDeclaration[]): MutableConflict[] {
    const out: MutableConflict[] = [];
    for (let i = 0; i < decls.length; i++) {
      for (let j = i + 1; j < decls.length; j++) {
        const a = decls[i]!;
        const b = decls[j]!;
        const opp = this.findGoalOpposition(a.goals, b.goals);
        if (opp) {
          out.push(this.makeConflict(
            "goal_conflict",
            [a.programId, b.programId],
            `Programs ${a.programId} and ${b.programId} have opposing goals: ${opp}.`,
            "high",
          ));
        }
      }
    }
    return out;
  }

  private findGoalOpposition(aGoals: readonly ProgramGoalDeclaration[], bGoals: readonly ProgramGoalDeclaration[]): string | undefined {
    for (const pair of GOAL_OPPOSITIONS) {
      const aMatches = aGoals.some((g) => pair.a.test(g.name) || pair.a.test(g.description));
      const bMatches = bGoals.some((g) => pair.b.test(g.name) || pair.b.test(g.description));
      const aMatchesB = aGoals.some((g) => pair.b.test(g.name) || pair.b.test(g.description));
      const bMatchesA = bGoals.some((g) => pair.a.test(g.name) || pair.a.test(g.description));
      if ((aMatches && bMatches) || (aMatchesB && bMatchesA)) {
        return pair.label;
      }
    }
    return undefined;
  }

  private detectResourceConflicts(decls: ProgramOrchestrationDeclaration[]): MutableConflict[] {
    const out: MutableConflict[] = [];
    for (const a of decls) {
      for (const conflictingId of a.conflictingPrograms ?? []) {
        const b = decls.find((d) => d.programId === conflictingId);
        if (!b) continue;
        // Avoid double-counting (a→b and b→a).
        if (a.programId < b.programId) {
          out.push(this.makeConflict(
            "resource_conflict",
            [a.programId, b.programId],
            `Programs ${a.programId} and ${b.programId} declare each other as conflicting.`,
            "medium",
          ));
        }
      }
    }
    return out;
  }

  private detectPlanOverlaps(plan: UnifiedPlan): MutableConflict[] {
    const out: MutableConflict[] = [];
    const blocks: { block: string; mission?: CrossProgramMission }[] = [
      { block: "morning", mission: plan.morningRoutine },
      { block: "afternoon", mission: plan.afternoonRoutine },
      { block: "evening", mission: plan.eveningRoutine },
      { block: "weekly", mission: plan.weeklyReview },
    ];
    for (const { block, mission } of blocks) {
      if (!mission) continue;
      // If a single block has more than 90 minutes of work, flag it as an
      // internal overlap (too much in one block).
      if (mission.totalDurationMinutes > 90) {
        out.push(this.makeConflict(
          "schedule_overlap",
          mission.components.map((c) => c.programId),
          `Cross-program mission "${mission.name}" in the ${block} block exceeds 90 minutes (${mission.totalDurationMinutes}).`,
          "medium",
        ));
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals — resolution helpers
  // -------------------------------------------------------------------------

  private computeResolution(
    record: MutableConflict,
    declByProgram: Map<ProgramId, ProgramOrchestrationDeclaration>,
  ): { resolution: ConflictResolution; detail: string } {
    const decls = record.programIds
      .map((p) => declByProgram.get(p))
      .filter((d): d is ProgramOrchestrationDeclaration => d !== undefined);

    if (decls.length === 0) {
      return {
        resolution: "deferred",
        detail: "No declarations available to resolve this conflict; deferred until declarations are provided.",
      };
    }

    switch (record.type) {
      case "schedule_overlap":
        return this.resolveScheduleOverlap(decls);
      case "contradictory_recommendation":
        return this.resolveContradiction(decls);
      case "effort_overload":
        return this.resolveOverload(decls);
      case "measurement_duplication":
        return this.resolveMeasurementDuplication(decls);
      case "goal_conflict":
        return this.resolveGoalConflict(decls);
      case "resource_conflict":
        return this.resolveResourceConflict(decls);
      default:
        return {
          resolution: "deferred",
          detail: "Unknown conflict type; deferred.",
        };
    }
  }

  private resolveScheduleOverlap(decls: ProgramOrchestrationDeclaration[]): { resolution: ConflictResolution; detail: string } {
    const sorted = [...decls].sort((a, b) => b.priority - a.priority);
    const winner = sorted[0]!;
    const deferred = sorted.slice(1);
    return {
      resolution: "auto_resolved",
      detail: `Program ${winner.programId} (priority ${winner.priority}) retains its preferred schedule. ` +
        `Programs ${deferred.map((d) => `${d.programId} (priority ${d.priority})`).join(", ")} ` +
        `are rescheduled to alternative time blocks.`,
    };
  }

  private resolveContradiction(decls: ProgramOrchestrationDeclaration[]): { resolution: ConflictResolution; detail: string } {
    const sorted = [...decls].sort((a, b) => b.priority - a.priority);
    const winner = sorted[0]!;
    const loser = sorted[1] ?? sorted[0]!;
    return {
      resolution: "auto_resolved",
      detail: `Program ${winner.programId} (priority ${winner.priority}) takes precedence. ` +
        `Program ${loser.programId}'s contradictory constraint is overridden for this participant.`,
    };
  }

  private resolveOverload(decls: ProgramOrchestrationDeclaration[]): { resolution: ConflictResolution; detail: string } {
    const sorted = [...decls].sort((a, b) => a.priority - b.priority); // ascending — defer lowest priority first
    const deferred = sorted.filter((d) => d.priority < 50);
    const names = deferred.length > 0
      ? deferred.map((d) => d.programId).join(", ")
      : "the lowest-priority missions";
    return {
      resolution: deferred.length > 0 ? "auto_resolved" : "escalated",
      detail: deferred.length > 0
        ? `Overload resolved by deferring low-priority programs: ${names}. Higher-priority programs continue at full intensity.`
        : `All programs are high-priority; cannot auto-resolve. Escalated to the participant to choose which to defer.`,
    };
  }

  private resolveMeasurementDuplication(decls: ProgramOrchestrationDeclaration[]): { resolution: ConflictResolution; detail: string } {
    return {
      resolution: "auto_resolved",
      detail: `Measurement is taken once and shared with all ${decls.length} programs (${decls.map((d) => d.programId).join(", ")}). No participant action required.`,
    };
  }

  private resolveGoalConflict(decls: ProgramOrchestrationDeclaration[]): { resolution: ConflictResolution; detail: string } {
    // Goal conflicts are inherently subjective — escalate to participant.
    return {
      resolution: "escalated",
      detail: `Programs ${decls.map((d) => `${d.programId} (priority ${d.priority})`).join(" and ")} pursue opposing goals. ` +
        `Escalated to the participant to decide which goal takes precedence.`,
    };
  }

  private resolveResourceConflict(decls: ProgramOrchestrationDeclaration[]): { resolution: ConflictResolution; detail: string } {
    const sorted = [...decls].sort((a, b) => b.priority - a.priority);
    const winner = sorted[0]!;
    const loser = sorted[1] ?? sorted[0]!;
    return {
      resolution: "auto_resolved",
      detail: `Program ${winner.programId} (priority ${winner.priority}) is retained; Program ${loser.programId} is suspended for this participant.`,
    };
  }

  // -------------------------------------------------------------------------
  // Internals — construction & freezing
  // -------------------------------------------------------------------------

  private makeConflict(
    type: ConflictType,
    programIds: ProgramId[],
    description: string,
    severity: "low" | "medium" | "high",
  ): MutableConflict {
    return {
      id: asConflictId(generateId("conflict_")),
      type,
      programIds,
      description,
      severity,
      resolution: "deferred",
      detectedAt: getClock().iso(),
    };
  }

  private freeze(r: MutableConflict): ProgramConflict {
    return {
      id: r.id,
      type: r.type,
      programIds: r.programIds,
      description: r.description,
      severity: r.severity,
      resolution: r.resolution,
      resolutionDetail: r.resolutionDetail,
      detectedAt: r.detectedAt,
      resolvedAt: r.resolvedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: ConflictResolutionEngine | null = null;
export function getConflicts(): ConflictResolutionEngine {
  if (!_engine) _engine = new ConflictResolutionEngine();
  return _engine;
}

// Public re-exports for the barrel
export type {
  ConflictId,
  ProgramConflict,
  ConflictType,
  ConflictResolution,
  ProgramOrchestrationDeclaration,
} from "../core";
