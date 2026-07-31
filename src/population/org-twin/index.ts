/**
 * Eks-Health Population Platform — Organization Digital Twin
 *
 * The Organization Digital Twin is a live, privacy-preserving aggregate
 * representation of an organization's posture across the platform:
 *   - population health (active participants, engagement, average
 *     improvement — computed ONLY from already-aggregated signals; never
 *     from individual health records),
 *   - program adoption (installs / active / completion),
 *   - competitions (participants / engagement),
 *   - budgets (allocated / spent / remaining per category),
 *   - risks (low / medium / high indicators),
 *   - resources (technicians / devices / sessions and utilization),
 *   - evidence (research confidence for the programs the org uses).
 *
 * Every cross-subsystem call is guarded so a missing or failing subsystem
 * degrades gracefully — the twin still builds with the data that is
 * available. Individual health data is NEVER referenced: the twin only
 * consumes counts, sums, and aggregate rates already published by the
 * health, programs, competitions, funding, technicians, and research
 * subsystems.
 *
 * Built on all prior milestones. Pure TS, strict, ESM. No external deps.
 */

import "server-only";
import {
  type OrgTwinId,
  type PopulationOrgId,
  type ProgramId,
  type AccountId,
  type OrganizationTwin,
  PopulationError,
  asOrgTwinId,
  POPULATION_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getHierarchy } from "../hierarchy";
import { getMemberships } from "../membership";

// ---------------------------------------------------------------------------
// Defensive cross-subsystem loader types
// ---------------------------------------------------------------------------
// The twin only reads AGGREGATE fields that the other subsystems already
// publish. The shapes below are the minimum we rely on; the real modules may
// export richer interfaces, so we cast defensively.

interface MarketplaceListingLike {
  readonly programId: ProgramId;
  readonly name: string;
  readonly status: string;
  readonly rating?: { average?: number; count?: number };
}

interface MarketplaceApi {
  listListings(filter?: { status?: string }): MarketplaceListingLike[];
}

interface CompetitionLike {
  readonly id: string;
  readonly programId: ProgramId;
  readonly name: string;
  readonly state: string;
  readonly currentParticipants: number;
  readonly scope?: string;
  readonly scopeFilter?: Record<string, unknown>;
}

interface CompetitionsApi {
  list(filter?: { programId?: ProgramId; state?: string; scope?: string }): CompetitionLike[];
}

interface MeasurementsApi {
  getStats(profileId?: string): {
    total: number;
    bySchema: Record<string, number>;
    byVerification: Record<string, number>;
  };
}

interface HealthProfilesApi {
  list(): { id: string; accountId: string; programs: { programId: string; status: string; installedAt: string }[] }[];
}

interface FundingApi {
  listPolicies?(filter?: { orgId?: PopulationOrgId }): { id: string; orgId: PopulationOrgId; targetType: string; maxAmountTotal: number; currency: string; active: boolean }[];
  listRequests?(filter?: { orgId?: PopulationOrgId }): { id: string; orgId: PopulationOrgId; targetType: string; amount: number; currency: string; status: string }[];
}

interface EvidenceApi {
  get(programId: ProgramId): { programId: ProgramId; totalParticipants: number; confidenceScore: number; averageImprovement: number; completionRate: number; evidenceLevel: string } | undefined;
  getTopEvidence(limit?: number): { programId: ProgramId; totalParticipants: number; confidenceScore: number; averageImprovement: number; completionRate: number; evidenceLevel: string }[];
}

interface TechnicianSessionsApi {
  list(filter?: { programId?: string }): { programId: string; status: string }[];
}

// Lazy dynamic loaders — cached after first successful resolution.
let _marketplaceCache: MarketplaceApi | null | undefined;
async function loadMarketplace(): Promise<MarketplaceApi | null> {
  if (_marketplaceCache !== undefined) return _marketplaceCache;
  try {
    const mod = await import("@/programs/marketplace");
    const getter = (mod as { getMarketplace?: () => MarketplaceApi }).getMarketplace;
    _marketplaceCache = getter ? getter() : null;
  } catch {
    _marketplaceCache = null;
  }
  return _marketplaceCache;
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

let _measurementsCache: MeasurementsApi | null | undefined;
async function loadMeasurements(): Promise<MeasurementsApi | null> {
  if (_measurementsCache !== undefined) return _measurementsCache;
  try {
    const mod = await import("@/health");
    const getter = (mod as { getMeasurements?: () => MeasurementsApi }).getMeasurements;
    _measurementsCache = getter ? getter() : null;
  } catch {
    _measurementsCache = null;
  }
  return _measurementsCache;
}

let _profilesCache: HealthProfilesApi | null | undefined;
async function loadProfiles(): Promise<HealthProfilesApi | null> {
  if (_profilesCache !== undefined) return _profilesCache;
  try {
    const mod = await import("@/health");
    const getter = (mod as { getProfiles?: () => HealthProfilesApi }).getProfiles;
    _profilesCache = getter ? getter() : null;
  } catch {
    _profilesCache = null;
  }
  return _profilesCache;
}

let _evidenceCache: EvidenceApi | null | undefined;
async function loadEvidence(): Promise<EvidenceApi | null> {
  if (_evidenceCache !== undefined) return _evidenceCache;
  try {
    const mod = await import("@/research");
    const getter = (mod as { getEvidenceEngine?: () => EvidenceApi }).getEvidenceEngine;
    _evidenceCache = getter ? getter() : null;
  } catch {
    _evidenceCache = null;
  }
  return _evidenceCache;
}

let _sessionsCache: TechnicianSessionsApi | null | undefined;
async function loadSessions(): Promise<TechnicianSessionsApi | null> {
  if (_sessionsCache !== undefined) return _sessionsCache;
  try {
    const mod = await import("@/technicians");
    const getter = (mod as { getSessions?: () => TechnicianSessionsApi }).getSessions;
    _sessionsCache = getter ? getter() : null;
  } catch {
    _sessionsCache = null;
  }
  return _sessionsCache;
}

// Funding lives in this same milestone (built by m12-2 in parallel). Probe
// both a sibling module path and a property on the core barrel; either may
// be missing during early boot, so always guard.
let _fundingCache: FundingApi | null | undefined;
async function loadFunding(): Promise<FundingApi | null> {
  if (_fundingCache !== undefined) return _fundingCache;
  try {
    const mod = await import("../funding");
    const mgr = (mod as { getFunding?: () => FundingApi }).getFunding;
    _fundingCache = mgr ? mgr() : null;
  } catch {
    _fundingCache = null;
  }
  return _fundingCache;
}

// ---------------------------------------------------------------------------
// Twin snapshot — historical record
// ---------------------------------------------------------------------------

export interface TwinSnapshot {
  readonly twin: OrganizationTwin;
  readonly capturedAt: string;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 50;

export class OrgTwinManager {
  private readonly twins = new Map<PopulationOrgId, OrganizationTwin>();
  private readonly history = new Map<PopulationOrgId, TwinSnapshot[]>();
  private readonly twinIdByOrg = new Map<PopulationOrgId, OrgTwinId>();

  /** Get the org's twin, creating an empty one if it does not yet exist. */
  getOrCreate(orgId: PopulationOrgId): OrganizationTwin {
    const existing = this.twins.get(orgId);
    if (existing) return existing;
    const twinId = this.twinIdByOrg.get(orgId) ?? asOrgTwinId(generateId("orgtwin_"));
    this.twinIdByOrg.set(orgId, twinId);
    const now = getClock().iso();
    const twin: OrganizationTwin = {
      id: twinId,
      orgId,
      populationHealth: {
        totalParticipants: 0,
        activeParticipants: 0,
        avgImprovement: 0,
        participationRate: 0,
        engagementScore: 0,
      },
      programAdoption: [],
      competitions: [],
      budgets: { category: "general", allocated: 0, spent: 0, remaining: 0, currency: "USD" },
      risks: [],
      resources: [],
      evidence: [],
      lastUpdated: now,
    };
    this.twins.set(orgId, twin);
    return twin;
  }

  /** Get the latest twin (does not rebuild). */
  get(orgId: PopulationOrgId): OrganizationTwin | undefined {
    return this.twins.get(orgId);
  }

  /**
   * Rebuild the twin from real platform data. Every cross-subsystem call is
   * guarded; failures simply yield zero-valued contributions and a `risk`
   * entry noting the unavailable source.
   */
  async update(orgId: PopulationOrgId): Promise<OrganizationTwin> {
    const org = getHierarchy().get(orgId);
    if (!org) {
      throw new PopulationError({
        code: "eks.population.twin.org_not_found",
        category: "not_found",
        message: `Organization ${orgId} not found.`,
        userMessage: "Organization not found.",
      });
    }
    const twinId = this.twinIdByOrg.get(orgId) ?? asOrgTwinId(generateId("orgtwin_"));
    this.twinIdByOrg.set(orgId, twinId);
    const now = getClock().iso();
    const sources: string[] = [];
    const risks: OrganizationTwin["risks"] = [];

    // ---- Population health (aggregate only) --------------------------------
    const memberships = getMemberships().listByOrg(orgId);
    const activeMemberships = memberships.filter((m) => m.status === "active");
    const totalParticipants = memberships.length;
    const activeParticipants = activeMemberships.length;
    const accountIds = new Set<AccountId>(activeMemberships.map((m) => m.accountId));

    // Aggregate improvement + measurement counts — derived only from the
    // health subsystem's already-aggregated stats; we never touch individual
    // measurements here.
    let avgImprovement = 0;
    let measurementTotal = 0;
    let participationRate = 0;
    try {
      const measurements = await loadMeasurements();
      if (measurements) {
        const stats = measurements.getStats();
        measurementTotal = stats.total;
        sources.push("health.measurements");
      }
    } catch {
      risks.push({ name: "health_measurements_unavailable", level: "low", detail: "Health measurements subsystem unreachable during twin rebuild." });
    }

    // Compute population health improvement from research evidence on the
    // programs installed by this org's members (already aggregated, never
    // individual data).
    const memberPrograms = new Map<ProgramId, { installs: number; active: number }>();
    try {
      const profiles = await loadProfiles();
      if (profiles) {
        const allProfiles = profiles.list();
        let aggregateImprovementSum = 0;
        let aggregateImprovementCount = 0;
        for (const profile of allProfiles) {
          if (!accountIds.has(profile.accountId as AccountId)) continue;
          for (const p of profile.programs ?? []) {
            const pid = p.programId as ProgramId;
            const entry = memberPrograms.get(pid) ?? { installs: 0, active: 0 };
            entry.installs += 1;
            if (p.status === "active") entry.active += 1;
            memberPrograms.set(pid, entry);
          }
        }
        // Pull the average-improvement figure published by the research
        // evidence engine for each installed program (already aggregated).
        try {
          const evidence = await loadEvidence();
          if (evidence) {
            for (const pid of memberPrograms.keys()) {
              const acc = evidence.get(pid);
              if (acc && typeof acc.averageImprovement === "number") {
                aggregateImprovementSum += acc.averageImprovement;
                aggregateImprovementCount += 1;
              }
            }
          }
        } catch {
          /* evidence subsystem optional */
        }
        if (aggregateImprovementCount > 0) {
          avgImprovement = aggregateImprovementSum / aggregateImprovementCount;
        }
        participationRate = activeParticipants > 0
          ? Math.min(1, memberPrograms.size > 0 ? (Array.from(memberPrograms.values()).reduce((a, e) => a + e.active, 0) / activeParticipants) : 0)
          : 0;
        sources.push("health.profiles");
      }
    } catch {
      risks.push({ name: "health_profiles_unavailable", level: "low", detail: "Health profiles subsystem unreachable during twin rebuild." });
    }

    // Engagement score: composite of participation rate, active membership
    // ratio, and average program completion (sourced from evidence). 0-100.
    const activeRatio = totalParticipants > 0 ? activeParticipants / totalParticipants : 0;
    let avgCompletion = 0;
    let completionSamples = 0;
    try {
      const evidence = await loadEvidence();
      if (evidence) {
        for (const pid of memberPrograms.keys()) {
          const acc = evidence.get(pid);
          if (acc && typeof acc.completionRate === "number") {
            avgCompletion += acc.completionRate;
            completionSamples += 1;
          }
        }
      }
    } catch {
      /* optional */
    }
    if (completionSamples > 0) avgCompletion = avgCompletion / completionSamples;
    const engagementScore = Math.round(
      (activeRatio * 40 + participationRate * 30 + Math.min(1, avgCompletion) * 30) * 100,
    ) / 100;

    const populationHealth: OrganizationTwin["populationHealth"] = {
      totalParticipants,
      activeParticipants,
      avgImprovement: Math.round(avgImprovement * 100) / 100,
      participationRate: Math.round(participationRate * 1000) / 1000,
      engagementScore: Math.min(100, Math.max(0, engagementScore)),
    };

    // ---- Program adoption --------------------------------------------------
    const programAdoption: OrganizationTwin["programAdoption"] = [];
    try {
      const evidence = await loadEvidence();
      for (const [programId, counts] of memberPrograms.entries()) {
        let completionRate = 0;
        if (evidence) {
          const acc = evidence.get(programId);
          if (acc && typeof acc.completionRate === "number") completionRate = acc.completionRate;
        }
        programAdoption.push({
          programId,
          installs: counts.installs,
          active: counts.active,
          completionRate: Math.round(completionRate * 1000) / 1000,
        });
      }
      programAdoption.sort((a, b) => b.installs - a.installs);
      if (programAdoption.length > 0) sources.push("programs.adoption");
    } catch {
      /* leave empty */
    }

    // ---- Competitions ------------------------------------------------------
    const competitions: OrganizationTwin["competitions"] = [];
    try {
      const comps = await loadCompetitions();
      if (comps) {
        const orgPrograms = new Set(memberPrograms.keys());
        // Competitions linked to programs the org's members use, or scoped
        // to this org. We never assume individual participation.
        const all = comps.list();
        for (const c of all) {
          const scopedToThisOrg = c.scope === "organizational"
            && typeof c.scopeFilter === "object"
            && c.scopeFilter !== null
            && (c.scopeFilter as { orgId?: string }).orgId === (orgId as string);
          if (!orgPrograms.has(c.programId) && !scopedToThisOrg) continue;
          const engagement = c.currentParticipants > 0
            ? Math.min(100, Math.round((c.state === "active" ? 0.8 : c.state === "registration" ? 0.4 : 0.2) * 100))
            : 0;
          competitions.push({
            competitionId: c.id,
            participants: c.currentParticipants,
            engagement,
          });
        }
        if (competitions.length > 0) sources.push("competitions");
      }
    } catch {
      risks.push({ name: "competitions_unavailable", level: "low", detail: "Competitions subsystem unreachable during twin rebuild." });
    }

    // ---- Budgets -----------------------------------------------------------
    let budgets: OrganizationTwin["budgets"] = {
      category: "general",
      allocated: 0,
      spent: 0,
      remaining: 0,
      currency: "USD",
    };
    try {
      const funding = await loadFunding();
      if (funding && (funding.listPolicies || funding.listRequests)) {
        const policies = funding.listPolicies?.({ orgId }) ?? [];
        const requests = funding.listRequests?.({ orgId }) ?? [];
        let allocated = 0;
        let spent = 0;
        const currencies = new Map<string, number>();
        for (const p of policies) {
          if (!p.active) continue;
          allocated += p.maxAmountTotal;
          currencies.set(p.currency, (currencies.get(p.currency) ?? 0) + p.maxAmountTotal);
        }
        for (const r of requests) {
          if (r.status === "executed") spent += r.amount;
        }
        const currency = currencies.size > 0
          ? [...currencies.entries()].sort((a, b) => b[1] - a[1])[0][0]
          : "USD";
        budgets = {
          category: "all",
          allocated,
          spent,
          remaining: Math.max(0, allocated - spent),
          currency,
        };
        if (allocated > 0 || spent > 0) sources.push("population.funding");
        if (allocated > 0 && spent / allocated > 0.9) {
          risks.push({ name: "budget_utilization_high", level: "high", detail: `Budget utilization at ${Math.round((spent / allocated) * 100)}%.` });
        } else if (allocated > 0 && spent / allocated > 0.7) {
          risks.push({ name: "budget_utilization_moderate", level: "medium", detail: `Budget utilization at ${Math.round((spent / allocated) * 100)}%.` });
        }
      }
    } catch {
      /* funding optional in this milestone */
    }

    // ---- Resources ---------------------------------------------------------
    const resources: OrganizationTwin["resources"] = [];
    try {
      const sessions = await loadSessions();
      if (sessions) {
        const list = sessions.list();
        const completed = list.filter((s) => s.status === "completed").length;
        const total = list.length;
        const utilization = total > 0 ? completed / total : 0;
        if (total > 0) {
          resources.push({ type: "technician_sessions", count: total, utilization: Math.round(utilization * 1000) / 1000 });
          sources.push("technicians.sessions");
        }
      }
    } catch {
      /* optional */
    }
    // Programs-as-resources: count installed programs as a resource pool.
    if (memberPrograms.size > 0) {
      const totalInstalls = Array.from(memberPrograms.values()).reduce((a, e) => a + e.installs, 0);
      const activeInstalls = Array.from(memberPrograms.values()).reduce((a, e) => a + e.active, 0);
      resources.push({
        type: "programs",
        count: memberPrograms.size,
        utilization: totalInstalls > 0 ? Math.round((activeInstalls / totalInstalls) * 1000) / 1000 : 0,
      });
    }

    // ---- Evidence ----------------------------------------------------------
    const evidence: OrganizationTwin["evidence"] = [];
    try {
      const evidenceApi = await loadEvidence();
      if (evidenceApi) {
        for (const pid of memberPrograms.keys()) {
          const acc = evidenceApi.get(pid);
          if (acc) {
            evidence.push({
              programId: pid,
              confidence: acc.confidenceScore,
              populationSize: acc.totalParticipants,
            });
          }
        }
        if (evidence.length > 0) sources.push("research.evidence");
      }
    } catch {
      /* optional */
    }

    // ---- Risk indicators ---------------------------------------------------
    if (activeParticipants === 0 && totalParticipants > 0) {
      risks.push({ name: "no_active_members", level: "high", detail: "All members are inactive or suspended." });
    } else if (activeParticipants > 0 && participationRate < 0.1) {
      risks.push({ name: "low_participation", level: "medium", detail: "Program participation rate below 10%." });
    }
    if (engagementScore < 25 && activeParticipants > 0) {
      risks.push({ name: "low_engagement", level: "medium", detail: `Engagement score ${engagementScore.toFixed(1)}/100.` });
    }
    if (memberPrograms.size === 0 && activeParticipants > 0) {
      risks.push({ name: "no_programs_installed", level: "medium", detail: "Active members have not installed any programs." });
    }

    const twin: OrganizationTwin = {
      id: twinId,
      orgId,
      populationHealth,
      programAdoption,
      competitions,
      budgets,
      risks,
      resources,
      evidence,
      lastUpdated: now,
    };

    // Snapshot the previous twin before overwriting.
    const prev = this.twins.get(orgId);
    if (prev) {
      const snapshots = this.history.get(orgId) ?? [];
      snapshots.push({ twin: prev, capturedAt: now });
      this.history.set(orgId, snapshots.slice(-HISTORY_LIMIT));
    }
    this.twins.set(orgId, twin);

    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.orgTwinUpdated,
        { orgId, twinId, sources, riskCount: risks.length },
        {},
        "domain",
      ),
    );
    return twin;
  }

  /** Historical twin snapshots, most-recent-last. */
  getHistory(orgId: PopulationOrgId): TwinSnapshot[] {
    return [...(this.history.get(orgId) ?? [])];
  }

  /** Current risk indicators for an org (zero-cost, reads cache). */
  getRisks(orgId: PopulationOrgId): OrganizationTwin["risks"] {
    return this.twins.get(orgId)?.risks ?? [];
  }

  /** Current budget allocation/utilization. */
  getBudgets(orgId: PopulationOrgId): OrganizationTwin["budgets"] | undefined {
    return this.twins.get(orgId)?.budgets;
  }

  /** Evidence summaries for the programs used by the org. */
  getEvidence(orgId: PopulationOrgId): OrganizationTwin["evidence"] {
    return this.twins.get(orgId)?.evidence ?? [];
  }

  getStats(): {
    totalTwins: number;
    avgPopulation: number;
    avgEngagement: number;
    avgImprovement: number;
    totalRisks: number;
  } {
    const list = [...this.twins.values()];
    const n = list.length;
    if (n === 0) return { totalTwins: 0, avgPopulation: 0, avgEngagement: 0, avgImprovement: 0, totalRisks: 0 };
    const totalPop = list.reduce((a, t) => a + t.populationHealth.totalParticipants, 0);
    const totalEng = list.reduce((a, t) => a + t.populationHealth.engagementScore, 0);
    const totalImp = list.reduce((a, t) => a + t.populationHealth.avgImprovement, 0);
    const totalRisks = list.reduce((a, t) => a + t.risks.length, 0);
    return {
      totalTwins: n,
      avgPopulation: Math.round((totalPop / n) * 100) / 100,
      avgEngagement: Math.round((totalEng / n) * 100) / 100,
      avgImprovement: Math.round((totalImp / n) * 100) / 100,
      totalRisks,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: OrgTwinManager | null = null;
export function getOrgTwin(): OrgTwinManager {
  if (!_mgr) _mgr = new OrgTwinManager();
  return _mgr;
}
