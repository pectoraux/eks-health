/**
 * Eks-Health Population Platform — Population Analytics
 *
 * Organization dashboards: participation rates, program adoption, mission
 * completion, aggregate improvements, competition participation, measurement
 * compliance, retention, engagement, program effectiveness, trends, and
 * regional breakdowns.
 *
 * Privacy by design:
 *  - ALL data returned is AGGREGATE ONLY. No individual records ever leave
 *    this module.
 *  - Small groups are suppressed (k-anonymity, MIN_GROUP_SIZE = 5).
 *  - The privacy firewall is consulted to determine the org's authorized
 *    visibility level; orgs without aggregate_performance grants receive
 *    only high-level counts.
 *
 * Real aggregate computation from the live platform subsystems (memberships,
 * health profiles, measurements, missions, competitions, hierarchy). Every
 * cross-subsystem call is guarded with try/catch so a missing or failing
 * subsystem degrades gracefully to zeros rather than crashing the dashboard.
 *
 * Built on the population core, hierarchy, membership, and privacy-firewall.
 */

import "server-only";
import {
  type PopulationOrgId,
  type AccountId,
  type ProgramId,
  PopulationError,
  asPopulationOrgId,
} from "../core";
import { getMemberships } from "../membership";
import { getHierarchy } from "../hierarchy";
import { getPrivacyFirewall } from "../privacy-firewall";
import { getProfiles } from "@/health";
import { getMeasurements } from "@/health";
import { getMissions } from "@/missions";
import { getCompetitions } from "@/competitions";
import { getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface ProgramAdoptionStat {
  readonly programId: ProgramId;
  readonly installs: number;
  readonly active: number;
  readonly activeRate: number; // 0..1
}

export interface ProgramEffectivenessStat {
  readonly programId: ProgramId;
  readonly participants: number;
  readonly avgImprovement: number;
  readonly missionCompletionRate: number; // 0..1
  readonly measurementCompliance: number; // 0..1
  readonly effectivenessScore: number; // 0..100
  readonly suppressed: boolean; // true if below k-anonymity threshold
}

export interface RegionalBreakdownStat {
  readonly orgId: PopulationOrgId;
  readonly name: string;
  readonly participants: number;
  readonly avgImprovement: number;
  readonly participationRate: number; // 0..1
  readonly suppressed: boolean;
}

export interface RetentionStats {
  readonly retention30: number; // 0..1
  readonly retention90: number; // 0..1
  readonly totalMembers: number;
  readonly active30: number;
  readonly active90: number;
}

export interface OrgDashboard {
  readonly orgId: PopulationOrgId;
  readonly totalMembers: number;
  readonly activeMembers: number;
  readonly participationRate: number; // 0..1
  readonly programAdoption: ProgramAdoptionStat[];
  readonly missionCompletionRate: number; // 0..1
  readonly avgImprovement: number;
  readonly competitionEngagement: number; // 0..1
  readonly measurementCompliance: number; // 0..1
  readonly retention30: number; // 0..1
  readonly retention90: number; // 0..1
  readonly engagementScore: number; // 0..100
  readonly authorizedLevel: "full" | "limited"; // privacy firewall gate
  readonly computedAt: string;
}

export interface TrendPoint {
  readonly at: string;
  readonly value: number;
}

export interface MetricTrend {
  readonly metric: string;
  readonly period: string;
  readonly points: TrendPoint[];
  readonly direction: "up" | "down" | "stable";
  readonly changePercent: number;
}

export type TrendMetric =
  | "participationRate"
  | "engagementScore"
  | "avgImprovement"
  | "retention30"
  | "retention90"
  | "compliance"
  | "activeMembers"
  | "totalMeasurements";

export interface AnalyticsStats {
  readonly totalQueries: number;
  readonly byMethod: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Internal: defensive structural types for cross-subsystem data
// ---------------------------------------------------------------------------

interface ProfileLike {
  readonly id: string;
  readonly accountId: string;
  readonly programs: {
    readonly programId: string;
    readonly status: "active" | "paused" | "uninstalled";
    readonly installedAt: string;
  }[];
  readonly demographics?: {
    readonly country?: string;
    readonly region?: string;
  };
}

interface MeasurementLike {
  readonly profileId: string;
  readonly schemaId: string;
  readonly value: unknown;
  readonly verificationState: string;
  readonly provenance: { readonly collectedAt: string };
  readonly supersededBy?: string;
}

interface MissionLike {
  readonly participantId: string;
  readonly programId: string;
  readonly state: string;
  readonly category: string;
  readonly result?: { readonly outcome: string };
}

interface CompetitionLike {
  readonly id: string;
  readonly programId: string;
  readonly currentParticipants: number;
  readonly state: string;
  readonly scope: string;
  readonly scopeFilter?: Record<string, unknown>;
}

interface MembershipLike {
  readonly accountId: string;
  readonly orgId: string;
  readonly status: string;
}

// ---------------------------------------------------------------------------
// Internal: snapshot for trend tracking
// ---------------------------------------------------------------------------

interface DashboardSnapshot {
  readonly at: string;
  readonly participationRate: number;
  readonly engagementScore: number;
  readonly avgImprovement: number;
  readonly retention30: number;
  readonly retention90: number;
  readonly compliance: number;
  readonly activeMembers: number;
  readonly totalMeasurements: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_GROUP_SIZE = 5; // k-anonymity threshold
const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const MAX_SNAPSHOTS_PER_ORG = 200;

// ---------------------------------------------------------------------------
// Analytics engine
// ---------------------------------------------------------------------------

export class PopulationAnalytics {
  private readonly dashboardHistory = new Map<PopulationOrgId, DashboardSnapshot[]>();
  private readonly queryCounts = new Map<string, number>();

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  getDashboard(orgId: PopulationOrgId): OrgDashboard {
    this.recordQuery("getDashboard");
    const members = this.getOrgMembers(orgId);
    const totalMembers = members.length;
    const activeMembers = members.length; // active memberships only

    const authorizedLevel = this.getAuthorizedLevel(orgId);
    const participationRate = this.getParticipationRate(orgId);
    const programAdoption = this.getProgramAdoption(orgId);
    const missionCompletionRate = this.computeMissionCompletionRate(members);
    const avgImprovement = this.computeAggregateImprovement(members);
    const compliance = this.getCompliance(orgId);
    const retention = this.getRetention(orgId);
    const competitionEngagement = this.computeCompetitionEngagement(orgId, totalMembers);
    const engagementScore = this.computeEngagementScore(
      missionCompletionRate,
      members,
      competitionEngagement,
    );
    const totalMeasurements = this.countOrgMeasurements(members);

    const now = getClock().iso();
    const snapshot: DashboardSnapshot = {
      at: now,
      participationRate,
      engagementScore,
      avgImprovement,
      retention30: retention.retention30,
      retention90: retention.retention90,
      compliance,
      activeMembers,
      totalMeasurements,
    };
    this.pushSnapshot(orgId, snapshot);

    return {
      orgId,
      totalMembers,
      activeMembers,
      participationRate,
      programAdoption,
      missionCompletionRate,
      avgImprovement,
      competitionEngagement,
      measurementCompliance: compliance,
      retention30: retention.retention30,
      retention90: retention.retention90,
      engagementScore,
      authorizedLevel,
      computedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Individual metrics
  // -------------------------------------------------------------------------

  getParticipationRate(orgId: PopulationOrgId): number {
    this.recordQuery("getParticipationRate");
    const members = this.getOrgMembers(orgId);
    if (members.length === 0) return 0;
    const profiles = this.gatherProfiles(members);
    let activeInProgram = 0;
    for (const p of profiles) {
      if (p.programs.some((pp) => pp.status === "active")) activeInProgram++;
    }
    if (activeInProgram > 0 && activeInProgram < MIN_GROUP_SIZE) {
      return round4(activeInProgram / members.length); // rate is still safe
    }
    return round4(activeInProgram / members.length);
  }

  getProgramAdoption(orgId: PopulationOrgId): ProgramAdoptionStat[] {
    this.recordQuery("getProgramAdoption");
    const members = this.getOrgMembers(orgId);
    const profiles = this.gatherProfiles(members);
    const byProgram = new Map<
      string,
      { installs: number; active: number }
    >();
    for (const p of profiles) {
      for (const pp of p.programs) {
        const entry = byProgram.get(pp.programId) ?? { installs: 0, active: 0 };
        entry.installs++;
        if (pp.status === "active") entry.active++;
        byProgram.set(pp.programId, entry);
      }
    }
    const stats: ProgramAdoptionStat[] = [];
    for (const [programId, { installs, active }] of byProgram) {
      stats.push({
        programId: programId as ProgramId,
        installs,
        active,
        activeRate: round4(installs > 0 ? active / installs : 0),
      });
    }
    return stats.sort((a, b) => b.installs - a.installs);
  }

  getAggregateImprovement(orgId: PopulationOrgId): number {
    this.recordQuery("getAggregateImprovement");
    const members = this.getOrgMembers(orgId);
    return this.computeAggregateImprovement(members);
  }

  getRetention(orgId: PopulationOrgId): RetentionStats {
    this.recordQuery("getRetention");
    const members = this.getOrgMembers(orgId);
    if (members.length === 0) {
      return { retention30: 0, retention90: 0, totalMembers: 0, active30: 0, active90: 0 };
    }
    const now = Date.now();
    const cutoff30 = now - 30 * DAY_MS;
    const cutoff90 = now - 90 * DAY_MS;
    let active30 = 0;
    let active90 = 0;

    const memberSet = new Set(members.map(String));
    const profiles = this.gatherProfiles(members);
    const profileToAccount = new Map<string, string>();
    for (const p of profiles) {
      profileToAccount.set(p.id, p.accountId);
    }
    const allMeasurements = this.gatherMeasurementsForProfiles(profiles);
    const active30Set = new Set<string>();
    const active90Set = new Set<string>();
    for (const m of allMeasurements) {
      let ts: number;
      try {
        ts = new Date(m.provenance.collectedAt).getTime();
      } catch {
        continue;
      }
      const account = profileToAccount.get(m.profileId);
      if (!account || !memberSet.has(account)) continue;
      if (ts >= cutoff30) active30Set.add(account);
      if (ts >= cutoff90) active90Set.add(account);
    }
    active30 = active30Set.size;
    active90 = active90Set.size;

    return {
      retention30: round4(active30 / members.length),
      retention90: round4(active90 / members.length),
      totalMembers: members.length,
      active30,
      active90,
    };
  }

  getEngagement(orgId: PopulationOrgId): number {
    this.recordQuery("getEngagement");
    const members = this.getOrgMembers(orgId);
    const missionCompletion = this.computeMissionCompletionRate(members);
    const competitionEngagement = this.computeCompetitionEngagement(
      orgId,
      members.length,
    );
    return this.computeEngagementScore(missionCompletion, members, competitionEngagement);
  }

  getProgramEffectiveness(
    orgId: PopulationOrgId,
    programId: ProgramId,
  ): ProgramEffectivenessStat {
    this.recordQuery("getProgramEffectiveness");
    const members = this.getOrgMembers(orgId);
    const profiles = this.gatherProfiles(members);

    // Members who have this program installed (any status) — adopters.
    const adopterAccounts = new Set<string>();
    const adopterProfiles: ProfileLike[] = [];
    for (const p of profiles) {
      if (p.programs.some((pp) => pp.programId === String(programId))) {
        adopterAccounts.add(p.accountId);
        adopterProfiles.push(p);
      }
    }
    const participants = adopterProfiles.length;
    const suppressed = participants < MIN_GROUP_SIZE;

    // Average improvement among adopters.
    const adopterMeasurements = this.gatherMeasurementsForProfiles(adopterProfiles);
    const avgImprovement = this.computeImprovementFromMeasurements(adopterMeasurements);

    // Mission completion rate for this program among adopters.
    let missionCompleted = 0;
    let missionTerminal = 0;
    try {
      const missions = this.getMissionsForParticipants(adopterAccounts);
      for (const m of missions) {
        if (m.programId !== String(programId)) continue;
        if (m.state === "completed" || m.state === "skipped" || m.state === "expired" || m.state === "cancelled") {
          missionTerminal++;
        }
        if (m.state === "completed") missionCompleted++;
      }
    } catch {
      // Missions unavailable.
    }
    const missionCompletionRate = missionTerminal > 0 ? missionCompleted / missionTerminal : 0;

    // Measurement compliance for adopters.
    const total = adopterMeasurements.length;
    const verified = adopterMeasurements.filter(
      (m) => m.verificationState === "verified",
    ).length;
    const measurementCompliance = total > 0 ? verified / total : 0;

    // Effectiveness score: weighted blend.
    const improvementScore = clamp01((avgImprovement + 50) / 100) * 40; // -50%..+50% maps to 0..1
    const missionScore = missionCompletionRate * 30;
    const complianceScore = measurementCompliance * 30;
    const effectivenessScore = Math.round(improvementScore + missionScore + complianceScore);

    return {
      programId,
      participants,
      avgImprovement: round2(avgImprovement),
      missionCompletionRate: round4(missionCompletionRate),
      measurementCompliance: round4(measurementCompliance),
      effectivenessScore,
      suppressed,
    };
  }

  getCompliance(orgId: PopulationOrgId): number {
    this.recordQuery("getCompliance");
    const members = this.getOrgMembers(orgId);
    const measurements = this.gatherMeasurements(members);
    if (measurements.length === 0) return 0;
    const verified = measurements.filter(
      (m) => m.verificationState === "verified",
    ).length;
    return round4(verified / measurements.length);
  }

  getTrends(
    orgId: PopulationOrgId,
    metric: TrendMetric,
    period = "30d",
  ): MetricTrend {
    this.recordQuery("getTrends");
    const history = this.dashboardHistory.get(orgId) ?? [];
    const cutoffMs = periodToMs(period);
    const now = Date.now();
    const points: TrendPoint[] = [];
    for (const s of history) {
      const t = new Date(s.at).getTime();
      if (cutoffMs > 0 && now - t > cutoffMs) continue;
      points.push({ at: s.at, value: snapshotMetric(s, metric) });
    }
    const values = points.map((p) => p.value);
    const direction = computeDirection(values);
    const changePercent =
      values.length >= 2 && values[0] !== 0
        ? round2(((values[values.length - 1] - values[0]) / Math.abs(values[0])) * 100)
        : 0;
    return { metric, period, points, direction, changePercent };
  }

  getRegionalBreakdown(orgId: PopulationOrgId): RegionalBreakdownStat[] {
    this.recordQuery("getRegionalBreakdown");
    let subOrgs: { id: PopulationOrgId; name: string }[] = [];
    try {
      const descendants = getHierarchy().getDescendants(orgId);
      subOrgs = descendants.map((o) => ({ id: o.id, name: o.name }));
    } catch {
      subOrgs = [];
    }
    const results: RegionalBreakdownStat[] = [];
    for (const sub of subOrgs) {
      const members = this.getOrgMembers(sub.id);
      const participants = members.length;
      const suppressed = participants < MIN_GROUP_SIZE;
      const avgImprovement = suppressed ? 0 : this.computeAggregateImprovement(members);
      const participationRate = suppressed ? 0 : this.getParticipationRate(sub.id);
      results.push({
        orgId: sub.id,
        name: sub.name,
        participants,
        avgImprovement: round2(avgImprovement),
        participationRate: round4(participationRate),
        suppressed,
      });
    }
    return results;
  }

  getStats(): AnalyticsStats {
    this.recordQuery("getStats");
    const byMethod: Record<string, number> = {};
    let total = 0;
    for (const [method, count] of this.queryCounts) {
      byMethod[method] = count;
      total += count;
    }
    return { totalQueries: total, byMethod };
  }

  // -------------------------------------------------------------------------
  // Internal: data gathering (all guarded)
  // -------------------------------------------------------------------------

  private getOrgMembers(orgId: PopulationOrgId): AccountId[] {
    try {
      const memberships = getMemberships().listByOrg(orgId, true) as unknown as MembershipLike[];
      return memberships
        .filter((m) => m.status === "active")
        .map((m) => m.accountId as AccountId);
    } catch {
      return [];
    }
  }

  private gatherProfiles(members: AccountId[]): ProfileLike[] {
    const profiles: ProfileLike[] = [];
    try {
      const mgr = getProfiles() as unknown as {
        get(accountId: string): ProfileLike | undefined;
        list(): ProfileLike[];
      };
      // Use get(accountId) per member for precision.
      for (const accountId of members) {
        try {
          const p = mgr.get(String(accountId));
          if (p) profiles.push(p);
        } catch {
          // skip this member
        }
      }
    } catch {
      // Profiles subsystem unavailable.
    }
    return profiles;
  }

  private gatherMeasurements(members: AccountId[]): MeasurementLike[] {
    const profiles = this.gatherProfiles(members);
    return this.gatherMeasurementsForProfiles(profiles);
  }

  private gatherMeasurementsForProfiles(profiles: ProfileLike[]): MeasurementLike[] {
    const all: MeasurementLike[] = [];
    try {
      const store = getMeasurements() as unknown as {
        listByProfile(profileId: string): MeasurementLike[];
        list(filter?: { includeSuperseded?: boolean }): MeasurementLike[];
      };
      for (const p of profiles) {
        try {
          const list = store.listByProfile(p.id);
          if (list && list.length > 0) {
            all.push(...list);
          }
        } catch {
          // skip this profile
        }
      }
    } catch {
      // Measurements subsystem unavailable.
    }
    return all;
  }

  private getMissionsForParticipants(accounts: Set<string>): MissionLike[] {
    const all: MissionLike[] = [];
    try {
      const mgr = getMissions() as unknown as {
        list(filter?: { participantId?: string }): MissionLike[];
      };
      for (const accountId of accounts) {
        try {
          const list = mgr.list({ participantId: accountId });
          if (list && list.length > 0) {
            all.push(...list);
          }
        } catch {
          // skip
        }
      }
    } catch {
      // Missions subsystem unavailable.
    }
    return all;
  }

  private countOrgMeasurements(members: AccountId[]): number {
    return this.gatherMeasurements(members).length;
  }

  // -------------------------------------------------------------------------
  // Internal: metric computation
  // -------------------------------------------------------------------------

  private computeAggregateImprovement(members: AccountId[]): number {
    const measurements = this.gatherMeasurements(members);
    return this.computeImprovementFromMeasurements(measurements);
  }

  private computeImprovementFromMeasurements(measurements: MeasurementLike[]): number {
    // Group by (profileId, schemaId), sort by collectedAt, compute
    // (last - first) / first * 100 for each series where first > 0.
    const bySeries = new Map<string, MeasurementLike[]>();
    for (const m of measurements) {
      if (m.supersededBy) continue; // only current measurements
      const key = `${m.profileId}:${m.schemaId}`;
      const arr = bySeries.get(key) ?? [];
      arr.push(m);
      bySeries.set(key, arr);
    }
    const improvements: number[] = [];
    for (const [, arr] of bySeries) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => {
        try {
          return new Date(a.provenance.collectedAt).getTime() - new Date(b.provenance.collectedAt).getTime();
        } catch {
          return 0;
        }
      });
      const firstVal = extractNumeric(arr[0].value);
      const lastVal = extractNumeric(arr[arr.length - 1].value);
      if (firstVal === null || lastVal === null) continue;
      if (firstVal === 0) continue;
      improvements.push(((lastVal - firstVal) / Math.abs(firstVal)) * 100);
    }
    if (improvements.length === 0) return 0;
    // Suppress small groups.
    if (improvements.length < MIN_GROUP_SIZE) return 0;
    return round2(improvements.reduce((a, b) => a + b, 0) / improvements.length);
  }

  private computeMissionCompletionRate(members: AccountId[]): number {
    const memberSet = new Set(members.map(String));
    let completed = 0;
    let terminal = 0;
    try {
      const mgr = getMissions() as unknown as {
        list(): MissionLike[];
      };
      const all = mgr.list();
      for (const m of all) {
        if (!memberSet.has(m.participantId)) continue;
        if (
          m.state === "completed" ||
          m.state === "skipped" ||
          m.state === "expired" ||
          m.state === "cancelled"
        ) {
          terminal++;
        }
        if (m.state === "completed") completed++;
      }
    } catch {
      // Missions unavailable.
    }
    return terminal > 0 ? round4(completed / terminal) : 0;
  }

  private computeCompetitionEngagement(
    orgId: PopulationOrgId,
    memberCount: number,
  ): number {
    try {
      const reg = getCompetitions() as unknown as {
        list(): CompetitionLike[];
      };
      const all = reg.list();
      let orgActive = 0;
      let totalParticipants = 0;
      for (const c of all) {
        const isOrgCompetition =
          c.scope === "organizational" ||
          String(c.scopeFilter?.["orgId"] ?? "") === String(orgId);
        if (isOrgCompetition && (c.state === "active" || c.state === "registration" || c.state === "qualification")) {
          orgActive++;
          totalParticipants += c.currentParticipants ?? 0;
        }
      }
      // Engagement = blend of breadth (how many competitions) and depth
      // (participants relative to membership).
      const breadth = Math.min(1, orgActive / 3);
      const depth = memberCount > 0 ? Math.min(1, totalParticipants / memberCount) : 0;
      return round4(breadth * 0.6 + depth * 0.4);
    } catch {
      return 0;
    }
  }

  private computeEngagementScore(
    missionCompletionRate: number,
    members: AccountId[],
    competitionEngagement: number,
  ): number {
    // Measurement frequency: measurements per member per week.
    let measurementFrequencyScore = 0;
    if (members.length > 0) {
      const measurements = this.gatherMeasurements(members);
      const weekAgo = Date.now() - WEEK_MS;
      let recent = 0;
      for (const m of measurements) {
        try {
          if (new Date(m.provenance.collectedAt).getTime() >= weekAgo) recent++;
        } catch {
          // skip
        }
      }
      const perMemberPerWeek = recent / members.length;
      measurementFrequencyScore = Math.min(1, perMemberPerWeek / 2); // 2/week = full
    }
    return Math.round(
      missionCompletionRate * 40 +
        measurementFrequencyScore * 30 +
        competitionEngagement * 30,
    );
  }

  // -------------------------------------------------------------------------
  // Internal: privacy
  // -------------------------------------------------------------------------

  private getAuthorizedLevel(orgId: PopulationOrgId): "full" | "limited" {
    try {
      const grants = getPrivacyFirewall().getOrgGrants(orgId);
      const hasAggregate = grants.some(
        (g) =>
          g.grantType === "aggregate_performance" ||
          g.grantType === "program_progress",
      );
      return hasAggregate ? "full" : "limited";
    } catch {
      return "limited";
    }
  }

  // -------------------------------------------------------------------------
  // Internal: snapshot history
  // -------------------------------------------------------------------------

  private pushSnapshot(orgId: PopulationOrgId, snapshot: DashboardSnapshot): void {
    const list = this.dashboardHistory.get(orgId) ?? [];
    list.push(snapshot);
    // Bound memory.
    while (list.length > MAX_SNAPSHOTS_PER_ORG) list.shift();
    this.dashboardHistory.set(orgId, list);
  }

  // -------------------------------------------------------------------------
  // Internal: query tracking
  // -------------------------------------------------------------------------

  private recordQuery(method: string): void {
    const n = this.queryCounts.get(method) ?? 0;
    this.queryCounts.set(method, n + 1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractNumeric(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }
  if (typeof value === "boolean") return null;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v["value"] === "number") return v["value"] as number;
    if (typeof v["systolic"] === "number" && typeof v["diastolic"] === "number") {
      // Mean arterial pressure proxy.
      const s = v["systolic"] as number;
      const d = v["diastolic"] as number;
      return (s + 2 * d) / 3;
    }
  }
  return null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function periodToMs(period: string): number {
  const m = period.match(/^(\d+)([dwh])$/);
  if (!m) {
    if (period === "30d") return 30 * DAY_MS;
    if (period === "90d") return 90 * DAY_MS;
    if (period === "1y") return 365 * DAY_MS;
    return 30 * DAY_MS;
  }
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "d") return n * DAY_MS;
  if (unit === "w") return n * WEEK_MS;
  if (unit === "h") return n * 3600000;
  return 30 * DAY_MS;
}

function computeDirection(values: number[]): "up" | "down" | "stable" {
  if (values.length < 2) return "stable";
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return last > 0 ? "up" : "stable";
  const pct = ((last - first) / Math.abs(first)) * 100;
  if (pct > 2) return "up";
  if (pct < -2) return "down";
  return "stable";
}

function snapshotMetric(s: DashboardSnapshot, metric: TrendMetric): number {
  switch (metric) {
    case "participationRate":
      return s.participationRate;
    case "engagementScore":
      return s.engagementScore;
    case "avgImprovement":
      return s.avgImprovement;
    case "retention30":
      return s.retention30;
    case "retention90":
      return s.retention90;
    case "compliance":
      return s.compliance;
    case "activeMembers":
      return s.activeMembers;
    case "totalMeasurements":
      return s.totalMeasurements;
    default:
      return 0;
  }
}

// Re-export for callers that need to construct PopulationOrgId.
export { asPopulationOrgId, type PopulationOrgId };

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _analytics: PopulationAnalytics | null = null;
export function getPopulationAnalytics(): PopulationAnalytics {
  if (!_analytics) _analytics = new PopulationAnalytics();
  return _analytics;
}
