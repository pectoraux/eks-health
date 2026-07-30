/**
 * Eks-Health Health Marketplace — Core Primitives
 *
 * Foundational types for the global marketplace for preventive health solutions.
 * Users browse HEALTH SOLUTIONS, not apps. The marketplace optimizes for
 * health outcomes, not downloads. AI-powered search, evidence-aware comparison,
 * outcome-based ranking.
 *
 * Built on all prior milestones: programs (listings), competitions (rewards),
 * health (outcomes from verified measurements), developer (profiles).
 */

import "server-only";
import type { Brand, CorrelationId, TraceId } from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";

// ---------------------------------------------------------------------------
// Branded marketplace identifiers
// ---------------------------------------------------------------------------

export type ListingId = Brand<string, "ListingId">;
export type SolutionId = Brand<string, "SolutionId">;
export type CollectionId = Brand<string, "CollectionId">;
export type ReviewId = Brand<string, "ReviewId">;
export type ComparisonId = Brand<string, "ComparisonId">;
export type InstallationId = Brand<string, "InstallationId">;
export type LicenseId = Brand<string, "LicenseId">;
export type PurchaseIntentId = Brand<string, "PurchaseIntentId">;
export type EntitlementId = Brand<string, "EntitlementId">;
export type RevenueShareId = Brand<string, "RevenueShareId">;
export type RevenueAllocationId = Brand<string, "RevenueAllocationId">;
export type EvidencePageId = Brand<string, "EvidencePageId">;
export type OutcomeMetricId = Brand<string, "OutcomeMetricId">;
export type SuitabilityScoreId = Brand<string, "SuitabilityScoreId">;

export function asListingId(s: string): ListingId { return s as ListingId; }
export function asSolutionId(s: string): SolutionId { return s as SolutionId; }
export function asCollectionId(s: string): CollectionId { return s as CollectionId; }
export function asReviewId(s: string): ReviewId { return s as ReviewId; }
export function asComparisonId(s: string): ComparisonId { return s as ComparisonId; }
export function asInstallationId(s: string): InstallationId { return s as InstallationId; }
export function asLicenseId(s: string): LicenseId { return s as LicenseId; }
export function asPurchaseIntentId(s: string): PurchaseIntentId { return s as PurchaseIntentId; }
export function asEntitlementId(s: string): EntitlementId { return s as EntitlementId; }
export function asRevenueShareId(s: string): RevenueShareId { return s as RevenueShareId; }
export function asEvidencePageId(s: string): EvidencePageId { return s as EvidencePageId; }
export function asOutcomeMetricId(s: string): OutcomeMetricId { return s as OutcomeMetricId; }
export function asSuitabilityScoreId(s: string): SuitabilityScoreId { return s as SuitabilityScoreId; }

// ---------------------------------------------------------------------------
// Health solution (what users actually browse)
// ---------------------------------------------------------------------------

export type SolutionCategory =
  | "weight_management"
  | "blood_pressure"
  | "diabetes_prevention"
  | "sleep_optimization"
  | "mental_wellness"
  | "cardiovascular"
  | "nutrition"
  | "habit_formation"
  | "fitness"
  | "maternal"
  | "pediatrics"
  | "geriatrics"
  | "rehabilitation"
  | "traditional_medicine"
  | "longevity"
  | "custom";

export type BodySystem =
  | "cardiovascular"
  | "metabolic"
  | "respiratory"
  | "musculoskeletal"
  | "nervous"
  | "endocrine"
  | "immune"
  | "digestive"
  | "reproductive"
  | "integumentary"
  | "urinary"
  | "mental"
  | "general";

export interface HealthSolution {
  readonly id: SolutionId;
  readonly listingId: ListingId;
  readonly programId: ProgramId;
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
  readonly category: SolutionCategory;
  readonly bodySystems: BodySystem[];
  readonly healthGoals: string[]; // e.g. "lose weight", "reduce BP", "better sleep"
  readonly symptoms: string[]; // non-diagnostic, e.g. "fatigue", "poor sleep"
  readonly lifestyleGoals: string[]; // e.g. "more energy", "stress reduction"
}

// ---------------------------------------------------------------------------
// Marketplace listing
// ---------------------------------------------------------------------------

export type ListingStatus = "draft" | "pending_review" | "published" | "unlisted" | "retired" | "suspended";

export interface MarketplaceListing {
  readonly id: ListingId;
  readonly programId: ProgramId;
  readonly solution: HealthSolution;
  readonly status: ListingStatus;
  readonly developerId: string;
  readonly developerName: string;
  readonly organizationId?: OrgId;
  readonly organizationName?: string;
  readonly supportedCountries: string[];
  readonly supportedLanguages: string[];
  readonly measurementRequirements: string[];
  readonly technicianRequirements: string[];
  readonly estimatedEffortHoursPerWeek: number;
  readonly competitionDetails?: { competitionId: string; rewardStructure: string };
  readonly pricing: PricingModel;
  readonly supportedDevices: string[];
  readonly privacyPractices: string[];
  readonly screenshots: string[];
  readonly videos: string[];
  readonly tutorials: string[];
  readonly faq: { question: string; answer: string }[];
  readonly version: string;
  readonly changelog: { version: string; notes: string; date: string }[];
  readonly publishedAt?: string;
  readonly retiredAt?: string;
  readonly installCount: number;
  readonly activeInstallCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type PricingType =
  | "free"
  | "one_time"
  | "subscription"
  | "freemium"
  | "enterprise_licensing"
  | "government_licensing"
  | "employer_licensing"
  | "consumables"
  | "premium_ai"
  | "premium_content"
  | "marketplace_bundle"
  | "measurement_package";

export interface PricingModel {
  readonly type: PricingType;
  readonly price?: number;
  readonly currency?: string;
  readonly subscriptionPeriod?: "monthly" | "quarterly" | "annual";
  readonly freeTierFeatures?: string[];
  readonly premiumTierFeatures?: string[];
  readonly trialDays?: number;
}

// ---------------------------------------------------------------------------
// Outcome metrics (standardized, auto-updated)
// ---------------------------------------------------------------------------

export interface OutcomeMetrics {
  readonly id: OutcomeMetricId;
  readonly listingId: ListingId;
  readonly averageImprovement: number; // percentage
  readonly medianImprovement: number;
  readonly completionRate: number; // 0-1
  readonly retention30Day: number; // 0-1
  readonly retention90Day: number; // 0-1
  readonly verifiedMeasurementsCollected: number;
  readonly competitionParticipants: number;
  readonly averageRewardEarnings: number;
  readonly evidenceQualityScore: number; // 0-100
  readonly researchConfidence: number; // 0-1
  readonly populationSize: number;
  readonly lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceType =
  | "scientific_publication"
  | "clinical_trial"
  | "observational_study"
  | "traditional_evidence"
  | "community_evidence"
  | "program_methodology"
  | "known_limitations"
  | "independent_review";

export type EvidenceConfidenceLevel = "anecdotal" | "preliminary" | "moderate" | "strong" | "peer_reviewed";

export interface EvidenceEntry {
  readonly id: string;
  readonly type: EvidenceType;
  readonly title: string;
  readonly description: string;
  readonly confidence: EvidenceConfidenceLevel;
  readonly reference?: string;
  readonly url?: string;
  readonly date?: string;
}

export interface EvidencePage {
  readonly id: EvidencePageId;
  readonly listingId: ListingId;
  readonly entries: EvidenceEntry[];
  readonly methodology: string;
  readonly knownLimitations: string;
  readonly overallConfidence: EvidenceConfidenceLevel;
  readonly outcomeHistory: { period: string; improvement: number; sampleSize: number }[];
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// AI suitability matching
// ---------------------------------------------------------------------------

export interface SuitabilityScore {
  readonly id: SuitabilityScoreId;
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly score: number; // 0-100
  readonly factors: SuitabilityFactor[];
  readonly explanation: string;
  readonly estimatedOutcome: string;
  readonly estimatedTimeToResults: string;
  readonly estimatedCost: string;
  readonly computedAt: string;
}

export interface SuitabilityFactor {
  readonly name: string;
  readonly value: string;
  readonly weight: number;
  readonly positive: boolean;
}

// ---------------------------------------------------------------------------
// Discovery / search
// ---------------------------------------------------------------------------

export interface DiscoveryQuery {
  readonly text?: string;
  readonly healthGoals?: string[];
  readonly bodySystems?: BodySystem[];
  readonly symptoms?: string[];
  readonly lifestyleGoals?: string[];
  readonly category?: SolutionCategory;
  readonly ageRange?: string;
  readonly gender?: string;
  readonly country?: string;
  readonly language?: string;
  readonly maxBudget?: number;
  readonly evidenceLevel?: EvidenceConfidenceLevel;
  readonly competitionRewardsOnly?: boolean;
  readonly developerId?: string;
  readonly organizationId?: OrgId;
  readonly sortBy?: "suitability" | "outcomes" | "evidence" | "popularity" | "recent" | "price_low" | "price_high";
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export interface Collection {
  readonly id: CollectionId;
  readonly name: string;
  readonly description: string;
  readonly curator: string;
  readonly listingIds: ListingId[];
  readonly category: SolutionCategory | "curated" | "seasonal" | "editorial";
  readonly bannerUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export type ReviewType = "participant" | "technician" | "organization" | "developer" | "independent";

export interface Review {
  readonly id: ReviewId;
  readonly listingId: ListingId;
  readonly authorId: AccountId;
  readonly authorType: ReviewType;
  readonly authorName: string;
  readonly rating: number; // 1-5
  readonly title: string;
  readonly body: string;
  readonly verified: boolean;
  readonly outcomeBased: boolean;
  readonly improvementReported?: number; // percentage
  readonly durationUsedDays?: number;
  readonly createdAt: string;
  readonly helpfulCount: number;
  readonly reported: boolean;
}

// ---------------------------------------------------------------------------
// Installation & licensing
// ---------------------------------------------------------------------------

export type InstallationStatus = "pending" | "active" | "paused" | "uninstalled" | "expired";

export interface Installation {
  readonly id: InstallationId;
  readonly listingId: ListingId;
  readonly programId: ProgramId;
  readonly participantId: AccountId;
  readonly status: InstallationStatus;
  readonly version: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly licenseId?: LicenseId;
  readonly permissionsShown: string[];
  readonly consentReference?: string;
}

export type LicenseStatus = "active" | "expired" | "revoked" | "trial" | "cancelled";

export interface License {
  readonly id: LicenseId;
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly pricingType: PricingType;
  readonly status: LicenseStatus;
  readonly startDate: string;
  readonly endDate?: string;
  readonly trialEndDate?: string;
  readonly purchaseIntentId?: PurchaseIntentId;
  readonly entitlementId?: EntitlementId;
}

export type PurchaseIntentStatus = "pending" | "confirmed" | "failed" | "refunded";

export interface PurchaseIntent {
  readonly id: PurchaseIntentId;
  readonly listingId: ListingId;
  readonly participantId: AccountId;
  readonly pricingType: PricingType;
  readonly amount: number;
  readonly currency: string;
  readonly status: PurchaseIntentStatus;
  readonly createdAt: string;
  readonly confirmedAt?: string;
  readonly entitlementId?: EntitlementId;
  readonly metadata?: Record<string, unknown>;
}

export interface Entitlement {
  readonly id: EntitlementId;
  readonly licenseId: LicenseId;
  readonly features: string[];
  readonly active: boolean;
  readonly grantedAt: string;
  readonly revokedAt?: string;
}

// ---------------------------------------------------------------------------
// Revenue sharing
// ---------------------------------------------------------------------------

export type RevenueRecipientType =
  | "developer"
  | "platform"
  | "prize_pool"
  | "organization"
  | "affiliate"
  | "researcher"
  | "insurance_partner"
  | "government_program"
  | "charity"
  | "custom";

export interface RevenueShareRule {
  readonly id: RevenueShareId;
  readonly listingId: ListingId;
  readonly name: string;
  readonly allocations: RevenueAllocation[];
  readonly active: boolean;
  readonly createdAt: string;
}

export interface RevenueAllocation {
  readonly id: RevenueAllocationId;
  readonly recipientType: RevenueRecipientType;
  readonly recipientId: string;
  readonly percentage: number;
}

export interface RevenueEvent {
  readonly id: string;
  readonly listingId: ListingId;
  readonly purchaseIntentId: PurchaseIntentId;
  readonly grossAmount: number;
  readonly currency: string;
  readonly allocations: { recipientType: RevenueRecipientType; recipientId: string; amount: number; percentage: number }[];
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface Comparison {
  readonly id: ComparisonId;
  readonly listingIds: ListingId[];
  readonly participantId?: AccountId;
  readonly createdAt: string;
  readonly dimensions: ComparisonDimension[];
}

export interface ComparisonDimension {
  readonly name: string;
  readonly values: Record<string, unknown>; // listingId -> value
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MarketplaceErrorCategory =
  | "not_found"
  | "validation"
  | "state_conflict"
  | "not_authorized"
  | "payment_required"
  | "not_available"
  | "quota_exceeded";

export class MarketplaceError extends Error {
  readonly code: string;
  readonly category: MarketplaceErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: MarketplaceErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "MarketplaceError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A marketplace error occurred.";
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
// Marketplace events
// ---------------------------------------------------------------------------

export const MARKETPLACE_EVENTS = {
  listingPublished: "eks.marketplace.listing.published",
  listingRetired: "eks.marketplace.listing.retired",
  listingSuspended: "eks.marketplace.listing.suspended",
  solutionSearched: "eks.marketplace.solution.searched",
  recommendationGenerated: "eks.marketplace.recommendation.generated",
  outcomeMetricsUpdated: "eks.marketplace.outcomes.updated",
  evidenceUpdated: "eks.marketplace.evidence.updated",
  reviewSubmitted: "eks.marketplace.review.submitted",
  reviewVerified: "eks.marketplace.review.verified",
  installationStarted: "eks.marketplace.installation.started",
  installationCompleted: "eks.marketplace.installation.completed",
  installationUninstalled: "eks.marketplace.installation.uninstalled",
  purchaseIntentCreated: "eks.marketplace.purchase.intent_created",
  purchaseConfirmed: "eks.marketplace.purchase.confirmed",
  purchaseRefunded: "eks.marketplace.purchase.refunded",
  entitlementGranted: "eks.marketplace.entitlement.granted",
  entitlementRevoked: "eks.marketplace.entitlement.revoked",
  revenueAllocated: "eks.marketplace.revenue.allocated",
  collectionCreated: "eks.marketplace.collection.created",
  comparisonCreated: "eks.marketplace.comparison.created",
  programUpdated: "eks.marketplace.program.updated",
  programRolledBack: "eks.marketplace.program.rolled_back",
} as const;

export type MarketplaceEventType = (typeof MARKETPLACE_EVENTS)[keyof typeof MARKETPLACE_EVENTS];

export { type AccountId, type OrgId, type ProgramId };
