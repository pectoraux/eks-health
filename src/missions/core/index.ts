/**
 * Eks-Health Mission Engine — Core Primitives
 *
 * Foundational types for missions, goals, plans, tasks, habits, milestones,
 * recommendations, workflows, context, and outcomes.
 *
 * The platform understands ONLY generic concepts. It does NOT know what
 * "weight loss plan", "keto diet", "yoga routine", or "diabetes coaching"
 * mean. Programs define those. The platform provides the infrastructure
 * that allows each Program to safely implement its own coaching methodology.
 *
 * Built on the kernel (events, ids, errors), identity (accounts, consent),
 * programs (capabilities), health (measurements), technicians (sessions),
 * and competitions (scores, standings).
 */

import "server-only";
import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
} from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";
import type { MeasurementId, SchemaId } from "@/health";
import type { CompetitionId, SeasonId } from "@/competitions";

// ---------------------------------------------------------------------------
// Branded mission identifiers
// ---------------------------------------------------------------------------

export type MissionId = Brand<string, "MissionId">;
export type GoalId = Brand<string, "GoalId">;
export type PlanId = Brand<string, "PlanId">;
export type TaskId = Brand<string, "TaskId">;
export type HabitId = Brand<string, "HabitId">;
export type MilestoneId = Brand<string, "MilestoneId">;
export type RecommendationId = Brand<string, "RecommendationId">;
export type WorkflowId = Brand<string, "WorkflowId">;
export type WorkflowExecutionId = Brand<string, "WorkflowExecutionId">;
export type MissionTemplateId = Brand<string, "MissionTemplateId">;
export type GoalTemplateId = Brand<string, "GoalTemplateId">;
export type StreakId = Brand<string, "StreakId">;
export type KnowledgeBaseId = Brand<string, "KnowledgeBaseId">;
export type KnowledgeEntryId = Brand<string, "KnowledgeEntryId">;
export type ExplanationId = Brand<string, "ExplanationId">;
export type ReminderId = Brand<string, "ReminderId">;
export type PlanVersionId = Brand<string, "PlanVersionId">;

export function asMissionId(s: string): MissionId { return s as MissionId; }
export function asGoalId(s: string): GoalId { return s as GoalId; }
export function asPlanId(s: string): PlanId { return s as PlanId; }
export function asTaskId(s: string): TaskId { return s as TaskId; }
export function asHabitId(s: string): HabitId { return s as HabitId; }
export function asMilestoneId(s: string): MilestoneId { return s as MilestoneId; }
export function asRecommendationId(s: string): RecommendationId { return s as RecommendationId; }
export function asWorkflowId(s: string): WorkflowId { return s as WorkflowId; }
export function asWorkflowExecutionId(s: string): WorkflowExecutionId { return s as WorkflowExecutionId; }
export function asMissionTemplateId(s: string): MissionTemplateId { return s as MissionTemplateId; }
export function asStreakId(s: string): StreakId { return s as StreakId; }
export function asKnowledgeBaseId(s: string): KnowledgeBaseId { return s as KnowledgeBaseId; }
export function asKnowledgeEntryId(s: string): KnowledgeEntryId { return s as KnowledgeEntryId; }
export function asExplanationId(s: string): ExplanationId { return s as ExplanationId; }
export function asReminderId(s: string): ReminderId { return s as ReminderId; }
export function asPlanVersionId(s: string): PlanVersionId { return s as PlanVersionId; }

// ---------------------------------------------------------------------------
// Mission types & lifecycle
// ---------------------------------------------------------------------------

export type MissionType =
  | "daily_mission"
  | "weekly_plan"
  | "monthly_program"
  | "seasonal_goal"
  | "long_term_journey"
  | "one_time_task"
  | "recurring_habit"
  | "checklist"
  | "learning_module"
  | "appointment"
  | "assessment"
  | "custom";

export type MissionState =
  | "draft"
  | "scheduled"
  | "assigned"
  | "active"
  | "completed"
  | "skipped"
  | "expired"
  | "cancelled"
  | "archived";

export type MissionPriority = "low" | "normal" | "high" | "critical";

export type MissionCategory =
  | "measurement"
  | "activity"
  | "nutrition"
  | "sleep"
  | "mental_wellness"
  | "education"
  | "appointment"
  | "social"
  | "custom";

// ---------------------------------------------------------------------------
// Goal types
// ---------------------------------------------------------------------------

export type GoalType =
  | "measurement_target" // e.g. lose 10kg, reach BP 120/80
  | "behavior_target" // e.g. walk 10k steps daily
  | "completion_target" // e.g. complete 5 educational modules
  | "streak_target" // e.g. 30-day meditation streak
  | "ranking_target" // e.g. reach top 10 in competition
  | "custom";

export type GoalState = "draft" | "active" | "achieved" | "missed" | "cancelled" | "archived";

export interface Milestone {
  readonly id: MilestoneId;
  readonly name: string;
  readonly description: string;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly achievedAt?: string;
  readonly deadline?: string;
  readonly dependencies: MilestoneId[];
}

// ---------------------------------------------------------------------------
// Habit types
// ---------------------------------------------------------------------------

export type HabitFrequency = "daily" | "weekly" | "custom";

export interface Streak {
  readonly id: StreakId;
  readonly habitId: HabitId;
  readonly current: number;
  readonly best: number;
  readonly lastCompletedAt?: string;
  readonly startedAt: string;
  readonly gracePeriodUsed: number;
  readonly recoveryCount: number;
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export type PlanState = "draft" | "active" | "paused" | "completed" | "archived";

export interface Plan {
  readonly id: PlanId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly name: string;
  readonly description: string;
  readonly version: number;
  readonly missionIds: MissionId[];
  readonly goalIds: GoalId[];
  readonly habitIds: HabitId[];
  readonly state: PlanState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validFrom: string;
  readonly validUntil?: string;
  readonly adaptivityRules?: AdaptivityRule[];
  readonly customAttributes?: Record<string, unknown>;
}

export interface AdaptivityRule {
  readonly name: string;
  readonly trigger: string; // condition expression
  readonly action: "add_mission" | "remove_mission" | "modify_difficulty" | "notify" | "escalate" | "pause_plan" | "custom";
  readonly params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

export type RecommendationStatus = "pending" | "accepted" | "rejected" | "expired" | "superseded";
export type RecommendationSource = "ai" | "program" | "technician" | "platform" | "custom";

export interface Recommendation {
  readonly id: RecommendationId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly source: RecommendationSource;
  readonly title: string;
  readonly description: string;
  readonly rationale: string; // why this was recommended
  readonly category: MissionCategory;
  readonly priority: MissionPriority;
  readonly status: RecommendationStatus;
  readonly relatedMissionId?: MissionId;
  readonly relatedGoalId?: GoalId;
  readonly aiTraceId?: string;
  readonly createdAt: string;
  readonly respondedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Personalization context (secure inputs exposed to Programs)
// ---------------------------------------------------------------------------

export interface PersonalizationContext {
  readonly participantId: AccountId;
  readonly programId: ProgramId;
  readonly measurements: { schemaId: SchemaId; latestValue: unknown; trend?: "up" | "down" | "stable"; count: number }[];
  readonly competitionStanding?: { competitionId: CompetitionId; rank: number; score: number; division?: string };
  readonly demographics?: { ageRange?: string; biologicalSex?: string; country?: string; timezone?: string };
  readonly preferences?: Record<string, unknown>;
  readonly behaviorHistory?: { missionCompletionRate: number; avgSessionDuration: number; lastActiveAt?: string };
  readonly programHistory?: { joinedAt: string; missionsCompleted: number; goalsAchieved: number };
  readonly technicianFeedback?: string[];
  readonly connectedDevices?: string[];
  readonly environmentalContext?: { weather?: string; temperature?: number; airQuality?: number };
  readonly orgMembership?: OrgId[];
  readonly customProgramData?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export type WorkflowStepType =
  | "initial_assessment"
  | "generate_ai_plan"
  | "book_technician"
  | "collect_measurements"
  | "update_score"
  | "generate_missions"
  | "notify_participant"
  | "evaluate_progress"
  | "adapt_plan"
  | "knowledge_retrieval"
  | "ai_execution"
  | "conditional_branch"
  | "wait"
  | "parallel"
  | "custom";

export interface WorkflowStep {
  readonly id: string;
  readonly type: WorkflowStepType;
  readonly name: string;
  readonly inputs?: Record<string, unknown>;
  readonly condition?: string; // for conditional_branch
  readonly nextStepId?: string;
  readonly branchTrueId?: string;
  readonly branchFalseId?: string;
  readonly timeoutSeconds?: number;
  readonly retryPolicy?: { maxRetries: number; backoffMs: number };
}

export interface WorkflowDefinition {
  readonly id: WorkflowId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly steps: WorkflowStep[];
  readonly startStepId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowExecutionState = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

export interface WorkflowExecution {
  readonly id: WorkflowExecutionId;
  readonly workflowId: WorkflowId;
  readonly participantId: AccountId;
  readonly state: WorkflowExecutionState;
  readonly currentStepId?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly stepHistory: { stepId: string; state: string; startedAt: string; completedAt?: string; output?: unknown }[];
  readonly context: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export type KnowledgeType =
  | "clinical_guideline"
  | "research_paper"
  | "traditional_medicine_reference"
  | "exercise_library"
  | "recipe_database"
  | "educational_content"
  | "faq"
  | "custom";

export interface KnowledgeBase {
  readonly id: KnowledgeBaseId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly type: KnowledgeType;
  readonly entryCount: number;
  readonly createdAt: string;
  readonly licensing?: { license: string; expiresAt?: string; allowedRetrieval: boolean };
}

export interface KnowledgeEntry {
  readonly id: KnowledgeEntryId;
  readonly baseId: KnowledgeBaseId;
  readonly title: string;
  readonly content: string;
  readonly tags: string[];
  readonly embedding?: number[]; // for semantic search (future)
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

export interface Explanation {
  readonly id: ExplanationId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly subjectType: "mission" | "goal" | "plan" | "recommendation" | "workflow";
  readonly subjectId: string;
  readonly question: string; // e.g. "Why was this mission assigned?"
  readonly answer: string; // structured explanation
  readonly factors: { label: string; value: string; weight?: number }[];
  readonly aiTraceId?: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MissionErrorCategory =
  | "not_found"
  | "state_conflict"
  | "validation"
  | "not_authorized"
  | "ai_safety_violation"
  | "workflow_invalid"
  | "quota_exceeded"
  | "version_conflict";

export class MissionError extends Error {
  readonly code: string;
  readonly category: MissionErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: MissionErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "MissionError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A mission platform error occurred.";
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
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      message: this.message,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      traceId: this.traceId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Mission event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const MISSION_EVENTS = {
  missionAssigned: "eks.mission.assigned",
  missionActivated: "eks.mission.activated",
  missionCompleted: "eks.mission.completed",
  missionSkipped: "eks.mission.skipped",
  missionExpired: "eks.mission.expired",
  habitUpdated: "eks.mission.habit.updated",
  habitStreakExtended: "eks.mission.habit.streak_extended",
  habitStreakBroken: "eks.mission.habit.streak_broken",
  goalAchieved: "eks.mission.goal.achieved",
  goalMilestoneReached: "eks.mission.goal.milestone",
  planCreated: "eks.mission.plan.created",
  planUpdated: "eks.mission.plan.updated",
  planAdapted: "eks.mission.plan.adapted",
  recommendationAccepted: "eks.mission.recommendation.accepted",
  recommendationRejected: "eks.mission.recommendation.rejected",
  workflowCompleted: "eks.mission.workflow.completed",
  workflowStepExecuted: "eks.mission.workflow.step",
  aiPlanGenerated: "eks.mission.ai.plan_generated",
  explanationRequested: "eks.mission.explanation.requested",
  reminderScheduled: "eks.mission.reminder.scheduled",
} as const;

export type MissionEventType = (typeof MISSION_EVENTS)[keyof typeof MISSION_EVENTS];

export { type TenantId, type AccountId, type OrgId, type ProgramId, type MeasurementId, type SchemaId, type CompetitionId, type SeasonId };
