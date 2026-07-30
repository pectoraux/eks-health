/**
 * Eks-Health Health Orchestrator — Core Primitives
 *
 * Foundational types for the Health Orchestrator, Digital Twin, and
 * Cross-Program Intelligence. Programs remain independent but cooperate
 * through a neutral orchestration layer. No Program communicates directly
 * with another — the platform mediates all collaboration.
 *
 * Built on all prior milestones.
 */

import "server-only";
import type { Brand, CorrelationId, TraceId } from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";
import type { MeasurementId, SchemaId } from "@/health";

// ---------------------------------------------------------------------------
// Branded orchestrator identifiers
// ---------------------------------------------------------------------------

export type TwinId = Brand<string, "TwinId">;
export type OrchestrationSessionId = Brand<string, "OrchestrationSessionId">;
export type OrchestrationDecisionId = Brand<string, "OrchestrationDecisionId">;
export type ConflictId = Brand<string, "ConflictId">;
export type UnifiedTimelineId = Brand<string, "UnifiedTimelineId">;
export type SharedGoalId = Brand<string, "SharedGoalId">;
export type SharedMeasurementId = Brand<string, "SharedMeasurementId">;
export type CrossProgramMissionId = Brand<string, "CrossProgramMissionId">;
export type WorkloadAssessmentId = Brand<string, "WorkloadAssessmentId">;
export type CoordinatorDecisionId = Brand<string, "CoordinatorDecisionId">;
export type ProgramContributionId = Brand<string, "ProgramContributionId">;

export function asTwinId(s: string): TwinId { return s as TwinId; }
export function asOrchestrationSessionId(s: string): OrchestrationSessionId { return s as OrchestrationSessionId; }
export function asOrchestrationDecisionId(s: string): OrchestrationDecisionId { return s as OrchestrationDecisionId; }
export function asConflictId(s: string): ConflictId { return s as ConflictId; }
export function asUnifiedTimelineId(s: string): UnifiedTimelineId { return s as UnifiedTimelineId; }
export function asSharedGoalId(s: string): SharedGoalId { return s as SharedGoalId; }
export function asSharedMeasurementId(s: string): SharedMeasurementId { return s as SharedMeasurementId; }
export function asCrossProgramMissionId(s: string): CrossProgramMissionId { return s as CrossProgramMissionId; }
export function asWorkloadAssessmentId(s: string): WorkloadAssessmentId { return s as WorkloadAssessmentId; }
export function asCoordinatorDecisionId(s: string): CoordinatorDecisionId { return s as CoordinatorDecisionId; }
export function asProgramContributionId(s: string): ProgramContributionId { return s as ProgramContributionId; }

// ---------------------------------------------------------------------------
// Program orchestration declaration (what Programs expose to the Orchestrator)
// ---------------------------------------------------------------------------

export interface ProgramOrchestrationDeclaration {
  readonly programId: ProgramId;
  readonly capabilities: string[];
  readonly goals: ProgramGoalDeclaration[];
  readonly constraints: ProgramConstraint[];
  readonly dependencies: ProgramDependency[];
  readonly preferredSchedule: SchedulePreference[];
  readonly requiredMeasurements: SchemaId[];
  readonly expectedOutcomes: string[];
  readonly complementaryPrograms?: ProgramId[];
  readonly conflictingPrograms?: ProgramId[];
  readonly effortEstimate: EffortEstimate;
  readonly priority: number; // 0-100, higher = more important
}

export interface ProgramGoalDeclaration {
  readonly name: string;
  readonly description: string;
  readonly targetValue?: number;
  readonly unit?: string;
  readonly contributesTo?: string[]; // shared goal slugs
}

export interface ProgramConstraint {
  readonly type: "time" | "physical" | "mental" | "medical" | "dietary" | "sleep" | "custom";
  readonly description: string;
  readonly rule: string; // e.g. "no_high_intensity_after_8pm", "requires_rest_day"
}

export interface ProgramDependency {
  readonly type: "measurement" | "mission" | "program" | "technician" | "device";
  readonly description: string;
  readonly required: boolean;
}

export interface SchedulePreference {
  readonly timeOfDay: "morning" | "afternoon" | "evening" | "night" | "any";
  readonly dayOfWeek?: number; // 0-6
  readonly durationMinutes: number;
  readonly flexibility: "strict" | "flexible" | "anytime";
}

export interface EffortEstimate {
  readonly timeMinutes: number;
  readonly physicalEffort: number; // 0-10
  readonly mentalEffort: number; // 0-10
  readonly recoveryImpact: number; // 0-10
  readonly complexity: number; // 0-10
}

// ---------------------------------------------------------------------------
// Digital Health Twin
// ---------------------------------------------------------------------------

export interface DigitalHealthTwin {
  readonly id: TwinId;
  readonly participantId: AccountId;
  readonly state: TwinState;
  readonly lastUpdated: string;
  readonly version: number;
  readonly programContributions: ProgramContribution[];
  readonly riskIndicators: { name: string; level: "low" | "medium" | "high"; detail?: string }[];
  readonly goals: { name: string; progress: number; contributors: ProgramId[] }[];
  readonly preferences: Record<string, unknown>;
  readonly fatigueScore: number; // 0-100
  readonly travelStatus?: string;
  readonly offlineStatus: boolean;
}

export interface TwinState {
  readonly measurements: { schemaId: SchemaId; latestValue: unknown; trend: "up" | "down" | "stable"; timestamp: string }[];
  readonly programProgress: { programId: ProgramId; completionRate: number; activeMissions: number; lastActive: string }[];
  readonly missionCompletion: { totalAssigned: number; totalCompleted: number; streak: number };
  readonly competitionHistory: { competitionId: string; rank: number; score: number }[];
  readonly technicianObservations: { at: string; summary: string }[];
  readonly wearableData?: { source: string; lastSync: string; keyMetrics: Record<string, unknown> };
  readonly historicalTrends: { metric: string; values: { at: string; value: number }[] }[];
}

export interface ProgramContribution {
  readonly id: ProgramContributionId;
  readonly programId: ProgramId;
  readonly type: "measurement" | "mission" | "recommendation" | "goal" | "observation";
  readonly description: string;
  readonly value?: unknown;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Orchestration session & decisions
// ---------------------------------------------------------------------------

export type OrchestrationDecisionType =
  | "merge_missions"
  | "schedule_conflict"
  | "delay_recommendation"
  | "remove_duplicate"
  | "priority_override"
  | "workload_reduction"
  | "shared_measurement"
  | "unified_goal"
  | "cross_program_mission"
  | "participant_override";

export interface OrchestrationDecision {
  readonly id: OrchestrationDecisionId;
  readonly sessionId: OrchestrationSessionId;
  readonly type: OrchestrationDecisionType;
  readonly affectedPrograms: ProgramId[];
  readonly description: string;
  readonly rationale: string;
  readonly participantExplanation: string;
  readonly timestamp: string;
  readonly overridden?: boolean;
  readonly overriddenBy?: AccountId;
  readonly overriddenAt?: string;
}

export interface OrchestrationSession {
  readonly id: OrchestrationSessionId;
  readonly participantId: AccountId;
  readonly twinId: TwinId;
  readonly installedPrograms: ProgramId[];
  readonly decisions: OrchestrationDecision[];
  readonly unifiedPlan?: UnifiedPlan;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UnifiedPlan {
  readonly morningRoutine?: CrossProgramMission;
  readonly afternoonRoutine?: CrossProgramMission;
  readonly eveningRoutine?: CrossProgramMission;
  readonly weeklyReview?: CrossProgramMission;
  readonly standaloneMissions: { programId: ProgramId; missionTitle: string; scheduledFor: string }[];
  readonly sharedMeasurements: { schemaId: SchemaId; time: string; consumingPrograms: ProgramId[] }[];
  readonly totalEstimatedMinutes: number;
  readonly workloadLevel: "light" | "moderate" | "heavy" | "overloaded";
}

// ---------------------------------------------------------------------------
// Cross-program mission
// ---------------------------------------------------------------------------

export interface CrossProgramMission {
  readonly id: CrossProgramMissionId;
  readonly name: string;
  readonly description: string;
  readonly timeBlock: "morning" | "afternoon" | "evening" | "weekly";
  readonly components: { programId: ProgramId; missionTitle: string; durationMinutes: number; order: number }[];
  readonly totalDurationMinutes: number;
  readonly sharedMeasurements: SchemaId[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

export type ConflictType =
  | "schedule_overlap"
  | "contradictory_recommendation"
  | "effort_overload"
  | "measurement_duplication"
  | "goal_conflict"
  | "resource_conflict";

export type ConflictResolution = "auto_resolved" | "participant_decided" | "deferred" | "escalated";

export interface ProgramConflict {
  readonly id: ConflictId;
  readonly type: ConflictType;
  readonly programIds: ProgramId[];
  readonly description: string;
  readonly severity: "low" | "medium" | "high";
  readonly resolution: ConflictResolution;
  readonly resolutionDetail?: string;
  readonly detectedAt: string;
  readonly resolvedAt?: string;
}

// ---------------------------------------------------------------------------
// Health context (shared participant context)
// ---------------------------------------------------------------------------

export interface HealthContext {
  readonly participantId: AccountId;
  readonly currentGoals: { name: string; progress: number; source: ProgramId }[];
  readonly currentRisks: { name: string; level: "low" | "medium" | "high" }[];
  readonly todayWorkload: { totalMinutes: number; physicalEffort: number; mentalEffort: number; level: "light" | "moderate" | "heavy" };
  readonly recentMeasurements: { schemaId: SchemaId; value: unknown; at: string }[];
  readonly currentCompetitions: { competitionId: string; rank: number }[];
  readonly recentTechnicianVisits: { at: string; summary: string }[];
  readonly travelStatus?: string;
  readonly offlineStatus: boolean;
  readonly fatigueScore: number;
  readonly preferenceChanges: { key: string; oldValue: unknown; newValue: unknown; at: string }[];
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Unified timeline
// ---------------------------------------------------------------------------

export type TimelineEntryType =
  | "measurement"
  | "mission"
  | "competition"
  | "reward"
  | "appointment"
  | "research"
  | "installation"
  | "achievement"
  | "recommendation"
  | "milestone"
  | "orchestration"
  | "technician_visit";

export interface UnifiedTimelineEntry {
  readonly id: string;
  readonly type: TimelineEntryType;
  readonly timestamp: string;
  readonly title: string;
  readonly description: string;
  readonly programId?: ProgramId;
  readonly source: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UnifiedTimeline {
  readonly id: UnifiedTimelineId;
  readonly participantId: AccountId;
  readonly entries: UnifiedTimelineEntry[];
  readonly lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Shared goal
// ---------------------------------------------------------------------------

export interface SharedGoal {
  readonly id: SharedGoalId;
  readonly participantId: AccountId;
  readonly name: string;
  readonly description: string;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly unit?: string;
  readonly contributors: { programId: ProgramId; contribution: number; description: string }[];
  readonly progress: number; // 0-100
  readonly achieved: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Shared measurement
// ---------------------------------------------------------------------------

export interface SharedMeasurement {
  readonly id: SharedMeasurementId;
  readonly schemaId: SchemaId;
  readonly measurementId: MeasurementId;
  readonly participantId: AccountId;
  readonly measuredAt: string;
  readonly consumingPrograms: ProgramId[];
  readonly authorizedPrograms: ProgramId[];
}

// ---------------------------------------------------------------------------
// Workload assessment
// ---------------------------------------------------------------------------

export interface WorkloadAssessment {
  readonly id: WorkloadAssessmentId;
  readonly participantId: AccountId;
  readonly totalMinutes: number;
  readonly physicalEffort: number; // 0-10
  readonly mentalEffort: number; // 0-10
  readonly recoveryImpact: number; // 0-10
  readonly complexity: number; // 0-10
  readonly level: "light" | "moderate" | "heavy" | "overloaded";
  readonly recommendations: string[];
  readonly assessedAt: string;
}

// ---------------------------------------------------------------------------
// AI coordinator decision
// ---------------------------------------------------------------------------

export interface CoordinatorDecision {
  readonly id: CoordinatorDecisionId;
  readonly participantId: AccountId;
  readonly type: "merge" | "delay" | "remove" | "prioritize" | "balance" | "explain";
  readonly affectedPrograms: ProgramId[];
  readonly description: string;
  readonly rationale: string;
  readonly participantExplanation: string;
  readonly confidence: number; // 0-1
  readonly alternatives: { description: string; tradeoff: string }[];
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OrchestratorErrorCategory =
  | "not_found"
  | "validation"
  | "conflict_detected"
  | "overload"
  | "not_authorized"
  | "state_conflict";

export class OrchestratorError extends Error {
  readonly code: string;
  readonly category: OrchestratorErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: OrchestratorErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "OrchestratorError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "An orchestrator error occurred.";
    this.timestamp = new Date().toISOString();
    this.correlationId = opts.correlationId;
    this.traceId = opts.traceId;
    this.metadata = opts.metadata ?? {};
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name, code: this.code, category: this.category, retryable: this.retryable,
      userMessage: this.userMessage, message: this.message, timestamp: this.timestamp,
      correlationId: this.correlationId, traceId: this.traceId, metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator events
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_EVENTS = {
  twinUpdated: "eks.orchestrator.twin.updated",
  orchestrationStarted: "eks.orchestrator.session.started",
  orchestrationCompleted: "eks.orchestrator.session.completed",
  decisionMade: "eks.orchestrator.decision.made",
  decisionOverridden: "eks.orchestrator.decision.overridden",
  conflictDetected: "eks.orchestrator.conflict.detected",
  conflictResolved: "eks.orchestrator.conflict.resolved",
  unifiedPlanGenerated: "eks.orchestrator.plan.generated",
  crossProgramMissionCreated: "eks.orchestrator.cross_mission.created",
  sharedGoalUpdated: "eks.orchestrator.shared_goal.updated",
  sharedMeasurementRegistered: "eks.orchestrator.shared_measurement.registered",
  workloadAssessed: "eks.orchestrator.workload.assessed",
  coordinatorDecision: "eks.orchestrator.coordinator.decision",
  timelineUpdated: "eks.orchestrator.timeline.updated",
} as const;

export type OrchestratorEventType = (typeof ORCHESTRATOR_EVENTS)[keyof typeof ORCHESTRATOR_EVENTS];

export { type AccountId, type OrgId, type ProgramId, type MeasurementId, type SchemaId };
