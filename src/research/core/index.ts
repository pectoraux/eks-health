/**
 * Eks-Health Research Platform — Core Primitives
 *
 * Foundational types for research, evidence, population intelligence,
 * cohorts, studies, datasets, publications, and insights. The platform
 * continuously learns from aggregated, consented, anonymized outcomes
 * while preserving participant privacy.
 *
 * Built on all prior milestones: health (measurements), competitions
 * (outcomes), marketplace (evidence), identity (consent), ai (insights).
 */

import "server-only";
import type { Brand, CorrelationId, TraceId } from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";

// ---------------------------------------------------------------------------
// Branded research identifiers
// ---------------------------------------------------------------------------

export type DatasetId = Brand<string, "DatasetId">;
export type CohortId = Brand<string, "CohortId">;
export type StudyId = Brand<string, "StudyId">;
export type ResearchConsentId = Brand<string, "ResearchConsentId">;
export type EvidenceAccumulationId = Brand<string, "EvidenceAccumulationId">;
export type BenchmarkId = Brand<string, "BenchmarkId">;
export type ComparativeStudyId = Brand<string, "ComparativeStudyId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type PublicationId = Brand<string, "PublicationId">;
export type InsightId = Brand<string, "InsightId">;
export type GovernanceRequestId = Brand<string, "GovernanceRequestId">;
export type DataExportId = Brand<string, "DataExportId">;
export type PopulationSnapshotId = Brand<string, "PopulationSnapshotId">;

export function asDatasetId(s: string): DatasetId { return s as DatasetId; }
export function asCohortId(s: string): CohortId { return s as CohortId; }
export function asStudyId(s: string): StudyId { return s as StudyId; }
export function asResearchConsentId(s: string): ResearchConsentId { return s as ResearchConsentId; }
export function asEvidenceAccumulationId(s: string): EvidenceAccumulationId { return s as EvidenceAccumulationId; }
export function asBenchmarkId(s: string): BenchmarkId { return s as BenchmarkId; }
export function asComparativeStudyId(s: string): ComparativeStudyId { return s as ComparativeStudyId; }
export function asWorkspaceId(s: string): WorkspaceId { return s as WorkspaceId; }
export function asPublicationId(s: string): PublicationId { return s as PublicationId; }
export function asInsightId(s: string): InsightId { return s as InsightId; }
export function asGovernanceRequestId(s: string): GovernanceRequestId { return s as GovernanceRequestId; }
export function asDataExportId(s: string): DataExportId { return s as DataExportId; }
export function asPopulationSnapshotId(s: string): PopulationSnapshotId { return s as PopulationSnapshotId; }

// ---------------------------------------------------------------------------
// Research consent types
// ---------------------------------------------------------------------------

export type ResearchConsentType =
  | "anonymous_research"
  | "academic_research"
  | "commercial_research"
  | "government_research"
  | "employer_wellness_analytics"
  | "insurance_analytics"
  | "ai_training"
  | "program_improvement"
  | "cross_program_benchmarking"
  | "international_studies";

export type ResearchConsentStatus = "pending" | "granted" | "revoked" | "expired";

export interface ResearchConsent {
  readonly id: ResearchConsentId;
  readonly participantId: AccountId;
  readonly type: ResearchConsentType;
  readonly status: ResearchConsentStatus;
  readonly grantedAt?: string;
  readonly revokedAt?: string;
  readonly expiresAt?: string;
  readonly purpose: string;
  readonly scope: string[]; // which data categories
  readonly version: number;
  readonly consentHistory: { action: string; at: string; by: AccountId }[];
}

// ---------------------------------------------------------------------------
// Cohort
// ---------------------------------------------------------------------------

export interface CohortDefinition {
  readonly id: CohortId;
  readonly name: string;
  readonly description: string;
  readonly criteria: CohortCriterion[];
  readonly estimatedSize: number;
  readonly createdBy: AccountId;
  readonly createdAt: string;
  readonly privacyLevel: "anonymous" | "pseudonymized" | "aggregated";
}

export interface CohortCriterion {
  readonly field: string; // e.g. "age_range", "gender", "country", "completion_rate", "program_id"
  readonly operator: "eq" | "ne" | "in" | "not_in" | "gt" | "lt" | "gte" | "lte" | "between" | "exists";
  readonly value: unknown;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export type DatasetStatus = "draft" | "approved" | "active" | "deprecated" | "restricted";

export interface Dataset {
  readonly id: DatasetId;
  readonly name: string;
  readonly description: string;
  readonly cohortId: CohortId;
  readonly status: DatasetStatus;
  readonly dataCategories: string[];
  readonly recordCount: number;
  readonly privacyLevel: "anonymous" | "pseudonymized" | "aggregated";
  readonly kAnonymityThreshold: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedAt?: string;
  readonly approvedBy?: AccountId;
  readonly lineage: DataLineageEntry[];
}

export interface DataLineageEntry {
  readonly action: string;
  readonly at: string;
  readonly by: AccountId;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Study
// ---------------------------------------------------------------------------

export type StudyStatus = "draft" | "submitted" | "approved" | "active" | "completed" | "rejected" | "withdrawn";

export interface Study {
  readonly id: StudyId;
  readonly name: string;
  readonly description: string;
  readonly hypothesis: string;
  readonly workspaceId: WorkspaceId;
  readonly datasetIds: DatasetId[];
  readonly cohortIds: CohortId[];
  readonly status: StudyStatus;
  readonly principalInvestigator: AccountId;
  readonly collaborators: AccountId[];
  readonly methodology: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly results?: StudyResults;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StudyResults {
  readonly summary: string;
  readonly findings: { name: string; value: number; confidence: number; description: string }[];
  readonly statisticalSignificance: number; // p-value
  readonly effectSize: number;
  readonly sampleSize: number;
  readonly limitations: string[];
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Evidence accumulation
// ---------------------------------------------------------------------------

export interface EvidenceAccumulation {
  readonly id: EvidenceAccumulationId;
  readonly programId: ProgramId;
  readonly listingId?: string;
  readonly totalParticipants: number;
  readonly totalMeasurements: number;
  readonly averageImprovement: number;
  readonly medianImprovement: number;
  readonly completionRate: number;
  readonly retentionRate: number;
  readonly missionCompliance: number;
  readonly competitionParticipation: number;
  readonly measurementQuality: number;
  readonly technicianVerificationQuality: number;
  readonly longTermSustainability: number;
  readonly confidenceScore: number; // 0-100
  readonly evidenceLevel: "preliminary" | "emerging" | "established" | "strong";
  readonly lastUpdated: string;
  readonly history: { at: string; participants: number; improvement: number; confidence: number }[];
}

// ---------------------------------------------------------------------------
// Population intelligence
// ---------------------------------------------------------------------------

export interface PopulationSnapshot {
  readonly id: PopulationSnapshotId;
  readonly totalParticipants: number;
  readonly totalMeasurements: number;
  readonly totalVerifiedMeasurements: number;
  readonly totalPrograms: number;
  readonly totalCompetitions: number;
  readonly improvementTrends: { category: string; avgImprovement: number; trend: "up" | "down" | "stable" }[];
  readonly completionRates: { category: string; rate: number }[];
  readonly measurementFrequency: { category: string; avgPerWeek: number }[];
  readonly programEffectiveness: { programId: ProgramId; effectiveness: number; confidence: number }[];
  readonly regionalDifferences: { region: string; participants: number; avgImprovement: number }[];
  readonly seasonalEffects: { season: string; avgImprovement: number }[];
  readonly demographicTrends: { demographic: string; participants: number; trend: string }[];
  readonly retentionMetrics: { period: string; rate: number }[];
  readonly competitionParticipation: { competitionId: string; participants: number }[];
  readonly missionAdherence: { category: string; adherenceRate: number }[];
  readonly capturedAt: string;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

export type BenchmarkType = "top_percentile" | "median" | "global_average" | "country_average" | "age_group_average" | "org_average" | "historical";

export interface Benchmark {
  readonly id: BenchmarkId;
  readonly programId: ProgramId;
  readonly type: BenchmarkType;
  readonly metric: string; // e.g. "average_improvement", "completion_rate"
  readonly value: number;
  readonly percentile?: number; // for top_percentile
  readonly population?: string; // e.g. "GH", "age_40_60"
  readonly historicalPeriod?: string;
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Comparative effectiveness
// ---------------------------------------------------------------------------

export interface ComparativeStudy {
  readonly id: ComparativeStudyId;
  readonly name: string;
  readonly programIds: ProgramId[];
  readonly metric: string;
  readonly results: { programId: ProgramId; value: number; confidence: number; sampleSize: number }[];
  readonly statisticalMethod: string;
  readonly significance: number; // p-value
  readonly effectSize: number;
  readonly limitations: string[];
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export interface ResearchWorkspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly description: string;
  readonly ownerId: AccountId;
  readonly members: { accountId: AccountId; role: "owner" | "researcher" | "analyst" | "viewer"; addedAt: string }[];
  readonly studyIds: StudyId[];
  readonly datasetIds: DatasetId[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export type PublicationType = "report" | "dashboard" | "findings" | "evidence_summary" | "methodology" | "visualization" | "program_evaluation";

export interface Publication {
  readonly id: PublicationId;
  readonly title: string;
  readonly abstract: string;
  readonly type: PublicationType;
  readonly studyId?: StudyId;
  readonly workspaceId: WorkspaceId;
  readonly authors: { accountId: AccountId; name: string; affiliation?: string }[];
  readonly content: string; // markdown
  readonly linkedProgramIds: ProgramId[];
  readonly linkedListingIds: string[];
  readonly tags: string[];
  readonly publishedAt: string;
  readonly doi?: string;
  readonly peerReviewed: boolean;
}

// ---------------------------------------------------------------------------
// AI insight
// ---------------------------------------------------------------------------

export type InsightType =
  | "trend_discovery"
  | "hypothesis_generation"
  | "anomaly_detection"
  | "program_comparison"
  | "risk_forecasting"
  | "outcome_summarization"
  | "evidence_synthesis";

export interface ResearchInsight {
  readonly id: InsightId;
  readonly type: InsightType;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number; // 0-1
  readonly evidence: { source: string; detail: string }[];
  readonly recommendations: string[];
  readonly aiTraceId?: string;
  readonly explainable: boolean;
  readonly traceable: boolean;
  readonly createdBy: AccountId;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Data governance
// ---------------------------------------------------------------------------

export type GovernanceRequestType =
  | "dataset_approval"
  | "access_request"
  | "export_request"
  | "ethics_approval"
  | "retention_review"
  | "legal_hold"
  | "deletion_request";

export type GovernanceRequestStatus = "pending" | "approved" | "rejected" | "expired";

export interface GovernanceRequest {
  readonly id: GovernanceRequestId;
  readonly type: GovernanceRequestType;
  readonly requesterId: AccountId;
  readonly datasetId?: DatasetId;
  readonly studyId?: StudyId;
  readonly justification: string;
  readonly status: GovernanceRequestStatus;
  readonly submittedAt: string;
  readonly reviewedAt?: string;
  readonly reviewedBy?: AccountId;
  readonly reviewNotes?: string;
  readonly expiryDate?: string;
}

// ---------------------------------------------------------------------------
// Data export
// ---------------------------------------------------------------------------

export interface ResearchDataExport {
  readonly id: DataExportId;
  readonly datasetId: DatasetId;
  readonly requesterId: AccountId;
  readonly format: "json" | "csv" | "parquet";
  readonly recordCount: number;
  readonly anonymizationApplied: boolean;
  readonly kAnonymityLevel: number;
  readonly noiseInjected: boolean;
  readonly status: "pending" | "approved" | "completed" | "rejected";
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly governanceRequestId?: GovernanceRequestId;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ResearchErrorCategory =
  | "not_found"
  | "validation"
  | "consent_required"
  | "privacy_violation"
  | "governance_required"
  | "not_authorized"
  | "state_conflict"
  | "quota_exceeded";

export class ResearchError extends Error {
  readonly code: string;
  readonly category: ResearchErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: ResearchErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "ResearchError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A research platform error occurred.";
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
// Research events
// ---------------------------------------------------------------------------

export const RESEARCH_EVENTS = {
  consentGranted: "eks.research.consent.granted",
  consentRevoked: "eks.research.consent.revoked",
  datasetCreated: "eks.research.dataset.created",
  datasetApproved: "eks.research.dataset.approved",
  studyPublished: "eks.research.study.published",
  evidenceUpdated: "eks.research.evidence.updated",
  benchmarkUpdated: "eks.research.benchmark.updated",
  populationInsightGenerated: "eks.research.insight.generated",
  programEvidenceScoreChanged: "eks.research.evidence.score_changed",
  researchExportCompleted: "eks.research.export.completed",
  governanceRequestSubmitted: "eks.research.governance.submitted",
  governanceRequestApproved: "eks.research.governance.approved",
  governanceRequestRejected: "eks.research.governance.rejected",
  comparativeStudyCompleted: "eks.research.comparative.completed",
  publicationReleased: "eks.research.publication.released",
} as const;

export type ResearchEventType = (typeof RESEARCH_EVENTS)[keyof typeof RESEARCH_EVENTS];

export { type AccountId, type OrgId, type ProgramId };
