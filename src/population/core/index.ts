/**
 * Eks-Health Population Platform — Core Primitives
 *
 * Foundational types for organizations, populations, memberships, funding,
 * campaigns, policies, and the privacy firewall. Organizations manage
 * Programs, sponsor participation, fund competitions, and analyze aggregate
 * outcomes — but never own participant health data. Individual privacy
 * always takes precedence over organizational interests.
 *
 * Built on all prior milestones.
 */

import "server-only";
import type { Brand, CorrelationId, TraceId } from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";

// ---------------------------------------------------------------------------
// Branded population identifiers
// ---------------------------------------------------------------------------

export type PopulationOrgId = Brand<string, "PopulationOrgId">;
export type MembershipId = Brand<string, "MembershipId">;
export type FundingPolicyId = Brand<string, "FundingPolicyId">;
export type FundingRequestId = Brand<string, "FundingRequestId">;
export type CampaignId = Brand<string, "CampaignId">;
export type OrgPolicyId = Brand<string, "OrgPolicyId">;
export type OrgTwinId = Brand<string, "OrgTwinId">;
export type OrgCatalogId = Brand<string, "OrgCatalogId">;
export type PrivacyGrantId = Brand<string, "PrivacyGrantId">;
export type OrgInsightId = Brand<string, "OrgInsightId">;

export function asPopulationOrgId(s: string): PopulationOrgId { return s as PopulationOrgId; }
export function asMembershipId(s: string): MembershipId { return s as MembershipId; }
export function asFundingPolicyId(s: string): FundingPolicyId { return s as FundingPolicyId; }
export function asFundingRequestId(s: string): FundingRequestId { return s as FundingRequestId; }
export function asCampaignId(s: string): CampaignId { return s as CampaignId; }
export function asOrgPolicyId(s: string): OrgPolicyId { return s as OrgPolicyId; }
export function asOrgTwinId(s: string): OrgTwinId { return s as OrgTwinId; }
export function asOrgCatalogId(s: string): OrgCatalogId { return s as OrgCatalogId; }
export function asPrivacyGrantId(s: string): PrivacyGrantId { return s as PrivacyGrantId; }
export function asOrgInsightId(s: string): OrgInsightId { return s as OrgInsightId; }

// ---------------------------------------------------------------------------
// Organization types
// ---------------------------------------------------------------------------

export type OrganizationType =
  | "employer"
  | "government"
  | "hospital"
  | "clinic"
  | "university"
  | "school"
  | "insurance_provider"
  | "sports_club"
  | "ngo"
  | "religious_organization"
  | "community"
  | "military"
  | "research_institution"
  | "custom";

export type OrganizationTier = "free" | "standard" | "premium" | "enterprise" | "government";

// ---------------------------------------------------------------------------
// Population organization
// ---------------------------------------------------------------------------

export interface PopulationOrganization {
  readonly id: PopulationOrgId;
  readonly name: string;
  readonly slug: string;
  readonly type: OrganizationType;
  readonly tier: OrganizationTier;
  readonly description?: string;
  readonly parentId?: PopulationOrgId;
  readonly childrenIds: PopulationOrgId[];
  readonly logoUrl?: string;
  readonly country: string;
  readonly region?: string;
  readonly website?: string;
  readonly contactEmail?: string;
  readonly memberCount: number;
  readonly activeMemberCount: number;
  readonly status: "active" | "suspended" | "dissolved";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export type MembershipRole = "admin" | "manager" | "coordinator" | "member" | "viewer" | "custom";
export type MembershipStatus = "invited" | "active" | "suspended" | "left" | "removed";

export interface OrganizationMembership {
  readonly id: MembershipId;
  readonly orgId: PopulationOrgId;
  readonly accountId: AccountId;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly department?: string;
  readonly team?: string;
  readonly joinedAt: string;
  readonly leftAt?: string;
  readonly invitedBy?: AccountId;
  readonly temporary?: boolean;
  readonly expiresAt?: string;
  readonly history: { action: string; at: string; by?: AccountId }[];
}

// ---------------------------------------------------------------------------
// Privacy firewall
// ---------------------------------------------------------------------------

export type PrivacyGrantType =
  | "attendance_only"
  | "competition_status"
  | "aggregate_performance"
  | "specific_measurement"
  | "wellness_certificate"
  | "achievements"
  | "program_progress"
  | "custom";

export interface PrivacyGrant {
  readonly id: PrivacyGrantId;
  readonly participantId: AccountId;
  readonly orgId: PopulationOrgId;
  readonly grantType: PrivacyGrantType;
  readonly purpose: string;
  readonly scope: string[]; // specific fields/categories
  readonly status: "active" | "revoked" | "expired";
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly auditTrail: { action: string; at: string; detail?: string }[];
}

export interface OrgVisibleData {
  readonly orgId: PopulationOrgId;
  readonly participantId: AccountId;
  readonly visibleFields: string[];
  readonly hiddenFields: string[];
  readonly grantTypes: PrivacyGrantType[];
  readonly lastChecked: string;
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export type FundingTargetType =
  | "program_purchase"
  | "measurement_session"
  | "technician_visit"
  | "competition_prize"
  | "ai_coaching"
  | "device"
  | "educational_content"
  | "scholarship"
  | "program_subscription"
  | "custom";

export type FundingRequestStatus = "pending" | "approved" | "rejected" | "executed" | "cancelled";

export interface FundingPolicy {
  readonly id: FundingPolicyId;
  readonly orgId: PopulationOrgId;
  readonly name: string;
  readonly description: string;
  readonly targetType: FundingTargetType;
  readonly maxAmountPerParticipant: number;
  readonly maxAmountTotal: number;
  readonly currency: string;
  readonly eligibilityCriteria: string[];
  readonly active: boolean;
  readonly createdAt: string;
}

export interface FundingRequest {
  readonly id: FundingRequestId;
  readonly policyId: FundingPolicyId;
  readonly orgId: PopulationOrgId;
  readonly participantId: AccountId;
  readonly targetType: FundingTargetType;
  readonly amount: number;
  readonly currency: string;
  readonly status: FundingRequestStatus;
  readonly purpose: string;
  readonly createdAt: string;
  readonly approvedAt?: string;
  readonly approvedBy?: AccountId;
  readonly executedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignStatus = "draft" | "scheduled" | "active" | "paused" | "completed" | "cancelled";

export interface PublicHealthCampaign {
  readonly id: CampaignId;
  readonly name: string;
  readonly description: string;
  readonly orgId: PopulationOrgId;
  readonly scope: "global" | "national" | "regional" | "organizational";
  readonly status: CampaignStatus;
  readonly startDate: string;
  readonly endDate: string;
  readonly targetPrograms: ProgramId[];
  readonly targetCompetitions: string[];
  readonly fundingPolicyIds: FundingPolicyId[];
  readonly educationalContent: { title: string; url: string }[];
  readonly participationGoal: number;
  readonly actualParticipation: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Organization policies
// ---------------------------------------------------------------------------

export type PolicyType =
  | "approved_programs"
  | "required_measurements"
  | "competition_participation"
  | "privacy_defaults"
  | "funding_limits"
  | "program_budgets"
  | "regional_restrictions"
  | "compliance_requirements"
  | "custom";

export interface OrganizationPolicy {
  readonly id: OrgPolicyId;
  readonly orgId: PopulationOrgId;
  readonly type: PolicyType;
  readonly name: string;
  readonly description: string;
  readonly rules: { field: string; operator: string; value: unknown }[];
  readonly enforce: boolean;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Organization Digital Twin
// ---------------------------------------------------------------------------

export interface OrganizationTwin {
  readonly id: OrgTwinId;
  readonly orgId: PopulationOrgId;
  readonly populationHealth: {
    readonly totalParticipants: number;
    readonly activeParticipants: number;
    readonly avgImprovement: number;
    readonly participationRate: number;
    readonly engagementScore: number;
  };
  readonly programAdoption: { programId: ProgramId; installs: number; active: number; completionRate: number }[];
  readonly competitions: { competitionId: string; participants: number; engagement: number }[];
  readonly budgets: { category: string; allocated: number; spent: number; remaining: number; currency: string };
  readonly risks: { name: string; level: "low" | "medium" | "high"; detail?: string }[];
  readonly resources: { type: string; count: number; utilization: number }[];
  readonly evidence: { programId: ProgramId; confidence: number; populationSize: number }[];
  readonly lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Organization marketplace catalog
// ---------------------------------------------------------------------------

export interface OrgProgramCatalog {
  readonly id: OrgCatalogId;
  readonly orgId: PopulationOrgId;
  readonly name: string;
  readonly description: string;
  readonly approvedProgramIds: ProgramId[];
  readonly requiredProgramIds: ProgramId[];
  readonly sponsoredProgramIds: ProgramId[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Organization AI insights
// ---------------------------------------------------------------------------

export type OrgInsightType =
  | "participation_forecasting"
  | "program_recommendations"
  | "competition_optimization"
  | "budget_optimization"
  | "population_insights"
  | "resource_planning"
  | "engagement_analysis"
  | "custom";

export interface OrganizationInsight {
  readonly id: OrgInsightId;
  readonly orgId: PopulationOrgId;
  readonly type: OrgInsightType;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly recommendations: string[];
  readonly dataSources: string[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PopulationErrorCategory =
  | "not_found"
  | "validation"
  | "privacy_violation"
  | "not_authorized"
  | "state_conflict"
  | "quota_exceeded"
  | "funding_exhausted";

export class PopulationError extends Error {
  readonly code: string;
  readonly category: PopulationErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: PopulationErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "PopulationError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A population platform error occurred.";
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
// Population events
// ---------------------------------------------------------------------------

export const POPULATION_EVENTS = {
  orgCreated: "eks.population.org.created",
  orgSuspended: "eks.population.org.suspended",
  memberInvited: "eks.population.member.invited",
  memberJoined: "eks.population.member.joined",
  memberLeft: "eks.population.member.left",
  privacyGranted: "eks.population.privacy.granted",
  privacyRevoked: "eks.population.privacy.revoked",
  fundingPolicyCreated: "eks.population.funding.policy_created",
  fundingRequested: "eks.population.funding.requested",
  fundingApproved: "eks.population.funding.approved",
  fundingExecuted: "eks.population.funding.executed",
  campaignLaunched: "eks.population.campaign.launched",
  campaignCompleted: "eks.population.campaign.completed",
  policyUpdated: "eks.population.policy.updated",
  orgTwinUpdated: "eks.population.twin.updated",
  orgInsightGenerated: "eks.population.insight.generated",
  catalogUpdated: "eks.population.catalog.updated",
} as const;

export type PopulationEventType = (typeof POPULATION_EVENTS)[keyof typeof POPULATION_EVENTS];

export { type AccountId, type OrgId, type ProgramId };
