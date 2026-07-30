/**
 * Eks-Health Program OS — Capability System
 *
 * Programs request capabilities; every capability is independently granted,
 * consent-checked, and quota-bounded. The platform NEVER grants unrestricted
 * API access — Programs receive only the capabilities they declare and the
 * user approves.
 */

import "server-only";
import {
  type CapabilityId,
  type CapabilityDescriptor,
  type ResourceQuota,
  type ProgramId,
  type CapabilityGrantId,
  type AccountId,
  ProgramError,
  asCapabilityGrantId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { PROGRAM_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Capability catalog
// ---------------------------------------------------------------------------

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  cap("measurement", "Measurement API", "Read/write health measurements for the program's defined metrics.", true, true, { apiRequestsPerMinute: 60 }),
  cap("competition", "Competition API", "Create and manage competitions defined by the program.", true, true, { apiRequestsPerMinute: 30 }),
  cap("leaderboard", "Leaderboard API", "Read and update leaderboards for the program.", false, true, { apiRequestsPerMinute: 60 }),
  cap("mission", "Mission API", "Define and track participant missions.", false, true, { apiRequestsPerMinute: 30 }),
  cap("reward", "Reward API", "Distribute rewards to participants.", true, true, { apiRequestsPerMinute: 10 }),
  cap("notification", "Notification API", "Send notifications via platform channels.", false, false, { notificationsPerDay: 50 }),
  cap("search", "Search API", "Index and query the platform search service.", false, false, { searchIndexingDocs: 1000 }),
  cap("storage", "Storage API", "Isolated program storage (structured, documents, media).", false, false, { storageMb: 50 }),
  cap("analytics", "Analytics API", "Emit analytics events for the program.", false, false, { analyticsEventsPerDay: 10000 }),
  cap("scheduling", "Scheduling API", "Schedule background jobs and cron tasks.", false, false, { scheduledJobs: 10 }),
  cap("research", "Research API", "Request de-identified research data access.", true, true, { apiRequestsPerMinute: 10 }),
  cap("profile", "Profile API", "Read participant profile fields (consent-gated).", true, true, { apiRequestsPerMinute: 30 }),
  cap("ai", "AI API", "Invoke AI prompt execution and agent runtime.", true, true, { aiRequestsPerDay: 100 }),
  cap("media", "Media API", "Upload and serve media assets.", false, false, { storageMb: 100 }),
  cap("event-subscription", "Event Subscription", "Subscribe to platform events.", false, false, { backgroundJobs: 5 }),
  cap("background-execution", "Background Execution", "Run background workers and queue processors.", false, false, { backgroundJobs: 5, concurrentExecutions: 3 }),
];

function cap(
  id: CapabilityId,
  label: string,
  description: string,
  sensitive: boolean,
  requiresConsent: boolean,
  defaultQuota: Partial<ResourceQuota>,
): CapabilityDescriptor {
  return { id, label, description, sensitive, requiresConsent, defaultQuota };
}

const CAPABILITY_INDEX = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function getCapability(id: CapabilityId): CapabilityDescriptor | undefined {
  return CAPABILITY_INDEX.get(id);
}

export function listCapabilities(): readonly CapabilityDescriptor[] {
  return CAPABILITIES;
}

// ---------------------------------------------------------------------------
// Capability grant
// ---------------------------------------------------------------------------

export interface CapabilityGrant {
  readonly id: CapabilityGrantId;
  readonly programId: ProgramId;
  readonly capability: CapabilityId;
  readonly accountId: AccountId;
  readonly grantedAt: string;
  readonly grantedBy: string;
  readonly fields?: string[];
  readonly purposes?: string[];
  readonly scope?: "self" | "participant" | "cohort" | "all";
  readonly active: boolean;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
  readonly quotaOverride?: Partial<ResourceQuota>;
}

// ---------------------------------------------------------------------------
// Capability manager
// ---------------------------------------------------------------------------

export class CapabilityManager {
  private readonly grants = new Map<CapabilityGrantId, CapabilityGrant>();
  private readonly byProgram = new Map<ProgramId, CapabilityGrantId[]>();
  private readonly byAccount = new Map<AccountId, CapabilityGrantId[]>();

  /** Grant a capability to a program for a specific account. */
  grant(input: {
    programId: ProgramId;
    capability: CapabilityId;
    accountId: AccountId;
    grantedBy: string;
    fields?: string[];
    purposes?: string[];
    scope?: "self" | "participant" | "cohort" | "all";
    quotaOverride?: Partial<ResourceQuota>;
  }): CapabilityGrant {
    const cap = CAPABILITY_INDEX.get(input.capability);
    if (!cap) {
      throw new ProgramError({
        code: "eks.program.capability.unknown",
        category: "capability_denied",
        message: `Unknown capability: ${input.capability}`,
        userMessage: "This capability does not exist.",
      });
    }
    // Check for duplicate active grant
    const existing = this.findByProgramAccountCapability(input.programId, input.accountId, input.capability);
    if (existing && existing.active) return existing;

    const grant: CapabilityGrant = {
      id: asCapabilityGrantId(generateId("cap_")),
      programId: input.programId,
      capability: input.capability,
      accountId: input.accountId,
      grantedAt: getClock().iso(),
      grantedBy: input.grantedBy,
      fields: input.fields,
      purposes: input.purposes,
      scope: input.scope ?? "self",
      active: true,
      quotaOverride: input.quotaOverride,
    };
    this.grants.set(grant.id, grant);
    const pList = this.byProgram.get(input.programId) ?? [];
    this.byProgram.set(input.programId, [...pList, grant.id]);
    const aList = this.byAccount.get(input.accountId) ?? [];
    this.byAccount.set(input.accountId, [...aList, grant.id]);

    void getEventBus().publish(
      buildEvent(PROGRAM_EVENTS.capabilityGranted, {
        programId: input.programId, capability: input.capability,
        accountId: input.accountId, fields: input.fields, purposes: input.purposes,
      }, {}, "domain"),
    );
    return grant;
  }

  revoke(grantId: CapabilityGrantId, reason: string): void {
    const g = this.grants.get(grantId);
    if (!g) return;
    this.grants.set(grantId, { ...g, active: false, revokedAt: getClock().iso(), revokedReason: reason });
    void getEventBus().publish(
      buildEvent(PROGRAM_EVENTS.capabilityRevoked, { programId: g.programId, capability: g.capability, accountId: g.accountId, reason }, {}, "domain"),
    );
  }

  /** Check if a program has an active grant for a capability for an account. */
  hasGrant(programId: ProgramId, accountId: AccountId, capability: CapabilityId): boolean {
    const g = this.findByProgramAccountCapability(programId, accountId, capability);
    return !!g && g.active;
  }

  /** Get all active grants for a program+account. */
  getGrants(programId: ProgramId, accountId: AccountId): CapabilityGrant[] {
    const pIds = this.byProgram.get(programId) ?? [];
    return pIds
      .map((id) => this.grants.get(id)!)
      .filter((g) => g && g.accountId === accountId && g.active);
  }

  /** Get the effective quota for a capability (grant override > capability default). */
  getEffectiveQuota(programId: ProgramId, accountId: AccountId, capability: CapabilityId): Partial<ResourceQuota> | undefined {
    const grant = this.findByProgramAccountCapability(programId, accountId, capability);
    if (!grant || !grant.active) return undefined;
    const cap = CAPABILITY_INDEX.get(capability);
    return { ...cap?.defaultQuota, ...grant.quotaOverride };
  }

  listGrants(): CapabilityGrant[] {
    return [...this.grants.values()];
  }

  listGrantsForProgram(programId: ProgramId): CapabilityGrant[] {
    return (this.byProgram.get(programId) ?? [])
      .map((id) => this.grants.get(id)!)
      .filter((g) => g);
  }

  private findByProgramAccountCapability(programId: ProgramId, accountId: AccountId, capability: CapabilityId): CapabilityGrant | undefined {
    const ids = this.byProgram.get(programId) ?? [];
    return ids
      .map((id) => this.grants.get(id)!)
      .find((g) => g && g.accountId === accountId && g.capability === capability);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: CapabilityManager | null = null;
export function getCapabilities(): CapabilityManager {
  if (!_mgr) _mgr = new CapabilityManager();
  return _mgr;
}
