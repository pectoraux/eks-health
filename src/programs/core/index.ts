/**
 * Eks-Health Program OS — Core Primitives
 *
 * Foundational types for Programs, Extensions, and the Program Operating
 * System. The platform knows ONLY generic concepts: Programs, Extensions,
 * Resources, Capabilities, Permissions, Events. It NEVER knows disease-
 * specific logic — that lives entirely inside Programs.
 *
 * Built on the kernel (events, ids, errors) and identity (authorization,
 * consent, audit). Programs are autonomous applications executing inside
 * a controlled, isolated, capability-bounded runtime.
 */

import "server-only";
import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
} from "@/kernel";
import type { AccountId, OrgId } from "@/identity";

// ---------------------------------------------------------------------------
// Branded program identifiers
// ---------------------------------------------------------------------------

export type ProgramId = Brand<string, "ProgramId">;
export type ExtensionId = Brand<string, "ExtensionId">;
export type ProgramVersionId = Brand<string, "ProgramVersionId">;
export type DeveloperId = Brand<string, "DeveloperId">;
export type PublisherId = Brand<string, "PublisherId">;
export type SandboxId = Brand<string, "SandboxId">;
export type CapabilityGrantId = Brand<string, "CapabilityGrantId">;
export type ResourceHandleId = Brand<string, "ResourceHandleId">;
export type SubscriptionId = Brand<string, "SubscriptionId">;
export type CertificationId = Brand<string, "CertificationId">;
export type ListingId = Brand<string, "ListingId">;
export type PackageId = Brand<string, "PackageId">;

export function asProgramId(s: string): ProgramId { return s as ProgramId; }
export function asExtensionId(s: string): ExtensionId { return s as ExtensionId; }
export function asProgramVersionId(s: string): ProgramVersionId { return s as ProgramVersionId; }
export function asDeveloperId(s: string): DeveloperId { return s as DeveloperId; }
export function asPublisherId(s: string): PublisherId { return s as PublisherId; }
export function asSandboxId(s: string): SandboxId { return s as SandboxId; }
export function asCapabilityGrantId(s: string): CapabilityGrantId { return s as CapabilityGrantId; }
export function asResourceHandleId(s: string): ResourceHandleId { return s as ResourceHandleId; }
export function asSubscriptionId(s: string): SubscriptionId { return s as SubscriptionId; }
export function asCertificationId(s: string): CertificationId { return s as CertificationId; }
export function asListingId(s: string): ListingId { return s as ListingId; }
export function asPackageId(s: string): PackageId { return s as PackageId; }

// ---------------------------------------------------------------------------
// Program vs Extension
// ---------------------------------------------------------------------------

/**
 * A Program is an autonomous health application (e.g. a cardiovascular
 * prevention program, a diabetes prevention program, a sleep optimizer).
 * An Extension is a smaller plugin that augments the platform or a Program.
 */
export type ProgramKind = "program" | "extension";

// ---------------------------------------------------------------------------
// Semantic versioning
// ---------------------------------------------------------------------------

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string; // e.g. "beta.1", "alpha.3", "rc.2"
  readonly build?: string;
}

export function parseSemVer(s: string): SemVer {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/);
  if (!m) throw new Error(`Invalid semver: ${s}`);
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4],
    build: m[5],
  };
}

export function semVerToString(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease) s += `-${v.prerelease}`;
  if (v.build) s += `+${v.build}`;
  return s;
}

export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // prerelease: absence > presence (1.0.0 > 1.0.0-beta)
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

// ---------------------------------------------------------------------------
// Release channels
// ---------------------------------------------------------------------------

export type ReleaseChannel = "stable" | "beta" | "alpha" | "internal" | "canary";

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ["stable", "beta", "alpha", "internal", "canary"];

// ---------------------------------------------------------------------------
// Capability identifiers
// ---------------------------------------------------------------------------

export type CapabilityId =
  | "measurement"
  | "competition"
  | "leaderboard"
  | "mission"
  | "reward"
  | "notification"
  | "search"
  | "storage"
  | "analytics"
  | "scheduling"
  | "research"
  | "profile"
  | "ai"
  | "media"
  | "event-subscription"
  | "background-execution";

export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly label: string;
  readonly description: string;
  readonly sensitive: boolean;
  readonly requiresConsent: boolean;
  readonly defaultQuota: Partial<ResourceQuota>;
}

// ---------------------------------------------------------------------------
// Resource quota
// ---------------------------------------------------------------------------

export interface ResourceQuota {
  readonly cpuShares: number; // relative weight
  readonly memoryMb: number;
  readonly storageMb: number;
  readonly apiRequestsPerMinute: number;
  readonly backgroundJobs: number;
  readonly notificationsPerDay: number;
  readonly scheduledJobs: number;
  readonly concurrentExecutions: number;
  readonly aiRequestsPerDay: number;
  readonly searchIndexingDocs: number;
  readonly analyticsEventsPerDay: number;
}

export const DEFAULT_PROGRAM_QUOTA: ResourceQuota = {
  cpuShares: 256,
  memoryMb: 128,
  storageMb: 50,
  apiRequestsPerMinute: 100,
  backgroundJobs: 5,
  notificationsPerDay: 50,
  scheduledJobs: 10,
  concurrentExecutions: 3,
  aiRequestsPerDay: 100,
  searchIndexingDocs: 1000,
  analyticsEventsPerDay: 10000,
};

// ---------------------------------------------------------------------------
// Program state machine
// ---------------------------------------------------------------------------

export type ProgramState =
  | "draft" // developer editing
  | "built" // packaged
  | "signed" // cryptographically signed
  | "validated" // manifest validated
  | "uploaded" // uploaded to platform
  | "in_review" // certification pipeline running
  | "certified" // passed automated review
  | "rejected" // failed review
  | "published" // listed on marketplace
  | "installed" // installed by a user/org
  | "active" // running
  | "paused" // temporarily stopped
  | "disabled" // administratively disabled
  | "deprecated" // superseded, no new installs
  | "archived" // removed from marketplace, kept for audit
  | "uninstalled"; // removed from a tenant

export type ProgramLifecycleEvent =
  | "created" | "built" | "signed" | "validated" | "uploaded"
  | "review_started" | "certified" | "rejected" | "published"
  | "installed" | "activated" | "paused" | "resumed" | "disabled"
  | "deprecated" | "archived" | "transferred" | "forked"
  | "rolled_back" | "uninstalled" | "upgraded";

// ---------------------------------------------------------------------------
// Program errors
// ---------------------------------------------------------------------------

export type ProgramErrorCategory =
  | "manifest_invalid"
  | "signature_invalid"
  | "certification_failed"
  | "quota_exceeded"
  | "capability_denied"
  | "sandbox_violation"
  | "dependency_conflict"
  | "version_conflict"
  | "not_found"
  | "state_conflict"
  | "validation"
  | "runtime_error";

export class ProgramError extends Error {
  readonly code: string;
  readonly category: ProgramErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: ProgramErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "ProgramError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A program error occurred.";
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
// Program event types (published to kernel event bus)
// ---------------------------------------------------------------------------

export const PROGRAM_EVENTS = {
  created: "eks.program.created",
  built: "eks.program.built",
  signed: "eks.program.signed",
  uploaded: "eks.program.uploaded",
  reviewStarted: "eks.program.review.started",
  certified: "eks.program.certified",
  rejected: "eks.program.rejected",
  published: "eks.program.published",
  installed: "eks.program.installed",
  activated: "eks.program.activated",
  paused: "eks.program.paused",
  resumed: "eks.program.resumed",
  disabled: "eks.program.disabled",
  deprecated: "eks.program.deprecated",
  archived: "eks.program.archived",
  uninstalled: "eks.program.uninstalled",
  upgraded: "eks.program.upgraded",
  rolledBack: "eks.program.rolled_back",
  capabilityGranted: "eks.program.capability.granted",
  capabilityRevoked: "eks.program.capability.revoked",
  quotaExceeded: "eks.program.quota.exceeded",
  sandboxViolation: "eks.program.sandbox.violation",
  backgroundJobFailed: "eks.program.background.failed",
  certified_v2: "eks.program.certified.v2",
} as const;

export type ProgramEventType = (typeof PROGRAM_EVENTS)[keyof typeof PROGRAM_EVENTS];

// ---------------------------------------------------------------------------
// Well-known platform event topics Programs may subscribe to
// ---------------------------------------------------------------------------

export const PLATFORM_EVENT_TOPICS = {
  userJoined: "eks.identity.account.registered",
  userVerified: "eks.identity.account.verified",
  measurementRecorded: "eks.measurement.recorded",
  competitionStarted: "eks.competition.started",
  competitionEnded: "eks.competition.ended",
  missionCompleted: "eks.mission.completed",
  consentGranted: "eks.identity.consent.granted",
  consentRevoked: "eks.identity.consent.revoked",
  rewardDistributed: "eks.reward.distributed",
  leaderboardUpdated: "eks.leaderboard.updated",
  programUpgraded: "eks.program.upgraded",
  orgCreated: "eks.identity.org.created",
} as const;

// ---------------------------------------------------------------------------
// Installation context
// ---------------------------------------------------------------------------

export interface InstallContext {
  readonly programId: ProgramId;
  readonly versionId: ProgramVersionId;
  readonly tenantId?: TenantId;
  readonly accountId: AccountId;
  readonly orgId?: OrgId;
  readonly installedAt: string;
  readonly channel: ReleaseChannel;
  readonly pinnedVersion?: SemVer;
}

// ---------------------------------------------------------------------------
// Privacy & AI declarations (in the manifest)
// ---------------------------------------------------------------------------

export interface PrivacyDeclaration {
  readonly dataCollected: string[];
  readonly dataUsage: string;
  readonly thirdPartySharing: boolean;
  readonly retentionDays: number;
  readonly anonymizationApplied: boolean;
  readonly residencyRegions: string[];
}

export interface AIUsageDeclaration {
  readonly usesAI: boolean;
  readonly provider?: string;
  readonly modelFamily?: string;
  readonly purpose?: string;
  readonly trainingDataUsed?: boolean;
  readonly humanReadableExplanation?: string;
}

// ---------------------------------------------------------------------------
// Generic resource definitions (measurement/competition/mission/etc schemas)
// Programs DEFINE these; the platform stores them generically.
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  readonly id: string;
  readonly type: "measurement" | "competition" | "leaderboard" | "mission" | "reward" | "score";
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>; // JSON schema for the resource
  readonly unit?: string;
  readonly category?: string;
  readonly privacyLevel: "public" | "internal" | "confidential" | "restricted";
}

export { type TenantId, type AccountId, type OrgId };
