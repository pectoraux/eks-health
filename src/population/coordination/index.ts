/**
 * Eks-Health Population Platform — Multi-Organization Coordination
 *
 * Participants belong to multiple organizations simultaneously (employer +
 * university + insurer + sports club + community). When two or more of
 * those organizations touch the same participant on the same dimension,
 * the platform resolves the conflict deterministically and explains its
 * decision. Four conflict surfaces are handled:
 *
 *   1. Funding conflicts   — multiple orgs offer funding for the same
 *                            target (e.g. a measurement session). Resolved
 *                            by fixed priority: employer > government >
 *                            insurance > ngo > community.
 *   2. Program duplication  — the same Program is sponsored by multiple
 *                            orgs. Reported (no auto-resolution; the
 *                            participant keeps one install).
 *   3. Competition overlap  — multiple org-bound competitions overlap in
 *                            time for the same participant. Reported.
 *   4. Permission conflicts — multiple orgs hold conflicting privacy
 *                            grants for the same field. Resolved by the
 *                            MOST RESTRICTIVE grant. Participant privacy
 *                            ALWAYS wins: if any involved org has no
 *                            active grant covering the field, the field
 *                            is hidden from all orgs.
 *
 * Every resolution returns a human-readable explanation so the platform's
 * decisions are auditable and explainable.
 *
 * Built on all prior milestones. Pure TS, strict, ESM. No external deps.
 */

import "server-only";
import {
  type AccountId,
  type PopulationOrgId,
  type ProgramId,
  type FundingTargetType,
  type OrganizationType,
  type PrivacyGrantType,
  PopulationError,
  POPULATION_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getHierarchy } from "../hierarchy";
import { getMemberships } from "../membership";
import { getPrivacyFirewall } from "../privacy-firewall";
import { getOrgCatalog } from "../org-marketplace";
import { getOrgTwin } from "../org-twin";

// ---------------------------------------------------------------------------
// Funding API (defensive — built by m12-2 in parallel; may be absent)
// ---------------------------------------------------------------------------

interface FundingPolicyLike {
  readonly id: string;
  readonly orgId: PopulationOrgId;
  readonly targetType: FundingTargetType;
  readonly maxAmountPerParticipant: number;
  readonly maxAmountTotal: number;
  readonly currency: string;
  readonly active: boolean;
}

interface FundingApi {
  listPolicies?(filter?: { orgId?: PopulationOrgId }): FundingPolicyLike[];
}

let _fundingCache: FundingApi | null | undefined;
async function loadFunding(): Promise<FundingApi | null> {
  if (_fundingCache !== undefined) return _fundingCache;
  try {
    const mod = await import("../funding");
    const getter = (mod as { getFunding?: () => FundingApi }).getFunding;
    _fundingCache = getter ? getter() : null;
  } catch {
    _fundingCache = null;
  }
  return _fundingCache;
}

// ---------------------------------------------------------------------------
// Competitions API (defensive)
// ---------------------------------------------------------------------------

interface CompetitionLike {
  readonly id: string;
  readonly programId: ProgramId;
  readonly name: string;
  readonly state: string;
  readonly currentParticipants: number;
  readonly scope?: string;
  readonly scopeFilter?: Record<string, unknown>;
  readonly startsAt?: string;
  readonly endsAt?: string;
}

interface CompetitionsApi {
  list(filter?: { programId?: ProgramId; state?: string; scope?: string }): CompetitionLike[];
}

let _competitionsCache: CompetitionsApi | null | undefined;
async function loadCompetitions(): Promise<CompetitionsApi | null> {
  if (_competitionsCache !== undefined) return _competitionsCache;
  try {
    const mod = await import("@/competitions");
    const getter = (mod as { getCompetitions?: () => CompetitionsApi }).getCompetitions;
    _competitionsCache = getter ? getter() : null;
  } catch {
    _competitionsCache = null;
  }
  return _competitionsCache;
}

// ---------------------------------------------------------------------------
// Org-type priority for funding conflict resolution
// ---------------------------------------------------------------------------

/**
 * Higher number = higher priority. The named ordering from the spec
 * (employer > government > insurance > ngo > community) is preserved, with
 * other organization types ranked sensibly between insurance and ngo so
 * the spec's relative order is never violated.
 */
const ORG_PRIORITY: Record<OrganizationType, number> = {
  employer: 100,
  government: 90,
  insurance_provider: 80,
  hospital: 75,
  clinic: 74,
  university: 73,
  school: 72,
  research_institution: 71,
  military: 70,
  religious_organization: 68,
  sports_club: 67,
  ngo: 60,
  community: 50,
  custom: 10,
};

// ---------------------------------------------------------------------------
// Restrictiveness of privacy grant types
// ---------------------------------------------------------------------------
// Higher number = MORE permissive (exposes more). Lower = MORE restrictive.
// `specific_measurement` is the MOST restrictive because it only exposes the
// exact fields the participant named in scope; `attendance_only` is the
// least restrictive for an attendance-bearing context.

const GRANT_PERMISSIVENESS: Record<PrivacyGrantType, number> = {
  specific_measurement: 10,
  custom: 20,
  wellness_certificate: 30,
  achievements: 40,
  program_progress: 50,
  aggregate_performance: 60,
  competition_status: 70,
  attendance_only: 80,
};

// ---------------------------------------------------------------------------
// Resolution result shapes
// ---------------------------------------------------------------------------

export interface FundingConflictResolution {
  readonly participantId: AccountId;
  readonly targetType: FundingTargetType;
  readonly winningOrgId: PopulationOrgId | null;
  readonly winningOrgName?: string;
  readonly winningPolicyId?: string;
  readonly considerationSet: { orgId: PopulationOrgId; orgName: string; orgType: OrganizationType; priority: number; policyId?: string; maxPerParticipant?: number }[];
  readonly explanation: string;
  readonly resolvedAt: string;
}

export interface ProgramDuplication {
  readonly programId: ProgramId;
  readonly sponsoringOrgs: { orgId: PopulationOrgId; orgName: string; catalogId: string }[];
  readonly recommendation: string;
}

export interface CompetitionOverlap {
  readonly competitionA: { id: string; name: string; orgId: PopulationOrgId; startsAt?: string; endsAt?: string };
  readonly competitionB: { id: string; name: string; orgId: PopulationOrgId; startsAt?: string; endsAt?: string };
  readonly overlapDays: number;
  readonly recommendation: string;
}

export interface PermissionConflictResolution {
  readonly participantId: AccountId;
  readonly field: string;
  readonly decision: "denied" | "granted_restricted" | "granted";
  readonly winningOrgId: PopulationOrgId | null;
  readonly winningGrantType?: PrivacyGrantType;
  readonly considerationSet: { orgId: PopulationOrgId; orgName: string; hasGrant: boolean; grantType?: PrivacyGrantType; permissiveness?: number }[];
  readonly explanation: string;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class MultiOrgCoordinator {
  private resolvedCount = 0;
  private readonly byType = new Map<string, number>();

  /**
   * Resolve a funding conflict: when multiple orgs offer an active funding
   * policy for the same target type, the org with the highest priority wins.
   * Priority: employer > government > insurance > ngo > community.
   */
  async resolveFundingConflict(
    participantId: AccountId,
    targetType: FundingTargetType,
  ): Promise<FundingConflictResolution> {
    const memberships = getMemberships().listByAccount(participantId, true);
    const orgIds = memberships.map((m) => m.orgId);
    const hierarchy = getHierarchy();

    const considerationSet: FundingConflictResolution["considerationSet"] = [];
    for (const orgId of orgIds) {
      const org = hierarchy.get(orgId);
      if (!org) continue;
      const priority = ORG_PRIORITY[org.type] ?? 0;
      let policyId: string | undefined;
      let maxPerParticipant: number | undefined;
      try {
        const funding = await loadFunding();
        if (funding?.listPolicies) {
          const policies = funding.listPolicies({ orgId }) ?? [];
          const matching = policies.find((p) => p.active && p.targetType === targetType);
          if (matching) {
            policyId = matching.id;
            maxPerParticipant = matching.maxAmountPerParticipant;
          }
        }
      } catch {
        /* funding optional */
      }
      considerationSet.push({
        orgId,
        orgName: org.name,
        orgType: org.type,
        priority,
        policyId,
        maxPerParticipant,
      });
    }

    // Only orgs with an actual matching policy are candidates to win.
    const candidates = considerationSet.filter((c) => c.policyId !== undefined);
    candidates.sort((a, b) => b.priority - a.priority);
    const winner = candidates[0];

    let explanation: string;
    if (candidates.length === 0) {
      explanation = `No organization offers active funding for ${targetType} for participant ${participantId}.`;
    } else if (candidates.length === 1) {
      explanation = `Single funding source: ${winner!.orgName} (${winner!.orgType}) offers funding for ${targetType}. No conflict.`;
    } else {
      const chain = candidates
        .map((c) => `${c.orgName}(${c.orgType},p=${c.priority})`)
        .join(" > ");
      explanation = `Funding conflict for ${targetType}: ${candidates.length} orgs offer policies. Priority order: ${chain}. Winner: ${winner!.orgName}.`;
    }

    this.recordResolution("funding");
    void getEventBus().publish(
      buildEvent(
        "eks.population.coordination.funding_resolved",
        { participantId, targetType, winningOrgId: winner?.orgId ?? null, candidateCount: candidates.length },
        {},
        "domain",
      ),
    );

    return {
      participantId,
      targetType,
      winningOrgId: winner?.orgId ?? null,
      winningOrgName: winner?.orgName,
      winningPolicyId: winner?.policyId,
      considerationSet,
      explanation,
      resolvedAt: getClock().iso(),
    };
  }

  /**
   * Detect program duplication: same Program sponsored by 2+ orgs for the
   * same participant. Returns one entry per duplicated program.
   */
  detectProgramDuplication(participantId: AccountId): ProgramDuplication[] {
    const memberships = getMemberships().listByAccount(participantId, true);
    const hierarchy = getHierarchy();
    const catalogMgr = getOrgCatalog();
    const dups: ProgramDuplication[] = [];

    const sponsorsByProgram = new Map<ProgramId, { orgId: PopulationOrgId; orgName: string; catalogId: string }[]>();
    for (const m of memberships) {
      const org = hierarchy.get(m.orgId);
      if (!org) continue;
      const catalogs = catalogMgr.list(m.orgId);
      for (const cat of catalogs) {
        for (const pid of cat.sponsoredProgramIds) {
          const list = sponsorsByProgram.get(pid) ?? [];
          list.push({ orgId: m.orgId, orgName: org.name, catalogId: cat.id as string });
          sponsorsByProgram.set(pid, list);
        }
      }
    }
    for (const [programId, sponsors] of sponsorsByProgram.entries()) {
      if (sponsors.length < 2) continue;
      const uniqueOrgs = new Set(sponsors.map((s) => s.orgId as string));
      if (uniqueOrgs.size < 2) continue;
      dups.push({
        programId,
        sponsoringOrgs: sponsors,
        recommendation: `Program ${programId} is sponsored by ${sponsors.length} of the participant's organizations (${[...uniqueOrgs].join(", ")}). Consolidate sponsorship under one org to avoid double-billing.`,
      });
    }
    if (dups.length > 0) {
      this.recordResolution("program_duplication_detected");
    }
    return dups;
  }

  /**
   * Detect competition overlap: competitions scoped to (or sponsored via
   * programs of) two or more of the participant's orgs that overlap in time.
   */
  async detectCompetitionOverlap(participantId: AccountId): Promise<CompetitionOverlap[]> {
    const memberships = getMemberships().listByAccount(participantId, true);
    const hierarchy = getHierarchy();
    const orgIds = new Set(memberships.map((m) => m.orgId));
    const orgIdStrings = new Set([...orgIds].map((o) => o as string));

    const comps = await loadCompetitions();
    if (!comps) return [];
    const all = comps.list() ?? [];
    // Competitions relevant to the participant: scoped to one of the orgs,
    // OR linked to a program sponsored by one of the orgs.
    const catalogMgr = getOrgCatalog();
    const sponsoredProgramsByOrg = new Map<PopulationOrgId, Set<ProgramId>>();
    for (const m of memberships) {
      const cats = catalogMgr.list(m.orgId);
      const set = new Set<ProgramId>();
      for (const c of cats) for (const pid of c.sponsoredProgramIds) set.add(pid);
      sponsoredProgramsByOrg.set(m.orgId, set);
    }

    interface RelevantComp { id: string; name: string; programId: ProgramId; orgId: PopulationOrgId; startsAt?: string; endsAt?: string }
    const relevant: RelevantComp[] = [];
    for (const c of all) {
      const scopeFilter = c.scopeFilter as { orgId?: string } | undefined;
      const scopedOrgId = scopeFilter?.orgId;
      if (c.scope === "organizational" && scopedOrgId && orgIdStrings.has(scopedOrgId)) {
        relevant.push({
          id: c.id, name: c.name, programId: c.programId,
          orgId: scopedOrgId as PopulationOrgId, startsAt: c.startsAt, endsAt: c.endsAt,
        });
        continue;
      }
      for (const [orgId, programs] of sponsoredProgramsByOrg.entries()) {
        if (programs.has(c.programId)) {
          relevant.push({
            id: c.id, name: c.name, programId: c.programId,
            orgId, startsAt: c.startsAt, endsAt: c.endsAt,
          });
          break;
        }
      }
    }

    // Find overlapping pairs across DIFFERENT orgs.
    const overlaps: CompetitionOverlap[] = [];
    for (let i = 0; i < relevant.length; i++) {
      for (let j = i + 1; j < relevant.length; j++) {
        const a = relevant[i];
        const b = relevant[j];
        if (a.orgId === b.orgId) continue;
        const overlapDays = computeOverlapDays(a.startsAt, a.endsAt, b.startsAt, b.endsAt);
        if (overlapDays > 0) {
          const orgA = hierarchy.get(a.orgId);
          const orgB = hierarchy.get(b.orgId);
          overlaps.push({
            competitionA: { id: a.id, name: a.name, orgId: a.orgId, startsAt: a.startsAt, endsAt: a.endsAt },
            competitionB: { id: b.id, name: b.name, orgId: b.orgId, startsAt: b.startsAt, endsAt: b.endsAt },
            overlapDays,
            recommendation: `Competitions '${a.name}' (${orgA?.name ?? a.orgId}) and '${b.name}' (${orgB?.name ?? b.orgId}) overlap by ${overlapDays} day(s). Consider staggering schedules or merging.`,
          });
        }
      }
    }
    if (overlaps.length > 0) {
      this.recordResolution("competition_overlap_detected");
    }
    return overlaps;
  }

  /**
   * Resolve a privacy permission conflict for a single field across multiple
   * orgs. Resolution = MOST RESTRICTIVE grant. Participant privacy ALWAYS
   * wins: if ANY involved org has no active grant covering the field, the
   * field is denied to all orgs.
   */
  resolvePermissionConflict(
    participantId: AccountId,
    orgIds: PopulationOrgId[],
    field: string,
  ): PermissionConflictResolution {
    const hierarchy = getHierarchy();
    const firewall = getPrivacyFirewall();
    const considerationSet: PermissionConflictResolution["considerationSet"] = [];
    let anyMissing = false;
    let mostRestrictive: { orgId: PopulationOrgId; grantType: PrivacyGrantType; permissiveness: number } | null = null;

    for (const orgId of orgIds) {
      const org = hierarchy.get(orgId);
      const orgName = org?.name ?? (orgId as string);
      const visible = firewall.getVisibleData(participantId, orgId);
      const hasGrant = visible.visibleFields.includes(field);
      if (!hasGrant) anyMissing = true;
      // Identify the grant type covering this field (most-restrictive one if
      // multiple grants are active for this org).
      let grantType: PrivacyGrantType | undefined;
      let permissiveness: number | undefined;
      const activeGrants = firewall.getActiveGrants(participantId).filter((g) => g.orgId === orgId);
      for (const g of activeGrants) {
        const p = GRANT_PERMISSIVENESS[g.grantType] ?? 50;
        if (g.scope.includes(field) || g.grantType === "attendance_only" || g.grantType === "competition_status") {
          if (grantType === undefined || p < (permissiveness as number)) {
            grantType = g.grantType;
            permissiveness = p;
          }
        }
      }
      considerationSet.push({ orgId, orgName, hasGrant, grantType, permissiveness });
      if (hasGrant && grantType !== undefined) {
        if (!mostRestrictive || (permissiveness as number) < mostRestrictive.permissiveness) {
          mostRestrictive = { orgId, grantType, permissiveness: permissiveness as number };
        }
      }
    }

    let decision: PermissionConflictResolution["decision"];
    let winningOrgId: PopulationOrgId | null = null;
    let winningGrantType: PrivacyGrantType | undefined;
    let explanation: string;

    if (orgIds.length === 0) {
      decision = "denied";
      explanation = `No organizations in consideration set; field '${field}' is not shared.`;
    } else if (anyMissing) {
      decision = "denied";
      const missingOrgs = considerationSet.filter((c) => !c.hasGrant).map((c) => c.orgName);
      explanation = `Participant privacy wins: org(s) ${missingOrgs.join(", ")} have no active grant covering '${field}'. Field is hidden from all orgs.`;
    } else if (orgIds.length === 1) {
      decision = "granted";
      winningOrgId = (mostRestrictive ?? considerationSet[0]).orgId;
      winningGrantType = mostRestrictive?.grantType;
      explanation = `Single org ${considerationSet[0].orgName} holds grant '${winningGrantType}' for '${field}'. No conflict.`;
    } else {
      decision = "granted_restricted";
      winningOrgId = mostRestrictive!.orgId;
      winningGrantType = mostRestrictive!.grantType;
      const chain = considerationSet
        .filter((c) => c.hasGrant)
        .map((c) => `${c.orgName}(${c.grantType},p=${c.permissiveness})`)
        .join(", ");
      explanation = `Permission conflict for '${field}' across ${orgIds.length} orgs. Most restrictive grant wins: ${winningGrantType} from ${hierarchy.get(winningOrgId)?.name ?? winningOrgId}. Consideration: ${chain}.`;
    }

    this.recordResolution("permission");
    void getEventBus().publish(
      buildEvent(
        "eks.population.coordination.permission_resolved",
        { participantId, field, decision, winningOrgId, orgCount: orgIds.length },
        {},
        "domain",
      ),
    );

    return {
      participantId,
      field,
      decision,
      winningOrgId,
      winningGrantType,
      considerationSet,
      explanation,
      resolvedAt: getClock().iso(),
    };
  }

  /** Get the priority order of orgs for a participant and target type. */
  async getOrgPriority(
    participantId: AccountId,
    targetType: FundingTargetType,
  ): Promise<{
    participantId: AccountId;
    targetType: FundingTargetType;
    order: { orgId: PopulationOrgId; orgName: string; orgType: OrganizationType; priority: number; offersFunding: boolean }[];
  }> {
    const memberships = getMemberships().listByAccount(participantId, true);
    const hierarchy = getHierarchy();
    const order: { orgId: PopulationOrgId; orgName: string; orgType: OrganizationType; priority: number; offersFunding: boolean }[] = [];
    for (const m of memberships) {
      const org = hierarchy.get(m.orgId);
      if (!org) continue;
      let offersFunding = false;
      try {
        const funding = await loadFunding();
        if (funding?.listPolicies) {
          const policies = funding.listPolicies({ orgId: m.orgId }) ?? [];
          offersFunding = policies.some((p) => p.active && p.targetType === targetType);
        }
      } catch {
        /* funding optional */
      }
      order.push({
        orgId: m.orgId,
        orgName: org.name,
        orgType: org.type,
        priority: ORG_PRIORITY[org.type] ?? 0,
        offersFunding,
      });
    }
    order.sort((a, b) => b.priority - a.priority);
    return { participantId, targetType, order };
  }

  getStats(): {
    totalConflictsResolved: number;
    byType: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    for (const [k, v] of this.byType.entries()) byType[k] = v;
    return { totalConflictsResolved: this.resolvedCount, byType };
  }

  private recordResolution(type: string): void {
    this.resolvedCount += 1;
    this.byType.set(type, (this.byType.get(type) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeOverlapDays(
  aStart?: string, aEnd?: string, bStart?: string, bEnd?: string,
): number {
  if (!aStart || !aEnd || !bStart || !bEnd) return 0;
  const aS = Date.parse(aStart); const aE = Date.parse(aEnd);
  const bS = Date.parse(bStart); const bE = Date.parse(bEnd);
  if (Number.isNaN(aS) || Number.isNaN(aE) || Number.isNaN(bS) || Number.isNaN(bE)) return 0;
  const start = Math.max(aS, bS);
  const end = Math.min(aE, bE);
  if (end < start) return 0;
  return Math.ceil((end - start) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _coordinator: MultiOrgCoordinator | null = null;
export function getCoordinator(): MultiOrgCoordinator {
  if (!_coordinator) _coordinator = new MultiOrgCoordinator();
  return _coordinator;
}

export {
  ORG_PRIORITY,
  GRANT_PERMISSIVENESS,
};
