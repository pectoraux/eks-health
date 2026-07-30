/**
 * Eks-Health Research Platform — Cohort Builder
 *
 * Researchers define cohorts using authorized, privacy-safe criteria:
 * age range, gender, country, completion rate, program membership,
 * measurement ranges, organization membership, competition participation.
 *
 * Cohorts remain privacy-protected at all times: only aggregate counts are
 * ever returned. Small groups are suppressed via the privacy engine so that
 * no individual participant can be re-identified through cohort queries.
 *
 * All criteria evaluation is performed against REAL platform data (health
 * profiles, measurements, missions, competitions, organizations) — every
 * cross-subsystem call is guarded with try/catch so a missing subsystem
 * degrades gracefully rather than crashing the research pipeline.
 */

import "server-only";
import {
  type CohortId,
  type CohortDefinition,
  type CohortCriterion,
  type AccountId,
  ResearchError,
  asCohortId,
} from "../core";
import { getPrivacy } from "../privacy";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { RESEARCH_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Defensive loaders — research subsystems must never crash if a downstream
// subsystem is not yet booted. Each loader returns null on failure.
// ---------------------------------------------------------------------------

interface HealthProfileLike {
  readonly id: string;
  readonly accountId: AccountId;
  readonly demographics: {
    ageRange?: string;
    biologicalSex?: "male" | "female" | "intersex" | "unspecified";
    country?: string;
    region?: string;
  };
  readonly programs: { programId: string; status: "active" | "paused" | "uninstalled" }[];
}

interface MeasurementsApi {
  count(filter?: { profileId?: string; schemaId?: string; from?: string; to?: string; includeSuperseded?: boolean }): number;
}

interface MissionsApi {
  getStats(participantId?: AccountId): {
    total: number;
    completed: number;
    completionRate: number;
  };
}

interface QualificationApi {
  listParticipations(filter?: { participantId?: AccountId; competitionId?: string }): { participantId: AccountId; competitionId: string }[];
}

interface OrganizationsApi {
  listMembershipsForAccount(accountId: AccountId): { orgId: string; active: boolean }[];
}

let _profilesCache: { list(): HealthProfileLike[] } | null | undefined;
async function loadProfiles(): Promise<{ list(): HealthProfileLike[] } | null> {
  if (_profilesCache !== undefined) return _profilesCache;
  try {
    const mod = await import("@/health");
    const getter = (mod as { getProfiles?: () => { list(): HealthProfileLike[] } }).getProfiles;
    _profilesCache = getter ? getter() : null;
  } catch {
    _profilesCache = null;
  }
  return _profilesCache;
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

let _missionsCache: MissionsApi | null | undefined;
async function loadMissions(): Promise<MissionsApi | null> {
  if (_missionsCache !== undefined) return _missionsCache;
  try {
    const mod = await import("@/missions");
    const getter = (mod as { getMissions?: () => MissionsApi }).getMissions;
    _missionsCache = getter ? getter() : null;
  } catch {
    _missionsCache = null;
  }
  return _missionsCache;
}

let _qualificationCache: QualificationApi | null | undefined;
async function loadQualification(): Promise<QualificationApi | null> {
  if (_qualificationCache !== undefined) return _qualificationCache;
  try {
    const mod = await import("@/competitions");
    const getter = (mod as { getQualification?: () => QualificationApi }).getQualification;
    _qualificationCache = getter ? getter() : null;
  } catch {
    _qualificationCache = null;
  }
  return _qualificationCache;
}

let _orgsCache: OrganizationsApi | null | undefined;
async function loadOrganizations(): Promise<OrganizationsApi | null> {
  if (_orgsCache !== undefined) return _orgsCache;
  try {
    const mod = await import("@/identity");
    const getter = (mod as { getOrganizations?: () => OrganizationsApi }).getOrganizations;
    _orgsCache = getter ? getter() : null;
  } catch {
    _orgsCache = null;
  }
  return _orgsCache;
}

// ---------------------------------------------------------------------------
// Cohort evaluation result
// ---------------------------------------------------------------------------

export interface CohortEvaluation {
  readonly cohortId: CohortId;
  readonly count: number;
  readonly suppressed: boolean;
  readonly suppressionReason?: string;
  readonly evaluatedAt: string;
  readonly criteriaCount: number;
}

export interface CohortListFilter {
  readonly createdBy?: AccountId;
  readonly privacyLevel?: "anonymous" | "pseudonymized" | "aggregated";
}

// ---------------------------------------------------------------------------
// Cohort builder
// ---------------------------------------------------------------------------

export class CohortBuilder {
  private readonly cohorts = new Map<CohortId, CohortDefinition>();

  async create(
    name: string,
    description: string,
    criteria: CohortCriterion[],
    createdBy: AccountId,
    privacyLevel: "anonymous" | "pseudonymized" | "aggregated",
  ): Promise<CohortDefinition> {
    if (!name?.trim()) {
      throw new ResearchError({
        code: "eks.research.cohort.empty_name",
        category: "validation",
        message: "Cohort name is required.",
        userMessage: "Please provide a name for the cohort.",
      });
    }
    if (criteria.length === 0) {
      throw new ResearchError({
        code: "eks.research.cohort.no_criteria",
        category: "validation",
        message: "At least one criterion is required.",
        userMessage: "Define at least one criterion for the cohort.",
      });
    }
    const now = getClock().iso();
    const id = asCohortId(generateId("coh_"));
    const estimatedSize = await this.estimateSize(criteria);
    const cohort: CohortDefinition = {
      id,
      name: name.trim(),
      description: description.trim(),
      criteria: [...criteria],
      estimatedSize,
      createdBy,
      createdAt: now,
      privacyLevel,
    };
    this.cohorts.set(id, cohort);
    void getEventBus().publish(
      buildEvent(
        "eks.research.cohort.created",
        { cohortId: id, name: cohort.name, criteriaCount: criteria.length, estimatedSize, privacyLevel },
        {},
        "domain",
      ),
    );
    return cohort;
  }

  get(id: CohortId): CohortDefinition | undefined {
    return this.cohorts.get(id);
  }

  list(filter?: CohortListFilter): CohortDefinition[] {
    let list = [...this.cohorts.values()];
    if (filter?.createdBy) list = list.filter((c) => c.createdBy === filter.createdBy);
    if (filter?.privacyLevel) list = list.filter((c) => c.privacyLevel === filter.privacyLevel);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Estimate cohort size by matching criteria against actual platform data.
   * Returns a privacy-suppressed count (0 if the group is too small).
   */
  async estimateSize(criteria: CohortCriterion[]): Promise<number> {
    const matching = await this.collectMatching(criteria);
    const privacy = getPrivacy();
    const validation = privacy.validateQueryResult({ count: matching.size });
    if (!validation.safe) return 0;
    return privacy.injectNoise(matching.size, 1);
  }

  /**
   * Evaluate the cohort against current platform data. Returns ONLY the count
   * — never participant IDs. Small groups are suppressed via the privacy
   * engine (k-anonymity + suppression threshold).
   */
  async evaluate(cohortId: CohortId): Promise<CohortEvaluation> {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) {
      throw new ResearchError({
        code: "eks.research.cohort.not_found",
        category: "not_found",
        message: `Cohort ${cohortId} not found.`,
        userMessage: "This cohort does not exist.",
      });
    }
    const matching = await this.collectMatching(cohort.criteria);
    const privacy = getPrivacy();
    const validation = privacy.validateQueryResult({ count: matching.size });
    const now = getClock().iso();
    if (!validation.safe) {
      void getEventBus().publish(
        buildEvent(
          "eks.research.cohort.evaluated",
          { cohortId, count: 0, suppressed: true, reason: validation.reason },
          {},
          "domain",
        ),
      );
      return {
        cohortId,
        count: 0,
        suppressed: true,
        suppressionReason: validation.reason,
        evaluatedAt: now,
        criteriaCount: cohort.criteria.length,
      };
    }
    const safeCount = privacy.injectNoise(matching.size, 1);
    void getEventBus().publish(
      buildEvent(
        "eks.research.cohort.evaluated",
        { cohortId, count: safeCount, suppressed: false },
        {},
        "domain",
      ),
    );
    return {
      cohortId,
      count: safeCount,
      suppressed: false,
      evaluatedAt: now,
      criteriaCount: cohort.criteria.length,
    };
  }

  async addCriterion(cohortId: CohortId, criterion: CohortCriterion): Promise<CohortDefinition> {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) {
      throw new ResearchError({
        code: "eks.research.cohort.not_found",
        category: "not_found",
        message: `Cohort ${cohortId} not found.`,
      });
    }
    const updated: CohortDefinition = {
      ...cohort,
      criteria: [...cohort.criteria, criterion],
      estimatedSize: await this.estimateSize([...cohort.criteria, criterion]),
    };
    this.cohorts.set(cohortId, updated);
    return updated;
  }

  async removeCriterion(cohortId: CohortId, index: number): Promise<CohortDefinition> {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) {
      throw new ResearchError({
        code: "eks.research.cohort.not_found",
        category: "not_found",
        message: `Cohort ${cohortId} not found.`,
      });
    }
    if (index < 0 || index >= cohort.criteria.length) {
      throw new ResearchError({
        code: "eks.research.cohort.bad_index",
        category: "validation",
        message: `Criterion index ${index} out of range.`,
        userMessage: "That criterion does not exist.",
      });
    }
    const nextCriteria = cohort.criteria.filter((_, i) => i !== index);
    const updated: CohortDefinition = {
      ...cohort,
      criteria: nextCriteria,
      estimatedSize: nextCriteria.length === 0 ? 0 : await this.estimateSize(nextCriteria),
    };
    this.cohorts.set(cohortId, updated);
    return updated;
  }

  getStats(): {
    total: number;
    byPrivacyLevel: Record<string, number>;
    avgCriteriaCount: number;
    totalEstimatedParticipants: number;
  } {
    const list = [...this.cohorts.values()];
    const byPrivacyLevel: Record<string, number> = {};
    let criteriaSum = 0;
    let estimatedSum = 0;
    for (const c of list) {
      byPrivacyLevel[c.privacyLevel] = (byPrivacyLevel[c.privacyLevel] ?? 0) + 1;
      criteriaSum += c.criteria.length;
      estimatedSum += c.estimatedSize;
    }
    return {
      total: list.length,
      byPrivacyLevel,
      avgCriteriaCount: list.length > 0 ? criteriaSum / list.length : 0,
      totalEstimatedParticipants: estimatedSum,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: real criteria evaluation against actual platform data
  // -------------------------------------------------------------------------

  /**
   * Collect the set of matching account IDs. This is private — only the count
   * is ever surfaced to callers (privacy by design).
   */
  private async collectMatching(criteria: CohortCriterion[]): Promise<Set<AccountId>> {
    const profiles = await loadProfiles();
    if (!profiles) return new Set<AccountId>();

    let allProfiles: HealthProfileLike[];
    try {
      allProfiles = profiles.list();
    } catch {
      return new Set<AccountId>();
    }

    const matching = new Set<AccountId>();
    for (const profile of allProfiles) {
      if (await this.matchesAll(profile, criteria)) {
        matching.add(profile.accountId);
      }
    }
    return matching;
  }

  private async matchesAll(profile: HealthProfileLike, criteria: CohortCriterion[]): Promise<boolean> {
    for (const c of criteria) {
      if (!(await this.matchesOne(profile, c))) return false;
    }
    return true;
  }

  private async matchesOne(profile: HealthProfileLike, c: CohortCriterion): Promise<boolean> {
    switch (c.field) {
      case "age_range":
        return this.matchAgeRange(profile, c);
      case "gender":
      case "biological_sex":
        return this.matchGender(profile, c);
      case "country":
        return this.matchCountry(profile, c);
      case "completion_rate":
        return await this.matchCompletionRate(profile, c);
      case "program_id":
        return this.matchProgram(profile, c);
      case "measurement_count":
        return await this.matchMeasurementCount(profile, c);
      case "org_id":
      case "organization_id":
        return await this.matchOrg(profile, c);
      case "competition_id":
        return await this.matchCompetition(profile, c);
      default:
        // Unknown criteria are ignored (fail-open) so partial subsystem
        // availability doesn't artificially shrink cohorts.
        return true;
    }
  }

  private matchAgeRange(profile: HealthProfileLike, c: CohortCriterion): boolean {
    const ageRange = profile.demographics.ageRange;
    if (!ageRange) return c.operator === "exists" ? false : false;
    const parsed = parseAgeRange(ageRange);
    if (!parsed) return false;
    const value = c.value as { min?: number; max?: number } | number;
    let cMin: number | undefined;
    let cMax: number | undefined;
    if (typeof value === "number") {
      cMin = cMax = value;
    } else {
      cMin = value.min;
      cMax = value.max;
    }
    switch (c.operator) {
      case "between":
        return rangesOverlap(parsed.min, parsed.max, cMin ?? -Infinity, cMax ?? Infinity);
      case "gte":
        return parsed.max >= (cMin ?? -Infinity);
      case "lte":
        return parsed.min <= (cMax ?? Infinity);
      case "gt":
        return parsed.max > (cMin ?? -Infinity);
      case "lt":
        return parsed.min < (cMax ?? Infinity);
      case "eq":
        return parsed.min === cMin && parsed.max === cMax;
      case "exists":
        return true;
      default:
        return true;
    }
  }

  private matchGender(profile: HealthProfileLike, c: CohortCriterion): boolean {
    const sex = profile.demographics.biologicalSex;
    if (!sex) return false;
    switch (c.operator) {
      case "eq":
        return sex === c.value;
      case "ne":
        return sex !== c.value;
      case "in":
        return Array.isArray(c.value) && c.value.includes(sex);
      case "not_in":
        return Array.isArray(c.value) && !c.value.includes(sex);
      case "exists":
        return true;
      default:
        return true;
    }
  }

  private matchCountry(profile: HealthProfileLike, c: CohortCriterion): boolean {
    const country = profile.demographics.country;
    if (!country) return false;
    switch (c.operator) {
      case "eq":
        return country === c.value;
      case "ne":
        return country !== c.value;
      case "in":
        return Array.isArray(c.value) && c.value.includes(country);
      case "not_in":
        return Array.isArray(c.value) && !c.value.includes(country);
      case "exists":
        return true;
      default:
        return true;
    }
  }

  private matchProgram(profile: HealthProfileLike, c: CohortCriterion): boolean {
    const programIds = profile.programs
      .filter((p) => p.status === "active" || p.status === "paused")
      .map((p) => p.programId);
    switch (c.operator) {
      case "eq":
        return programIds.includes(String(c.value));
      case "ne":
        return !programIds.includes(String(c.value));
      case "in":
        return Array.isArray(c.value) && (c.value as unknown[]).some((v) => programIds.includes(String(v)));
      case "not_in":
        return Array.isArray(c.value) && !(c.value as unknown[]).some((v) => programIds.includes(String(v)));
      case "exists":
        return programIds.length > 0;
      default:
        return true;
    }
  }

  private async matchCompletionRate(profile: HealthProfileLike, c: CohortCriterion): Promise<boolean> {
    const missions = await loadMissions();
    if (!missions) return false;
    let rate = 0;
    try {
      rate = missions.getStats(profile.accountId).completionRate ?? 0;
    } catch {
      return false;
    }
    const target = typeof c.value === "number" ? c.value : Number(c.value);
    if (!Number.isFinite(target)) return false;
    switch (c.operator) {
      case "gte":
        return rate >= target;
      case "lte":
        return rate <= target;
      case "gt":
        return rate > target;
      case "lt":
        return rate < target;
      case "eq":
        return Math.abs(rate - target) < 1e-9;
      case "between": {
        const v = c.value as { min?: number; max?: number };
        const min = v?.min ?? -Infinity;
        const max = v?.max ?? Infinity;
        return rate >= min && rate <= max;
      }
      default:
        return true;
    }
  }

  private async matchMeasurementCount(profile: HealthProfileLike, c: CohortCriterion): Promise<boolean> {
    const measurements = await loadMeasurements();
    if (!measurements) return false;
    let count = 0;
    try {
      count = measurements.count({ profileId: profile.id, includeSuperseded: false });
    } catch {
      return false;
    }
    const target = typeof c.value === "number" ? c.value : Number(c.value);
    switch (c.operator) {
      case "gte":
        return count >= target;
      case "lte":
        return count <= target;
      case "gt":
        return count > target;
      case "lt":
        return count < target;
      case "eq":
        return count === target;
      case "between": {
        const v = c.value as { min?: number; max?: number };
        const min = v?.min ?? -Infinity;
        const max = v?.max ?? Infinity;
        return count >= min && count <= max;
      }
      case "exists":
        return count > 0;
      default:
        return true;
    }
  }

  private async matchOrg(profile: HealthProfileLike, c: CohortCriterion): Promise<boolean> {
    const orgs = await loadOrganizations();
    if (!orgs) return false;
    let memberships: { orgId: string; active: boolean }[] = [];
    try {
      memberships = orgs.listMembershipsForAccount(profile.accountId) ?? [];
    } catch {
      return false;
    }
    const activeOrgIds = memberships.filter((m) => m.active).map((m) => m.orgId);
    switch (c.operator) {
      case "eq":
        return activeOrgIds.includes(String(c.value));
      case "ne":
        return !activeOrgIds.includes(String(c.value));
      case "in":
        return Array.isArray(c.value) && (c.value as unknown[]).some((v) => activeOrgIds.includes(String(v)));
      case "not_in":
        return Array.isArray(c.value) && !(c.value as unknown[]).some((v) => activeOrgIds.includes(String(v)));
      case "exists":
        return activeOrgIds.length > 0;
      default:
        return true;
    }
  }

  private async matchCompetition(profile: HealthProfileLike, c: CohortCriterion): Promise<boolean> {
    const qualification = await loadQualification();
    if (!qualification) return false;
    let participations: { participantId: AccountId; competitionId: string }[] = [];
    try {
      participations = qualification.listParticipations({ participantId: profile.accountId }) ?? [];
    } catch {
      return false;
    }
    const compIds = participations.map((p) => p.competitionId);
    switch (c.operator) {
      case "eq":
        return compIds.includes(String(c.value));
      case "ne":
        return !compIds.includes(String(c.value));
      case "in":
        return Array.isArray(c.value) && (c.value as unknown[]).some((v) => compIds.includes(String(v)));
      case "not_in":
        return Array.isArray(c.value) && !(c.value as unknown[]).some((v) => compIds.includes(String(v)));
      case "exists":
        return compIds.length > 0;
      default:
        return true;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a demographic age range like "30-39" or "70+" into {min, max}. */
function parseAgeRange(s: string): { min: number; max: number } | null {
  const plusMatch = s.match(/^(\d+)\+$/);
  if (plusMatch) {
    const min = parseInt(plusMatch[1], 10);
    return Number.isFinite(min) ? { min, max: Infinity } : null;
  }
  const match = s.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (!match) return null;
  const min = parseInt(match[1], 10);
  const max = parseInt(match[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { min, max };
}

function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && bMin <= aMax;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _builder: CohortBuilder | null = null;
export function getCohorts(): CohortBuilder {
  if (!_builder) _builder = new CohortBuilder();
  return _builder;
}

// Re-export the events used here for downstream consumers.
export { RESEARCH_EVENTS };
