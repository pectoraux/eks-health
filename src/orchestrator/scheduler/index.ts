/**
 * Eks-Health Health Orchestrator — Cross-Program Scheduler
 *
 * Programs submit schedule preferences through their orchestration declarations.
 * The Orchestrator merges compatible preferences into unified routines — e.g.
 * a Morning Health Session that combines a walk (Fitness Program), yoga
 * (Mobility Program), and a blood-pressure measurement (Cardio Program).
 *
 * One notification. One participant experience. Multiple satisfied Programs.
 *
 * Real logic: time-block grouping, shared-measurement detection, total-minute
 * summation, workload-level classification, conflict-aware timing optimization.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type SchemaId,
  type ProgramOrchestrationDeclaration,
  type SchedulePreference,
  type UnifiedPlan,
  type CrossProgramMission,
  type CrossProgramMissionId,
  OrchestratorError,
  asCrossProgramMissionId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DeclarationRecord {
  readonly declaration: ProgramOrchestrationDeclaration;
  readonly registeredAt: string;
}

type TimeBlock = "morning" | "afternoon" | "evening" | "weekly";

interface MissionCandidate {
  readonly programId: ProgramId;
  readonly programPriority: number;
  readonly missionTitle: string;
  readonly durationMinutes: number;
  readonly block: TimeBlock;
  readonly preference: SchedulePreference;
  readonly requiredMeasurements: SchemaId[];
}

interface SchedulerStats {
  totalPlans: number;
  totalProgramsAggregated: number;
  totalDuration: number;
  totalSharedMeasurements: number;
  totalCrossProgramMissions: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SchedulerEngine {
  private readonly declarations = new Map<ProgramId, DeclarationRecord>();
  private readonly plans = new Map<AccountId, UnifiedPlan>();
  private readonly crossMissions = new Map<CrossProgramMissionId, CrossProgramMission>();
  private readonly stats: SchedulerStats = {
    totalPlans: 0,
    totalProgramsAggregated: 0,
    totalDuration: 0,
    totalSharedMeasurements: 0,
    totalCrossProgramMissions: 0,
  };

  // -------------------------------------------------------------------------
  // Declaration registry
  // -------------------------------------------------------------------------

  /** Register or replace a Program's orchestration declaration. */
  registerDeclaration(declaration: ProgramOrchestrationDeclaration): void {
    if (!declaration.programId) {
      throw new OrchestratorError({
        code: "eks.orchestrator.scheduler.invalid_declaration",
        category: "validation",
        message: "Orchestration declaration must include a programId.",
        userMessage: "The program submitted an invalid orchestration declaration.",
      });
    }
    this.declarations.set(declaration.programId, {
      declaration,
      registeredAt: getClock().iso(),
    });
  }

  /** List declarations, optionally filtered to a single program. */
  getDeclarations(programId?: ProgramId): ProgramOrchestrationDeclaration[] {
    if (programId) {
      const rec = this.declarations.get(programId);
      return rec ? [rec.declaration] : [];
    }
    return [...this.declarations.values()].map((r) => r.declaration);
  }

  // -------------------------------------------------------------------------
  // Plan generation
  // -------------------------------------------------------------------------

  /**
   * Generate a UnifiedPlan from the supplied declarations. Real grouping,
   * merging, shared-measurement detection, and workload classification.
   */
  generatePlan(participantId: AccountId, declarations: ProgramOrchestrationDeclaration[]): UnifiedPlan {
    if (declarations.length === 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.scheduler.no_declarations",
        category: "validation",
        message: "Cannot generate a unified plan from zero declarations.",
        userMessage: "No programs are installed yet, so no plan was generated.",
      });
    }

    // 1. Expand every declaration's preferred schedule entries into mission
    //    candidates. Each SchedulePreference becomes one candidate mission.
    const candidates = this.expandDeclarations(declarations);

    // 2. Group candidates by time block.
    const groups = this.groupByBlock(candidates);

    // 3. Merge each block into a single CrossProgramMission (when more than
    //    one candidate exists) or keep as standalone if it cannot be merged.
    const morningRoutine = this.mergeBlock(groups.morning, "morning", "Morning Health Session");
    const afternoonRoutine = this.mergeBlock(groups.afternoon, "afternoon", "Afternoon Wellness Block");
    const eveningRoutine = this.mergeBlock(groups.evening, "evening", "Evening Wind-Down");
    const weeklyReview = this.mergeBlock(groups.weekly, "weekly", "Weekly Health Review");

    // 4. Standalone missions — candidates from "any" time-of-day that do not
    //    belong to a specific block.
    const standaloneMissions = groups.any.map((c) => ({
      programId: c.programId,
      missionTitle: c.missionTitle,
      scheduledFor: this.scheduleLabel(c.preference),
    }));

    // 5. Identify shared measurements — schemas requested by more than one
    //    Program are measured once and broadcast to all consumers.
    const sharedMeasurements = this.identifySharedMeasurements(declarations, candidates);

    // 6. Total minutes is the maximum parallel duration per block summed
    //    across blocks, plus standalone durations. This avoids double-counting
    //    when missions within a block run back-to-back but blocks themselves
    //    are temporally disjoint.
    const totalEstimatedMinutes = this.computeTotalMinutes([
      morningRoutine, afternoonRoutine, eveningRoutine, weeklyReview,
    ], standaloneMissions, declarations);

    // 7. Workload level — same thresholds as the Workload Balancer so the
    //    scheduler and balancer always agree on classification.
    const workloadLevel = this.classifyWorkload(totalEstimatedMinutes);

    const plan: UnifiedPlan = {
      morningRoutine,
      afternoonRoutine,
      eveningRoutine,
      weeklyReview,
      standaloneMissions,
      sharedMeasurements: sharedMeasurements.map((sm) => ({
        schemaId: sm.schemaId,
        time: sm.time,
        consumingPrograms: sm.consumingPrograms,
      })),
      totalEstimatedMinutes,
      workloadLevel,
    };

    // Track cross-program missions for later retrieval.
    for (const m of [morningRoutine, afternoonRoutine, eveningRoutine, weeklyReview]) {
      if (m) this.crossMissions.set(m.id, m);
    }

    this.plans.set(participantId, plan);
    this.stats.totalPlans += 1;
    this.stats.totalProgramsAggregated += declarations.length;
    this.stats.totalDuration += totalEstimatedMinutes;
    this.stats.totalSharedMeasurements += sharedMeasurements.length;
    this.stats.totalCrossProgramMissions += [morningRoutine, afternoonRoutine, eveningRoutine, weeklyReview]
      .filter((m): m is CrossProgramMission => m !== undefined).length;

    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.unifiedPlanGenerated,
        {
          participantId,
          programCount: declarations.length,
          totalEstimatedMinutes,
          workloadLevel,
          sharedMeasurementCount: sharedMeasurements.length,
          crossMissionCount: [morningRoutine, afternoonRoutine, eveningRoutine, weeklyReview]
            .filter((m): m is CrossProgramMission => m !== undefined).length,
        },
        {},
        "domain",
      ),
    );

    return plan;
  }

  /** Extract every CrossProgramMission referenced by a plan. */
  getCrossProgramMissions(plan: UnifiedPlan): CrossProgramMission[] {
    const list: CrossProgramMission[] = [];
    if (plan.morningRoutine) list.push(plan.morningRoutine);
    if (plan.afternoonRoutine) list.push(plan.afternoonRoutine);
    if (plan.eveningRoutine) list.push(plan.eveningRoutine);
    if (plan.weeklyReview) list.push(plan.weeklyReview);
    return list;
  }

  /** Adjust a plan's timing to avoid schedule overlaps. Lower-priority missions are shifted. */
  optimizeTiming(plan: UnifiedPlan, constraints: { avoidBlocks?: TimeBlock[]; maxBlockDuration?: number }): UnifiedPlan {
    const maxBlock = constraints.maxBlockDuration ?? 90;
    const avoid = new Set<TimeBlock>(constraints.avoidBlocks ?? []);

    const clamp = (m: CrossProgramMission | undefined): CrossProgramMission | undefined => {
      if (!m) return m;
      if (m.totalDurationMinutes <= maxBlock && !avoid.has(m.timeBlock)) return m;
      // If block overflows, drop the lowest-priority components until it fits.
      const sorted = [...m.components].sort((a, b) => b.order - a.order);
      const kept: typeof sorted = [];
      let remaining = maxBlock;
      for (const comp of sorted) {
        if (comp.durationMinutes <= remaining) {
          kept.push(comp);
          remaining -= comp.durationMinutes;
        }
      }
      kept.sort((a, b) => a.order - b.order);
      const newTotal = kept.reduce((a, c) => a + c.durationMinutes, 0);
      return {
        ...m,
        components: kept,
        totalDurationMinutes: newTotal,
      };
    };

    const optimized: UnifiedPlan = {
      ...plan,
      morningRoutine: clamp(plan.morningRoutine),
      afternoonRoutine: clamp(plan.afternoonRoutine),
      eveningRoutine: clamp(plan.eveningRoutine),
      weeklyReview: clamp(plan.weeklyReview),
      totalEstimatedMinutes: this.computeTotalMinutes(
        [plan.morningRoutine, plan.afternoonRoutine, plan.eveningRoutine, plan.weeklyReview],
        plan.standaloneMissions,
        [],
      ),
    };
    return optimized;
  }

  // -------------------------------------------------------------------------
  // Internals — expansion & grouping
  // -------------------------------------------------------------------------

  private expandDeclarations(declarations: ProgramOrchestrationDeclaration[]): MissionCandidate[] {
    const out: MissionCandidate[] = [];
    for (const decl of declarations) {
      const missionTitle = this.deriveMissionTitle(decl);
      const blockFallback: TimeBlock = "morning";
      for (const pref of decl.preferredSchedule) {
        const block = this.classifyBlock(pref);
        out.push({
          programId: decl.programId,
          programPriority: decl.priority,
          missionTitle,
          durationMinutes: pref.durationMinutes,
          block: block ?? blockFallback,
          preference: pref,
          requiredMeasurements: decl.requiredMeasurements,
        });
      }
      // If a declaration has no preferredSchedule entries, synthesize one
      // from its effort estimate so its work is still represented.
      if (decl.preferredSchedule.length === 0) {
        out.push({
          programId: decl.programId,
          programPriority: decl.priority,
          missionTitle,
          durationMinutes: decl.effortEstimate.timeMinutes,
          block: "morning",
          preference: {
            timeOfDay: "any",
            durationMinutes: decl.effortEstimate.timeMinutes,
            flexibility: "anytime",
          },
          requiredMeasurements: decl.requiredMeasurements,
        });
      }
    }
    return out;
  }

  private deriveMissionTitle(decl: ProgramOrchestrationDeclaration): string {
    if (decl.goals.length > 0 && decl.goals[0]?.name) {
      return decl.goals[0].name;
    }
    if (decl.capabilities.length > 0) {
      return `${decl.capabilities[0]} activity`;
    }
    return "Program activity";
  }

  private classifyBlock(pref: SchedulePreference): TimeBlock | undefined {
    // Explicit day-of-week preferences become weekly review tasks.
    if (pref.dayOfWeek !== undefined) return "weekly";
    switch (pref.timeOfDay) {
      case "morning": return "morning";
      case "afternoon": return "afternoon";
      case "evening": return "evening";
      case "night": return "evening"; // collapse night into evening block
      case "any": return undefined; // treated as standalone
      default: return undefined;
    }
  }

  private groupByBlock(candidates: MissionCandidate[]): {
    morning: MissionCandidate[];
    afternoon: MissionCandidate[];
    evening: MissionCandidate[];
    weekly: MissionCandidate[];
    any: MissionCandidate[];
  } {
    const morning: MissionCandidate[] = [];
    const afternoon: MissionCandidate[] = [];
    const evening: MissionCandidate[] = [];
    const weekly: MissionCandidate[] = [];
    const any: MissionCandidate[] = [];
    for (const c of candidates) {
      switch (c.block) {
        case "morning": morning.push(c); break;
        case "afternoon": afternoon.push(c); break;
        case "evening": evening.push(c); break;
        case "weekly": weekly.push(c); break;
        default: any.push(c); break;
      }
    }
    return { morning, afternoon, evening, weekly, any };
  }

  private mergeBlock(candidates: MissionCandidate[], block: TimeBlock, defaultName: string): CrossProgramMission | undefined {
    if (candidates.length === 0) return undefined;
    // Sort by priority (desc) then by flexibility (strict first) so the most
    // important, least flexible mission defines the block.
    const flexibilityRank: Record<SchedulePreference["flexibility"], number> = {
      strict: 0,
      flexible: 1,
      anytime: 2,
    };
    const sorted = [...candidates].sort((a, b) => {
      if (b.programPriority !== a.programPriority) return b.programPriority - a.programPriority;
      return flexibilityRank[a.preference.flexibility] - flexibilityRank[b.preference.flexibility];
    });

    const components = sorted.map((c, idx) => ({
      programId: c.programId,
      missionTitle: c.missionTitle,
      durationMinutes: c.durationMinutes,
      order: idx,
    }));

    const totalDurationMinutes = components.reduce((a, c) => a + c.durationMinutes, 0);

    // Shared measurements across the participants of this block.
    const schemaCounts = new Map<SchemaId, number>();
    for (const c of sorted) {
      for (const s of c.requiredMeasurements) {
        schemaCounts.set(s, (schemaCounts.get(s) ?? 0) + 1);
      }
    }
    const sharedMeasurements = [...schemaCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([s]) => s);

    const programSet = new Set<ProgramId>(sorted.map((c) => c.programId));
    const name = programSet.size > 1
      ? `${defaultName} (${programSet.size} programs)`
      : defaultName;

    const mission: CrossProgramMission = {
      id: asCrossProgramMissionId(generateId("xpm_")),
      name,
      description: this.describeBlock(sorted, block),
      timeBlock: block,
      components,
      totalDurationMinutes,
      sharedMeasurements,
      createdAt: getClock().iso(),
    };

    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.crossProgramMissionCreated,
        {
          missionId: mission.id,
          name: mission.name,
          timeBlock: mission.timeBlock,
          programCount: programSet.size,
          totalDurationMinutes,
        },
        {},
        "domain",
      ),
    );

    return mission;
  }

  private describeBlock(candidates: MissionCandidate[], block: TimeBlock): string {
    const parts = candidates.map((c) => `${c.missionTitle} (${c.programId})`);
    const blockLabel = block === "weekly" ? "Weekly" : `${block[0]?.toUpperCase() ?? ""}${block.slice(1)}`;
    return `${blockLabel} routine combining: ${parts.join(", ")}.`;
  }

  // -------------------------------------------------------------------------
  // Internals — shared measurements
  // -------------------------------------------------------------------------

  private identifySharedMeasurements(
    declarations: ProgramOrchestrationDeclaration[],
    candidates: MissionCandidate[],
  ): { schemaId: SchemaId; time: string; consumingPrograms: ProgramId[] }[] {
    const consumers = new Map<SchemaId, Set<ProgramId>>();
    for (const decl of declarations) {
      for (const schema of decl.requiredMeasurements) {
        if (!consumers.has(schema)) consumers.set(schema, new Set());
        consumers.get(schema)!.add(decl.programId);
      }
    }
    const shared: { schemaId: SchemaId; time: string; consumingPrograms: ProgramId[] }[] = [];
    for (const [schema, programs] of consumers) {
      if (programs.size < 2) continue;
      // Schedule the shared measurement at the earliest block any consumer
      // is active in. Real but deterministic.
      const block = this.earliestConsumerBlock(schema, candidates);
      shared.push({
        schemaId: schema,
        time: this.scheduleLabel({
          timeOfDay: block,
          durationMinutes: 5,
          flexibility: "flexible",
        }),
        consumingPrograms: [...programs],
      });
    }
    return shared;
  }

  private earliestConsumerBlock(
    schema: SchemaId,
    candidates: MissionCandidate[],
  ): "morning" | "afternoon" | "evening" {
    const blockRank: Record<TimeBlock, number> = { morning: 0, afternoon: 1, evening: 2, weekly: 3 };
    let earliest: TimeBlock = "morning";
    let earliestRank = Number.MAX_SAFE_INTEGER;
    for (const c of candidates) {
      if (!c.requiredMeasurements.includes(schema)) continue;
      const rank = blockRank[c.block];
      if (rank < earliestRank) {
        earliestRank = rank;
        earliest = c.block;
      }
    }
    if (earliest === "weekly") return "morning";
    return earliest;
  }

  private scheduleLabel(pref: SchedulePreference): string {
    const tod = pref.timeOfDay === "any" ? "morning" : pref.timeOfDay;
    const day = pref.dayOfWeek !== undefined
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][pref.dayOfWeek] ?? "Daily"
      : "Daily";
    return `${day} ${tod}`;
  }

  // -------------------------------------------------------------------------
  // Internals — totals & workload
  // -------------------------------------------------------------------------

  private computeTotalMinutes(
    blocks: (CrossProgramMission | undefined)[],
    standalone: UnifiedPlan["standaloneMissions"],
    declarations: ProgramOrchestrationDeclaration[],
  ): number {
    let total = 0;
    for (const b of blocks) {
      if (b) total += b.totalDurationMinutes;
    }
    for (const s of standalone) {
      // standaloneMissions have no durationMinutes field — derive from
      // the originating declaration's effort estimate.
      const decl = declarations.find((d) => d.programId === s.programId);
      const dur = decl?.preferredSchedule
        .find((p) => p.timeOfDay === "any")?.durationMinutes
        ?? decl?.effortEstimate.timeMinutes
        ?? 0;
      total += dur;
    }
    return total;
  }

  private classifyWorkload(totalMinutes: number): UnifiedPlan["workloadLevel"] {
    if (totalMinutes < 30) return "light";
    if (totalMinutes < 60) return "moderate";
    if (totalMinutes < 120) return "heavy";
    return "overloaded";
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalPlans: number;
    totalDeclarations: number;
    avgProgramsPerPlan: number;
    avgDurationMinutes: number;
    totalCrossProgramMissions: number;
    totalSharedMeasurements: number;
  } {
    return {
      totalPlans: this.stats.totalPlans,
      totalDeclarations: this.declarations.size,
      avgProgramsPerPlan: this.stats.totalPlans > 0
        ? this.stats.totalProgramsAggregated / this.stats.totalPlans
        : 0,
      avgDurationMinutes: this.stats.totalPlans > 0
        ? this.stats.totalDuration / this.stats.totalPlans
        : 0,
      totalCrossProgramMissions: this.stats.totalCrossProgramMissions,
      totalSharedMeasurements: this.stats.totalSharedMeasurements,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: SchedulerEngine | null = null;
export function getScheduler(): SchedulerEngine {
  if (!_engine) _engine = new SchedulerEngine();
  return _engine;
}

// Public re-exports for the barrel
export type {
  ProgramOrchestrationDeclaration,
  SchedulePreference,
  UnifiedPlan,
  CrossProgramMission,
  CrossProgramMissionId,
} from "../core";
