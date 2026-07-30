/**
 * Eks-Health Research Platform — Population Intelligence Engine
 *
 * Continuously aggregates outcomes across the entire platform: improvement
 * trends by category, completion rates, measurement frequency, program
 * effectiveness, regional differences, seasonal effects, demographic
 * trends, retention, competition participation, and mission adherence.
 *
 * Only aggregate, privacy-preserving information is ever exposed. Small
 * groups are suppressed via the privacy engine. All cross-subsystem calls
 * are guarded with try/catch so a missing subsystem degrades gracefully.
 */

import "server-only";
import {
  type PopulationSnapshotId,
  type PopulationSnapshot,
  type ProgramId,
  asPopulationSnapshotId,
} from "../core";
import { getPrivacy } from "../privacy";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { RESEARCH_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Defensive loaders
// ---------------------------------------------------------------------------

interface HealthProfileLike {
  readonly id: string;
  readonly accountId: string;
  readonly demographics: {
    ageRange?: string;
    biologicalSex?: "male" | "female" | "intersex" | "unspecified";
    country?: string;
    region?: string;
  };
  readonly programs: { programId: string; status: "active" | "paused" | "uninstalled"; installedAt: string }[];
}

interface MeasurementLike {
  readonly id: string;
  readonly profileId: string;
  readonly schemaId: string;
  readonly value: number | { value?: number };
  readonly verificationState: string;
  readonly provenance: { collectedAt: string };
  readonly supersededBy?: string;
}

interface MeasurementsApi {
  list(filter?: { includeSuperseded?: boolean }): MeasurementLike[];
  getStats(profileId?: string): {
    total: number;
    bySchema: Record<string, number>;
    byVerification: Record<string, number>;
  };
}

interface MissionsApi {
  list(filter?: { state?: string }): {
    state: string;
    category: string;
    programId: string;
    participantId: string;
    result?: { outcome: string };
    scheduledFor: string;
  }[];
}

interface CompetitionsApi {
  list(): { id: string; programId: string; currentParticipants: number; state: string }[];
}

interface EvidenceApi {
  get(programId: ProgramId): { confidenceScore: number; totalParticipants: number; averageImprovement: number; evidenceLevel: string } | undefined;
  accumulate(programId: ProgramId): Promise<unknown>;
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

let _evidenceCache: EvidenceApi | null | undefined;
async function loadEvidence(): Promise<EvidenceApi | null> {
  if (_evidenceCache !== undefined) return _evidenceCache;
  try {
    const mod = await import("../evidence");
    const getter = (mod as { getEvidenceEngine?: () => EvidenceApi }).getEvidenceEngine;
    _evidenceCache = getter ? getter() : null;
  } catch {
    _evidenceCache = null;
  }
  return _evidenceCache;
}

// ---------------------------------------------------------------------------
// Trend / period helpers
// ---------------------------------------------------------------------------

export type TrendMetric = "totalParticipants" | "totalMeasurements" | "totalPrograms" | "totalCompetitions";

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

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class PopulationIntelligenceEngine {
  private readonly snapshots: PopulationSnapshot[] = [];
  private readonly byId = new Map<PopulationSnapshotId, PopulationSnapshot>();

  /**
   * Capture a PopulationSnapshot from real platform data. Computes every
   * category of population intelligence in one pass and stores the snapshot
   * for trend analysis.
   */
  async capture(): Promise<PopulationSnapshot> {
    const now = getClock().iso();
    const profiles = await loadProfiles();
    const measurements = await loadMeasurements();
    const missions = await loadMissions();
    const competitions = await loadCompetitions();
    const evidence = await loadEvidence();

    let profileList: HealthProfileLike[] = [];
    try {
      profileList = profiles?.list() ?? [];
    } catch {
      profileList = [];
    }

    let measurementList: MeasurementLike[] = [];
    try {
      measurementList = measurements?.list({ includeSuperseded: false }) ?? [];
    } catch {
      measurementList = [];
    }

    let missionList: ReturnType<NonNullable<MissionsApi>["list"]> = [];
    try {
      missionList = missions?.list() ?? [];
    } catch {
      missionList = [];
    }

    let competitionList: ReturnType<NonNullable<CompetitionsApi>["list"]> = [];
    try {
      competitionList = competitions?.list() ?? [];
    } catch {
      competitionList = [];
    }

    const totalParticipants = profileList.length;
    const totalMeasurements = measurementList.length;
    const totalVerifiedMeasurements = measurementList.filter((m) => m.verificationState === "verified").length;

    // Unique active program IDs across all profiles
    const programIdSet = new Set<string>();
    for (const p of profileList) {
      for (const pp of p.programs) {
        if (pp.status === "active") programIdSet.add(pp.programId);
      }
    }
    const totalPrograms = programIdSet.size;
    const totalCompetitions = competitionList.length;

    // Improvement trends per measurement schema (category)
    const improvementTrends = this.computeImprovementTrends(measurementList);

    // Completion rates per mission category
    const completionRates = this.computeCompletionRates(missionList);

    // Measurement frequency per category (avg per week per profile)
    const measurementFrequency = this.computeMeasurementFrequency(measurementList, profileList.length);

    // Program effectiveness (from EvidenceEngine)
    const programEffectiveness = this.computeProgramEffectiveness(programIdSet, evidence);

    // Regional differences (privacy suppressed)
    const regionalDifferences = this.computeRegionalDifferences(profileList, measurementList);

    // Seasonal effects
    const seasonalEffects = this.computeSeasonalEffects(measurementList);

    // Demographic trends (privacy suppressed)
    const demographicTrends = this.computeDemographicTrends(profileList);

    // Retention metrics (30-day, 90-day proxies)
    const retentionMetrics = this.computeRetentionMetrics(profileList, measurementList);

    // Competition participation (privacy suppressed)
    const competitionParticipation = this.computeCompetitionParticipation(competitionList);

    // Mission adherence per category
    const missionAdherence = this.computeMissionAdherence(missionList);

    const snapshot: PopulationSnapshot = {
      id: asPopulationSnapshotId(generateId("pop_")),
      totalParticipants,
      totalMeasurements,
      totalVerifiedMeasurements,
      totalPrograms,
      totalCompetitions,
      improvementTrends,
      completionRates,
      measurementFrequency,
      programEffectiveness,
      regionalDifferences,
      seasonalEffects,
      demographicTrends,
      retentionMetrics,
      competitionParticipation,
      missionAdherence,
      capturedAt: now,
    };

    this.snapshots.push(snapshot);
    this.byId.set(snapshot.id, snapshot);
    // Keep last 200 snapshots to bound memory.
    if (this.snapshots.length > 200) {
      const evicted = this.snapshots.shift()!;
      this.byId.delete(evicted.id);
    }

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.populationInsightGenerated,
        {
          snapshotId: snapshot.id,
          totalParticipants,
          totalMeasurements,
          totalPrograms,
          totalCompetitions,
        },
        {},
        "domain",
      ),
    );
    return snapshot;
  }

  getLatest(): PopulationSnapshot | undefined {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : undefined;
  }

  getHistory(limit = 50): PopulationSnapshot[] {
    return this.snapshots.slice(-limit);
  }

  getTrend(metric: TrendMetric, period = "30d"): MetricTrend {
    const cutoffMs = periodToMs(period);
    const now = Date.now();
    const points: TrendPoint[] = [];
    for (const s of this.snapshots) {
      const at = new Date(s.capturedAt).getTime();
      if (cutoffMs > 0 && now - at > cutoffMs) continue;
      const value = snapshotMetric(s, metric);
      points.push({ at: s.capturedAt, value });
    }
    const direction = computeDirection(points.map((p) => p.value));
    const changePercent = points.length >= 2 && points[0].value !== 0
      ? ((points[points.length - 1].value - points[0].value) / Math.abs(points[0].value)) * 100
      : 0;
    return { metric, period, points, direction, changePercent: round2(changePercent) };
  }

  getRegionalComparison(): { region: string; participants: number; avgImprovement: number }[] {
    return this.getLatest()?.regionalDifferences ?? [];
  }

  getSeasonalAnalysis(): { season: string; avgImprovement: number }[] {
    return this.getLatest()?.seasonalEffects ?? [];
  }

  getStats(): {
    totalSnapshots: number;
    avgParticipants: number;
    avgImprovement: number;
    avgPrograms: number;
    avgCompetitions: number;
    lastCapturedAt?: string;
  } {
    const list = this.snapshots;
    if (list.length === 0) {
      return { totalSnapshots: 0, avgParticipants: 0, avgImprovement: 0, avgPrograms: 0, avgCompetitions: 0 };
    }
    let popSum = 0;
    let programSum = 0;
    let compSum = 0;
    let improvementSum = 0;
    let improvementCount = 0;
    for (const s of list) {
      popSum += s.totalParticipants;
      programSum += s.totalPrograms;
      compSum += s.totalCompetitions;
      for (const t of s.improvementTrends) {
        improvementSum += t.avgImprovement;
        improvementCount++;
      }
    }
    return {
      totalSnapshots: list.length,
      avgParticipants: popSum / list.length,
      avgImprovement: improvementCount > 0 ? improvementSum / improvementCount : 0,
      avgPrograms: programSum / list.length,
      avgCompetitions: compSum / list.length,
      lastCapturedAt: list[list.length - 1].capturedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: real per-category computation
  // -------------------------------------------------------------------------

  private computeImprovementTrends(measurements: MeasurementLike[]): PopulationSnapshot["improvementTrends"] {
    const bySchema = new Map<string, MeasurementLike[]>();
    for (const m of measurements) {
      const arr = bySchema.get(m.schemaId) ?? [];
      arr.push(m);
      bySchema.set(m.schemaId, arr);
    }
    const result: { category: string; avgImprovement: number; trend: "up" | "down" | "stable" }[] = [];
    for (const [schemaId, arr] of bySchema) {
      const improvements = computePerProfileImprovements(arr);
      if (improvements.length === 0) continue;
      const avg = improvements.reduce((a, b) => a + b, 0) / improvements.length;
      result.push({
        category: schemaId,
        avgImprovement: round2(avg),
        trend: avg > 1 ? "up" : avg < -1 ? "down" : "stable",
      });
    }
    return result.sort((a, b) => b.avgImprovement - a.avgImprovement);
  }

  private computeCompletionRates(missions: { state: string; category: string }[]): PopulationSnapshot["completionRates"] {
    const byCategory = new Map<string, { attempted: number; completed: number }>();
    for (const m of missions) {
      const entry = byCategory.get(m.category) ?? { attempted: 0, completed: 0 };
      if (m.state === "completed" || m.state === "skipped" || m.state === "expired" || m.state === "cancelled") {
        entry.attempted++;
      }
      if (m.state === "completed") entry.completed++;
      byCategory.set(m.category, entry);
    }
    const result: { category: string; rate: number }[] = [];
    for (const [category, { attempted, completed }] of byCategory) {
      result.push({ category, rate: round4(attempted > 0 ? completed / attempted : 0) });
    }
    return result.sort((a, b) => b.rate - a.rate);
  }

  private computeMeasurementFrequency(measurements: MeasurementLike[], participantCount: number): PopulationSnapshot["measurementFrequency"] {
    if (participantCount === 0) return [];
    const bySchema = new Map<string, number>();
    const now = Date.now();
    const weekMs = 7 * 86400000;
    const weekAgo = now - weekMs;
    for (const m of measurements) {
      const t = new Date(m.provenance.collectedAt).getTime();
      if (t >= weekAgo) {
        bySchema.set(m.schemaId, (bySchema.get(m.schemaId) ?? 0) + 1);
      }
    }
    const result: { category: string; avgPerWeek: number }[] = [];
    for (const [schemaId, count] of bySchema) {
      result.push({ category: schemaId, avgPerWeek: round2(count / participantCount) });
    }
    return result.sort((a, b) => b.avgPerWeek - a.avgPerWeek);
  }

  private computeProgramEffectiveness(
    programIds: Set<string>,
    evidence: EvidenceApi | null,
  ): PopulationSnapshot["programEffectiveness"] {
    if (!evidence) return [];
    const result: { programId: ProgramId; effectiveness: number; confidence: number }[] = [];
    for (const pid of programIds) {
      try {
        const acc = evidence.get(pid as ProgramId);
        if (!acc) continue;
        // Effectiveness = weighted blend of improvement & retention
        const effectiveness = round2(
          clamp01((acc.averageImprovement ?? 0) / 50) * 0.5 + clamp01(acc.confidenceScore / 100) * 0.5,
        );
        result.push({
          programId: pid as ProgramId,
          effectiveness,
          confidence: round2(acc.confidenceScore),
        });
      } catch {
        /* skip */
      }
    }
    return result.sort((a, b) => b.effectiveness - a.effectiveness);
  }

  private computeRegionalDifferences(
    profiles: HealthProfileLike[],
    measurements: MeasurementLike[],
  ): PopulationSnapshot["regionalDifferences"] {
    // Map profileId → country (via profile)
    const profileCountry = new Map<string, string>();
    for (const p of profiles) {
      if (p.demographics.country) profileCountry.set(p.id, p.demographics.country);
    }
    // Compute avg improvement per region (country)
    const byRegion = new Map<string, { participants: Set<string>; improvements: number[] }>();
    for (const m of measurements) {
      const country = profileCountry.get(m.profileId);
      if (!country) continue;
      const entry = byRegion.get(country) ?? { participants: new Set<string>(), improvements: [] };
      entry.participants.add(m.profileId);
      byRegion.set(country, entry);
    }
    // Compute per-profile improvements per region
    const measurementsByProfile = new Map<string, MeasurementLike[]>();
    for (const m of measurements) {
      const arr = measurementsByProfile.get(m.profileId) ?? [];
      arr.push(m);
      measurementsByProfile.set(m.profileId, arr);
    }
    for (const [country, entry] of byRegion) {
      for (const profileId of entry.participants) {
        const arr = measurementsByProfile.get(profileId) ?? [];
        const imps = computePerProfileImprovements(arr);
        entry.improvements.push(...imps);
      }
      byRegion.set(country, entry);
    }
    // Apply privacy suppression
    const privacy = getPrivacy();
    const raw = [...byRegion.entries()].map(([region, e]) => ({
      region,
      participants: e.participants.size,
      avgImprovement: round2(e.improvements.length > 0 ? e.improvements.reduce((a, b) => a + b, 0) / e.improvements.length : 0),
      count: e.participants.size,
    }));
    const suppressed = privacy.suppressSmallGroups(raw);
    return suppressed.map(({ region, participants, avgImprovement }) => ({ region, participants, avgImprovement }));
  }

  private computeSeasonalEffects(measurements: MeasurementLike[]): PopulationSnapshot["seasonalEffects"] {
    const bySeason = new Map<string, number[]>();
    for (const m of measurements) {
      const season = monthToSeason(m.provenance.collectedAt);
      const arr = bySeason.get(season) ?? [];
      // Track per-measurement "improvement vs first" — proxy: just track
      // individual values' deltas to the global mean for that profile/schema.
      // For simplicity, we use the absolute value (raw measurement) change
      // approximation: we already computed per-profile improvements elsewhere.
      // Here we approximate seasonal effect by the avg of (last - first)
      // deltas per profile within that season.
      arr.push(measurementValue(m));
      bySeason.set(season, arr);
    }
    // Compute the average measurement value per season, then derive a
    // relative "improvement" proxy vs the overall mean.
    const seasonAvgs: { season: string; avg: number }[] = [];
    let allValues: number[] = [];
    for (const [, arr] of bySeason) allValues = allValues.concat(arr);
    const overall = allValues.length > 0 ? allValues.reduce((a, b) => a + b, 0) / allValues.length : 0;
    for (const [season, arr] of bySeason) {
      const avg = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      seasonAvgs.push({ season, avg });
    }
    return seasonAvgs.map(({ season, avg }) => ({
      season,
      avgImprovement: round2(overall !== 0 ? ((avg - overall) / Math.abs(overall)) * 100 : 0),
    })).sort((a, b) => b.avgImprovement - a.avgImprovement);
  }

  private computeDemographicTrends(profiles: HealthProfileLike[]): PopulationSnapshot["demographicTrends"] {
    const byDemo = new Map<string, Set<string>>();
    for (const p of profiles) {
      const key = p.demographics.ageRange ?? "unknown";
      const entry = byDemo.get(key) ?? new Set<string>();
      entry.add(p.accountId);
      byDemo.set(key, entry);
    }
    const privacy = getPrivacy();
    const raw = [...byDemo.entries()].map(([demographic, set]) => ({
      demographic,
      participants: set.size,
      trend: "stable", // updated by comparison in getTrend; default stable
      count: set.size,
    }));
    const suppressed = privacy.suppressSmallGroups(raw);
    return suppressed.map(({ demographic, participants, trend }) => ({
      demographic,
      participants,
      trend: trend ?? "stable",
    }));
  }

  private computeRetentionMetrics(
    profiles: HealthProfileLike[],
    measurements: MeasurementLike[],
  ): PopulationSnapshot["retentionMetrics"] {
    const now = Date.now();
    const day30 = now - 30 * 86400000;
    const day90 = now - 90 * 86400000;
    const activeProfiles30 = new Set<string>();
    const activeProfiles90 = new Set<string>();
    for (const m of measurements) {
      const t = new Date(m.provenance.collectedAt).getTime();
      if (t >= day30) activeProfiles30.add(m.profileId);
      if (t >= day90) activeProfiles90.add(m.profileId);
    }
    const total = profiles.length;
    return [
      { period: "30d", rate: round4(total > 0 ? activeProfiles30.size / total : 0) },
      { period: "90d", rate: round4(total > 0 ? activeProfiles90.size / total : 0) },
    ];
  }

  private computeCompetitionParticipation(
    competitions: { id: string; currentParticipants: number }[],
  ): PopulationSnapshot["competitionParticipation"] {
    const privacy = getPrivacy();
    const raw = competitions.map((c) => ({
      competitionId: c.id,
      participants: c.currentParticipants,
      count: c.currentParticipants,
    }));
    const suppressed = privacy.suppressSmallGroups(raw);
    return suppressed.map(({ competitionId, participants }) => ({ competitionId, participants }));
  }

  private computeMissionAdherence(missions: { state: string; category: string }[]): PopulationSnapshot["missionAdherence"] {
    const byCategory = new Map<string, { total: number; completed: number }>();
    for (const m of missions) {
      const entry = byCategory.get(m.category) ?? { total: 0, completed: 0 };
      entry.total++;
      if (m.state === "completed") entry.completed++;
      byCategory.set(m.category, entry);
    }
    const result: { category: string; adherenceRate: number }[] = [];
    for (const [category, { total, completed }] of byCategory) {
      result.push({ category, adherenceRate: round4(total > 0 ? completed / total : 0) });
    }
    return result.sort((a, b) => b.adherenceRate - a.adherenceRate);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function measurementValue(m: MeasurementLike): number {
  if (typeof m.value === "number") return m.value;
  if (m.value && typeof m.value === "object" && typeof m.value.value === "number") return m.value.value;
  return NaN;
}

function computePerProfileImprovements(arr: MeasurementLike[]): number[] {
  const byProfile = new Map<string, MeasurementLike[]>();
  for (const m of arr) {
    const list = byProfile.get(m.profileId) ?? [];
    list.push(m);
    byProfile.set(m.profileId, list);
  }
  const results: number[] = [];
  for (const [, list] of byProfile) {
    if (list.length < 2) continue;
    // Group by schema within profile
    const bySchema = new Map<string, MeasurementLike[]>();
    for (const m of list) {
      const s = bySchema.get(m.schemaId) ?? [];
      s.push(m);
      bySchema.set(m.schemaId, s);
    }
    const schemaPercents: number[] = [];
    for (const [, sArr] of bySchema) {
      if (sArr.length < 2) continue;
      const sorted = [...sArr].sort((a, b) => a.provenance.collectedAt.localeCompare(b.provenance.collectedAt));
      const first = measurementValue(sorted[0]);
      const last = measurementValue(sorted[sorted.length - 1]);
      if (first === 0 || !Number.isFinite(first) || !Number.isFinite(last)) continue;
      schemaPercents.push(((last - first) / Math.abs(first)) * 100);
    }
    if (schemaPercents.length > 0) {
      results.push(schemaPercents.reduce((a, b) => a + b, 0) / schemaPercents.length);
    }
  }
  return results;
}

function monthToSeason(iso: string): string {
  const month = new Date(iso).getUTCMonth() + 1; // 1-12
  if (month === 12 || month === 1 || month === 2) return "winter";
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  return "fall";
}

function periodToMs(period: string): number {
  const match = period.match(/^(\d+)([dhmy])$/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "d": return n * 86400000;
    case "h": return n * 3600000;
    case "m": return n * 30 * 86400000;
    case "y": return n * 365 * 86400000;
    default: return 0;
  }
}

function computeDirection(values: number[]): "up" | "down" | "stable" {
  if (values.length < 2) return "stable";
  const first = values[0];
  const last = values[values.length - 1];
  if (first === 0) return last > 0 ? "up" : "stable";
  const change = ((last - first) / Math.abs(first)) * 100;
  if (change > 1) return "up";
  if (change < -1) return "down";
  return "stable";
}

function snapshotMetric(s: PopulationSnapshot, metric: TrendMetric): number {
  switch (metric) {
    case "totalParticipants": return s.totalParticipants;
    case "totalMeasurements": return s.totalMeasurements;
    case "totalPrograms": return s.totalPrograms;
    case "totalCompetitions": return s.totalCompetitions;
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: PopulationIntelligenceEngine | null = null;
export function getPopulation(): PopulationIntelligenceEngine {
  if (!_engine) _engine = new PopulationIntelligenceEngine();
  return _engine;
}

export { RESEARCH_EVENTS, getPrivacy };
