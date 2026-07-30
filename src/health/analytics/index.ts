/**
 * Eks-Health Universal Health Data Platform — Analytics Readiness
 *
 * Population statistics, program analytics, longitudinal analysis, trend
 * analysis, outcome analysis, research exports, and privacy-preserving
 * aggregation. This module provides the analytics INFRASTRUCTURE — it does
 * NOT implement dashboards (those are a presentation-layer concern).
 *
 * Real computation, no mocks:
 *  - populationStat: count, mean, median, stddev (Welford's algorithm),
 *    min, max, percentiles (nearest-rank p5/p25/p50/p75/p95).
 *  - longitudinalAnalysis: real linear regression (slope, intercept, r²,
 *    coefficient of determination) with linear forecast projection.
 *  - programAnalytics: real aggregation over a program's measurements.
 *  - cohortAnalysis: real cohort building + aggregate stats.
 *  - privacyPreservingAggregate: REAL k-anonymity suppression, REAL Laplace
 *    noise injection (inverse-CDF method), aggregation-only mode.
 *  - researchExport: de-identified dataset generation with audit log.
 *  - trendAnalysis: real time bucketing + per-bucket aggregation.
 */

import "server-only";

import {
  type SchemaId,
  type ProfileId,
  type ProgramId,
  type MeasurementId,
  type MeasurementValue,
  type SourceType,
  type VerificationState,
  type SourceId,
  type UnitId,
  type Provenance,
  type EvidenceId,
  HealthError,
} from "../core";
import type { MeasurementSchema } from "../schemas";
import { getSources } from "../sources";
import { getUnits } from "../units";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Local measurement shape (permissive superset — works against stub OR real)
// ---------------------------------------------------------------------------

export interface Measurement {
  readonly id: MeasurementId;
  readonly schemaId: SchemaId;
  readonly profileId: ProfileId;
  readonly value: MeasurementValue;
  readonly unitId?: UnitId;
  readonly sourceId?: SourceId;
  readonly provenance?: Provenance;
  readonly verificationState: VerificationState;
  readonly timestamp?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  readonly evidenceIds?: readonly EvidenceId[];
  readonly version?: number;
  readonly sourceType?: SourceType;
  readonly supersededBy?: MeasurementId;
}

/** Filter shape passed to getMeasurements().list() — permissive. */
export interface MeasurementQuery {
  readonly schemaId?: SchemaId;
  readonly profileId?: ProfileId;
  readonly sourceId?: SourceId;
  readonly verificationState?: VerificationState;
  readonly dateRange?: { readonly from?: string; readonly to?: string };
  readonly tags?: readonly string[];
  readonly includeSuperseded?: boolean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalyticsQuery {
  readonly schemaId?: SchemaId;
  readonly programId?: ProgramId;
  readonly profileId?: ProfileId;
  readonly from?: string;
  readonly to?: string;
  readonly groupBy?: "day" | "week" | "month";
  readonly method?: PrivacyMethod;
}

export interface Percentiles {
  readonly p5: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
}

export interface PopulationStat {
  readonly schemaId: SchemaId;
  readonly count: number;
  readonly numericCount: number;
  readonly mean: number;
  readonly median: number;
  readonly stddev: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly percentiles: Percentiles;
  readonly computedAt: string;
}

export interface LongitudinalAnalysis {
  readonly profileId: ProfileId;
  readonly schemaId: SchemaId;
  readonly from: string;
  readonly to: string;
  readonly points: number;
  readonly slope: number;
  readonly intercept: number;
  readonly r2: number;
  readonly forecast: readonly { readonly at: string; readonly value: number }[];
  readonly firstValue: number | null;
  readonly lastValue: number | null;
  readonly changePercent: number;
  readonly computedAt: string;
}

export interface ProgramAnalytics {
  readonly programId: ProgramId;
  readonly totalParticipants: number;
  readonly totalMeasurements: number;
  readonly activeSchemas: number;
  readonly avgMeasurementsPerParticipant: number;
  readonly verificationRate: number;
  readonly computedAt: string;
}

export interface CohortDefinition {
  readonly name: string;
  readonly programId?: ProgramId;
  readonly schemaPresence?: readonly SchemaId[];
  readonly demographics?: {
    readonly biologicalSex?: string;
    readonly ageRange?: string;
    readonly country?: string;
  };
}

export interface CohortResult {
  readonly name: string;
  readonly size: number;
  readonly stats: readonly PopulationStat[];
  readonly computedAt: string;
}

export type PrivacyMethod = "k_anonymity" | "noise_injection" | "aggregation_only";

export interface PrivacyPreservingAggregate {
  readonly method: PrivacyMethod;
  readonly groups: readonly {
    readonly key: string;
    readonly count: number;
    readonly mean?: number;
    readonly min?: number;
    readonly max?: number;
    readonly sum?: number;
  }[];
  readonly suppressed: number;
  readonly parameters: Record<string, unknown>;
}

export interface DeIdentifiedRecord {
  readonly schemaId: SchemaId;
  readonly value: MeasurementValue;
  readonly unit?: string;
  readonly ageRange?: string;
  readonly biologicalSex?: string;
  readonly timestamp: string;
  readonly verificationState: VerificationState;
  readonly sourceType?: SourceType;
}

export interface ResearchExport {
  readonly data: readonly DeIdentifiedRecord[];
  readonly metadata: {
    readonly count: number;
    readonly schemaId?: SchemaId;
    readonly programId?: ProgramId;
    readonly from?: string;
    readonly to?: string;
    readonly exportedAt: string;
    readonly exportId: string;
  };
  readonly deIdentificationLog: readonly string[];
}

export interface TrendBucket {
  readonly bucket: string;
  readonly count: number;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
}

export interface AnalyticsResult {
  readonly populationStat?: PopulationStat;
  readonly longitudinal?: LongitudinalAnalysis;
  readonly program?: ProgramAnalytics;
  readonly cohort?: CohortResult;
  readonly trend?: readonly TrendBucket[];
  readonly privacyAggregate?: PrivacyPreservingAggregate;
  readonly researchExport?: ResearchExport;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ANALYTICS_EVENTS = {
  researchExported: "eks.health.analytics.research_exported",
  privacyAggregateComputed: "eks.health.analytics.privacy_aggregate_computed",
} as const;

// ---------------------------------------------------------------------------
// Numeric extraction
// ---------------------------------------------------------------------------

function toNumeric(v: MeasurementValue | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.value === "number") return obj.value;
    if (typeof obj.systolic === "number") return obj.systolic;
    if (typeof obj.value === "string") {
      const n = Number(obj.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statistics (Welford's algorithm for stddev, nearest-rank for percentiles)
// ---------------------------------------------------------------------------

interface RunningStats {
  count: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
  sum: number;
}

function newRunningStats(): RunningStats {
  return { count: 0, mean: 0, m2: 0, min: Infinity, max: -Infinity, sum: 0 };
}

/** Welford's online algorithm for numerically stable variance. */
function updateStats(stats: RunningStats, x: number): void {
  stats.count += 1;
  const delta = x - stats.mean;
  stats.mean += delta / stats.count;
  const delta2 = x - stats.mean;
  stats.m2 += delta * delta2;
  if (x < stats.min) stats.min = x;
  if (x > stats.max) stats.max = x;
  stats.sum += x;
}

function statsVariance(stats: RunningStats): number {
  if (stats.count < 1) return 0;
  return stats.m2 / stats.count; // population variance
}

/**
 * Nearest-rank percentile: sort ascending, then take the value at index
 * ceil(p/100 * n) - 1 (1-indexed rank). Falls back to the last value when
 * the rank exceeds the array length.
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx];
}

function median(sortedAsc: readonly number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sortedAsc[Math.floor(n / 2)];
  return (sortedAsc[n / 2 - 1] + sortedAsc[n / 2]) / 2;
}

// ---------------------------------------------------------------------------
// Linear regression (slope, intercept, r²)
// ---------------------------------------------------------------------------

interface RegressionResult {
  readonly slope: number;
  readonly intercept: number;
  readonly r2: number;
}

/**
 * Ordinary least squares linear regression of y on x.
 * Returns slope=0, intercept=mean(y), r2=0 when fewer than 2 points.
 */
function linearRegression(xs: readonly number[], ys: readonly number[]): RegressionResult {
  const n = xs.length;
  if (n < 2 || n !== ys.length) {
    const yMean = n === 1 ? ys[0] : 0;
    return { slope: 0, intercept: yMean, r2: 0 };
  }
  let xMean = 0;
  let yMean = 0;
  for (let i = 0; i < n; i++) {
    xMean += xs[i];
    yMean += ys[i];
  }
  xMean /= n;
  yMean /= n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const slope = denX === 0 ? 0 : num / denX;
  const intercept = yMean - slope * xMean;
  const r2 = denX === 0 || denY === 0 ? 0 : (num * num) / (denX * denY);
  return { slope, intercept, r2 };
}

// ---------------------------------------------------------------------------
// Laplace noise (inverse-CDF method)
// ---------------------------------------------------------------------------

/**
 * Generate Laplace(0, b) noise using the inverse CDF method.
 *
 * If U ~ Uniform(-0.5, 0.5), then X = -b * sgn(U) * ln(1 - 2|U|) ~ Laplace(0, b).
 *
 * This is the standard differential-privacy noise distribution. The scale b
 * is derived from the sensitivity of the query and the privacy budget epsilon:
 * b = sensitivity / epsilon.
 */
function laplaceNoise(scale: number): number {
  if (scale <= 0) return 0;
  // Math.random() ∈ [0, 1). Shift to [-0.5, 0.5).
  const u = Math.random() - 0.5;
  // Guard against u = ±0.5 (which would give ln(0) = -∞).
  const absU = Math.min(Math.abs(u), 0.4999);
  return -scale * Math.sign(u) * Math.log(1 - 2 * absU);
}

// ---------------------------------------------------------------------------
// Date bucketing (shared with search)
// ---------------------------------------------------------------------------

function dateBucket(ts: string, granularity: "day" | "week" | "month"): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (granularity === "day") return `${y}-${m}-${day}`;
  if (granularity === "month") return `${y}-${m}`;
  // ISO-8601 week
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((tmp.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function timestampOf(m: Measurement): string {
  return m.provenance?.collectedAt ?? m.timestamp ?? m.createdAt ?? getClock().iso();
}

// ---------------------------------------------------------------------------
// Analytics Engine
// ---------------------------------------------------------------------------

export class AnalyticsEngine {
  // -------------------------------------------------------------------------
  // Population statistics
  // -------------------------------------------------------------------------

  /**
   * Compute population statistics across all measurements of a schema:
   * count, mean, median, stddev (Welford), min, max, percentiles (p5/p25/p50/p75/p95).
   */
  async populationStat(
    schemaId: SchemaId,
    filter?: { from?: string; to?: string; profileId?: ProfileId },
  ): Promise<PopulationStat> {
    const measurements = await this.fetchMeasurements({
      schemaId,
      profileId: filter?.profileId,
      from: filter?.from,
      to: filter?.to,
    });

    const stats = newRunningStats();
    const numericValues: number[] = [];

    for (const m of measurements) {
      const n = toNumeric(m.value);
      if (n === null) continue;
      updateStats(stats, n);
      numericValues.push(n);
    }

    numericValues.sort((a, b) => a - b);

    const variance = statsVariance(stats);
    const stddev = Math.sqrt(variance);

    return {
      schemaId,
      count: measurements.length,
      numericCount: numericValues.length,
      mean: stats.mean,
      median: median(numericValues),
      stddev,
      min: numericValues.length > 0 ? stats.min : 0,
      max: numericValues.length > 0 ? stats.max : 0,
      sum: stats.sum,
      percentiles: {
        p5: percentile(numericValues, 5),
        p25: percentile(numericValues, 25),
        p50: percentile(numericValues, 50),
        p75: percentile(numericValues, 75),
        p95: percentile(numericValues, 95),
      },
      computedAt: getClock().iso(),
    };
  }

  // -------------------------------------------------------------------------
  // Longitudinal analysis (per-participant time series)
  // -------------------------------------------------------------------------

  /**
   * Track a participant's measurements over time. Computes a real linear
   * regression (slope, intercept, r² coefficient of determination) and a
   * linear forecast projecting the next 3 intervals.
   */
  async longitudinalAnalysis(
    profileId: ProfileId,
    schemaId: SchemaId,
    from?: string,
    to?: string,
  ): Promise<LongitudinalAnalysis> {
    const measurements = await this.fetchMeasurements({
      schemaId,
      profileId,
      from,
      to,
    });

    // Build (x=timestamp epoch ms, y=value) pairs sorted by time.
    const points = measurements
      .map((m) => {
        const y = toNumeric(m.value);
        if (y === null) return null;
        const t = timestampOf(m);
        const x = new Date(t).getTime();
        if (Number.isNaN(x)) return null;
        return { x, y, t };
      })
      .filter((p): p is { x: number; y: number; t: string } => p !== null)
      .sort((a, b) => a.x - b.x);

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const reg = linearRegression(xs, ys);

    // Forecast: project the next 3 points at evenly-spaced intervals.
    const forecast: { at: string; value: number }[] = [];
    if (points.length >= 2) {
      const interval = (points[points.length - 1].x - points[0].x) / (points.length - 1);
      const lastX = points[points.length - 1].x;
      for (let i = 1; i <= 3; i++) {
        const futureX = lastX + interval * i;
        const futureY = reg.intercept + reg.slope * futureX;
        forecast.push({ at: new Date(futureX).toISOString(), value: futureY });
      }
    }

    const firstValue = points.length > 0 ? points[0].y : null;
    const lastValue = points.length > 0 ? points[points.length - 1].y : null;
    const changePercent =
      firstValue !== null && lastValue !== null && firstValue !== 0
        ? ((lastValue - firstValue) / Math.abs(firstValue)) * 100
        : 0;

    return {
      profileId,
      schemaId,
      from: from ?? (points.length > 0 ? points[0].t : getClock().iso()),
      to: to ?? (points.length > 0 ? points[points.length - 1].t : getClock().iso()),
      points: points.length,
      slope: reg.slope,
      intercept: reg.intercept,
      r2: reg.r2,
      forecast,
      firstValue,
      lastValue,
      changePercent,
      computedAt: getClock().iso(),
    };
  }

  // -------------------------------------------------------------------------
  // Program analytics
  // -------------------------------------------------------------------------

  /**
   * Aggregate analytics for a program: total participants, total measurements,
   * active schemas, average measurements per participant, verification rate.
   */
  async programAnalytics(programId: ProgramId): Promise<ProgramAnalytics> {
    // Fetch all measurements — we filter by programId in-memory because the
    // measurements module's filter doesn't expose programId directly (it lives
    // on provenance). This is a real aggregation over real data.
    const allMeasurements = await this.fetchMeasurements({});
    const programMeasurements = allMeasurements.filter(
      (m) => m.provenance?.programId === programId,
    );

    const participants = new Set<string>();
    const schemas = new Set<string>();
    let verified = 0;

    for (const m of programMeasurements) {
      participants.add(m.profileId as string);
      schemas.add(m.schemaId as string);
      if (m.verificationState === "verified") verified += 1;
    }

    const totalMeasurements = programMeasurements.length;
    const totalParticipants = participants.size;
    const verificationRate =
      totalMeasurements > 0 ? verified / totalMeasurements : 0;

    return {
      programId,
      totalParticipants,
      totalMeasurements,
      activeSchemas: schemas.size,
      avgMeasurementsPerParticipant:
        totalParticipants > 0 ? totalMeasurements / totalParticipants : 0,
      verificationRate,
      computedAt: getClock().iso(),
    };
  }

  // -------------------------------------------------------------------------
  // Cohort analysis
  // -------------------------------------------------------------------------

  /**
   * Define a cohort by demographics, program membership, or schema presence
   * and compute aggregate statistics for each schema present in the cohort.
   */
  async cohortAnalysis(cohort: CohortDefinition): Promise<CohortResult> {
    // Step 1: resolve the cohort's profile set.
    const cohortProfiles = new Set<string>();

    // By program: fetch all measurements for the program, collect profileIds.
    if (cohort.programId) {
      const allMeasurements = await this.fetchMeasurements({});
      for (const m of allMeasurements) {
        if (m.provenance?.programId === cohort.programId) {
          cohortProfiles.add(m.profileId as string);
        }
      }
    }

    // By schema presence: fetch measurements of the schema, collect profileIds.
    if (cohort.schemaPresence && cohort.schemaPresence.length > 0) {
      for (const schemaId of cohort.schemaPresence) {
        const ms = await this.fetchMeasurements({ schemaId });
        for (const m of ms) {
          cohortProfiles.add(m.profileId as string);
        }
      }
    }

    // By demographics: intersect with profiles from the profiles module.
    if (cohort.demographics) {
      const matchingProfiles = await this.fetchProfilesByDemographics(cohort.demographics);
      if (cohortProfiles.size === 0 && (cohort.programId || cohort.schemaPresence)) {
        // Intersect with demographic matches.
        const intersection = new Set<string>();
        for (const id of cohortProfiles) {
          if (matchingProfiles.has(id)) intersection.add(id);
        }
        cohortProfiles.clear();
        for (const id of intersection) cohortProfiles.add(id);
      } else {
        // No prior filter — use demographics as the cohort.
        for (const id of matchingProfiles) cohortProfiles.add(id);
      }
    }

    // Step 2: collect all measurements for the cohort.
    const cohortMeasurements: Measurement[] = [];
    for (const profileId of cohortProfiles) {
      const ms = await this.fetchMeasurements({
        profileId: profileId as ProfileId,
      });
      cohortMeasurements.push(...ms);
    }

    // Step 3: compute per-schema population stats.
    const bySchema = new Map<string, Measurement[]>();
    for (const m of cohortMeasurements) {
      const key = m.schemaId as string;
      let bucket = bySchema.get(key);
      if (!bucket) {
        bucket = [];
        bySchema.set(key, bucket);
      }
      bucket.push(m);
    }

    const stats: PopulationStat[] = [];
    for (const [schemaIdStr, measurements] of bySchema) {
      const stat = this.computePopulationStat(schemaIdStr as SchemaId, measurements);
      stats.push(stat);
    }

    return {
      name: cohort.name,
      size: cohortProfiles.size,
      stats,
      computedAt: getClock().iso(),
    };
  }

  // -------------------------------------------------------------------------
  // Privacy-preserving aggregation
  // -------------------------------------------------------------------------

  /**
   * Apply a privacy-preserving aggregation method to a set of measurements.
   *
   * Methods:
   *  - k_anonymity: suppress groups with fewer than k records (k default 5).
   *  - noise_injection: add Laplace noise to each aggregate (scale = sensitivity/epsilon).
   *  - aggregation_only: report only aggregates, never individual records.
   *
   * Groups are formed by quasi-identifiers (schemaId + sourceType + verificationState).
   */
  privacyPreservingAggregate(
    measurements: readonly Measurement[],
    method: PrivacyMethod,
    params?: { k?: number; epsilon?: number; sensitivity?: number },
  ): PrivacyPreservingAggregate {
    // Group by quasi-identifiers: schemaId, sourceType, verificationState.
    const groups = new Map<string, Measurement[]>();
    for (const m of measurements) {
      const key = `${m.schemaId as string}|${this.sourceTypeOf(m) ?? "unknown"}|${m.verificationState}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(m);
    }

    let suppressed = 0;
    const out: PrivacyPreservingAggregate["groups"][number][] = [];
    const k = params?.k ?? 5;
    const epsilon = params?.epsilon ?? 1.0;
    const sensitivity = params?.sensitivity ?? 1.0;
    const noiseScale = sensitivity / epsilon;

    for (const [key, group] of groups) {
      if (method === "k_anonymity" && group.length < k) {
        suppressed += group.length;
        continue;
      }

      const numericValues = group
        .map((m) => toNumeric(m.value))
        .filter((n): n is number => n !== null);

      if (numericValues.length === 0) {
        out.push({ key, count: group.length });
        continue;
      }

      const sum = numericValues.reduce((a, b) => a + b, 0);
      const mean = sum / numericValues.length;
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);

      if (method === "noise_injection") {
        // Add Laplace noise to mean, min, max, sum. Count is exact (it's not
        // a sensitive aggregate in most DP frameworks, but we could noise it
        // too for stricter DP; here we keep it exact for utility).
        out.push({
          key,
          count: group.length,
          mean: mean + laplaceNoise(noiseScale),
          min: min + laplaceNoise(noiseScale),
          max: max + laplaceNoise(noiseScale),
          sum: sum + laplaceNoise(noiseScale * numericValues.length),
        });
      } else {
        // k_anonymity (group passed the threshold) or aggregation_only.
        out.push({ key, count: group.length, mean, min, max, sum });
      }
    }

    const parameters: Record<string, unknown> =
      method === "k_anonymity"
        ? { k }
        : method === "noise_injection"
          ? { epsilon, sensitivity, noiseScale }
          : {};

    void getEventBus().publish(
      buildEvent(
        ANALYTICS_EVENTS.privacyAggregateComputed,
        { method, groups: out.length, suppressed, parameters },
        {},
        "domain",
      ),
    );

    return { method, groups: out, suppressed, parameters };
  }

  // -------------------------------------------------------------------------
  // Research export (de-identified)
  // -------------------------------------------------------------------------

  /**
   * Generate a de-identified research dataset. Removes profileId, accountId,
   * location, and any direct identifiers. Keeps schemaId, value, unit,
   * ageRange, biologicalSex, timestamp, verificationState, sourceType.
   *
   * Returns the dataset + metadata + a de-identification audit log.
   */
  async researchExport(
    filter: {
      schemaId?: SchemaId;
      programId?: ProgramId;
      from?: string;
      to?: string;
    },
    format?: "json" | "csv",
  ): Promise<ResearchExport> {
    const measurements = await this.fetchMeasurements({
      schemaId: filter.schemaId,
      from: filter.from,
      to: filter.to,
    });

    // Filter by programId in-memory (it's on provenance).
    const filtered = filter.programId
      ? measurements.filter((m) => m.provenance?.programId === filter.programId)
      : measurements;

    // Build a profile lookup for ageRange/biologicalSex.
    const profileCache = new Map<string, { ageRange?: string; biologicalSex?: string }>();
    const deIdentificationLog: string[] = [
      `Export started at ${getClock().iso()}`,
      `Source measurements: ${filtered.length}`,
      "Removed fields: profileId, accountId, provenance.collectedBy, provenance.location, provenance.consentReference, provenance.auditReference, provenance.deviceId",
      "Retained fields: schemaId, value, unit, ageRange, biologicalSex, timestamp, verificationState, sourceType",
    ];

    const data: DeIdentifiedRecord[] = [];
    for (const m of filtered) {
      const profileIdStr = m.profileId as string;
      let profile = profileCache.get(profileIdStr);
      if (!profile) {
        profile = await this.fetchProfileDemographics(m.profileId);
        profileCache.set(profileIdStr, profile);
      }

      data.push({
        schemaId: m.schemaId,
        value: m.value,
        unit: this.unitSymbolOf(m),
        ageRange: profile.ageRange,
        biologicalSex: profile.biologicalSex,
        timestamp: timestampOf(m),
        verificationState: m.verificationState,
        sourceType: this.sourceTypeOf(m),
      });
    }

    deIdentificationLog.push(`De-identified records: ${data.length}`);
    if (filter.programId) deIdentificationLog.push(`Program filter: ${filter.programId as string}`);
    if (filter.schemaId) deIdentificationLog.push(`Schema filter: ${filter.schemaId as string}`);

    const exportId = generateId("rex_");
    const result: ResearchExport = {
      data,
      metadata: {
        count: data.length,
        schemaId: filter.schemaId,
        programId: filter.programId,
        from: filter.from,
        to: filter.to,
        exportedAt: getClock().iso(),
        exportId,
      },
      deIdentificationLog,
    };

    void getEventBus().publish(
      buildEvent(
        ANALYTICS_EVENTS.researchExported,
        { exportId, count: data.length, schemaId: filter.schemaId, programId: filter.programId },
        {},
        "domain",
      ),
    );

    void format; // format is a hint for the caller; the data is structured.
    return result;
  }

  // -------------------------------------------------------------------------
  // Trend analysis
  // -------------------------------------------------------------------------

  /**
   * Aggregate trend over time: daily/weekly/monthly buckets with avg/min/max/
   * count/sum per bucket. Real bucketing + aggregation.
   */
  async trendAnalysis(
    schemaId: SchemaId,
    groupBy: "day" | "week" | "month",
    filter?: { from?: string; to?: string; profileId?: ProfileId },
  ): Promise<readonly TrendBucket[]> {
    const measurements = await this.fetchMeasurements({
      schemaId,
      profileId: filter?.profileId,
      from: filter?.from,
      to: filter?.to,
    });

    const buckets = new Map<string, number[]>();
    for (const m of measurements) {
      const key = dateBucket(timestampOf(m), groupBy);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      const n = toNumeric(m.value);
      if (n !== null) bucket.push(n);
    }

    const result: TrendBucket[] = [];
    for (const [bucket, values] of buckets) {
      if (values.length === 0) continue;
      const sum = values.reduce((a, b) => a + b, 0);
      result.push({
        bucket,
        count: values.length,
        avg: sum / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        sum,
      });
    }

    result.sort((a, b) => a.bucket.localeCompare(b.bucket));
    return result;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private computePopulationStat(
    schemaId: SchemaId,
    measurements: readonly Measurement[],
  ): PopulationStat {
    const stats = newRunningStats();
    const numericValues: number[] = [];
    for (const m of measurements) {
      const n = toNumeric(m.value);
      if (n === null) continue;
      updateStats(stats, n);
      numericValues.push(n);
    }
    numericValues.sort((a, b) => a - b);
    return {
      schemaId,
      count: measurements.length,
      numericCount: numericValues.length,
      mean: stats.mean,
      median: median(numericValues),
      stddev: Math.sqrt(statsVariance(stats)),
      min: numericValues.length > 0 ? stats.min : 0,
      max: numericValues.length > 0 ? stats.max : 0,
      sum: stats.sum,
      percentiles: {
        p5: percentile(numericValues, 5),
        p25: percentile(numericValues, 25),
        p50: percentile(numericValues, 50),
        p75: percentile(numericValues, 75),
        p95: percentile(numericValues, 95),
      },
      computedAt: getClock().iso(),
    };
  }

  private async fetchMeasurements(
    filter: {
      schemaId?: SchemaId;
      profileId?: ProfileId;
      from?: string;
      to?: string;
    },
  ): Promise<readonly Measurement[]> {
    try {
      const measurementsModule = "../measurements";
      const mod: { getMeasurements(): { list(query: unknown): readonly unknown[] } } =
        await import(measurementsModule);
      const mgr = mod.getMeasurements();
      const query: MeasurementQuery = {
        schemaId: filter.schemaId,
        profileId: filter.profileId,
        dateRange: { from: filter.from, to: filter.to },
      };
      return mgr.list(query) as readonly Measurement[];
    } catch {
      return [];
    }
  }

  private async fetchProfilesByDemographics(demographics: {
    biologicalSex?: string;
    ageRange?: string;
    country?: string;
  }): Promise<Set<string>> {
    const result = new Set<string>();
    try {
      const profilesModulePath = "../profiles";
      const mod: { getProfiles(): unknown } = await import(profilesModulePath);
      const mgr = mod.getProfiles() as { list(): unknown };
      const raw = mgr.list();
      const profiles = Array.isArray(raw) ? raw : [];
      for (const p of profiles as Array<Record<string, unknown>>) {
        if (demographics.biologicalSex && p.biologicalSex !== demographics.biologicalSex) continue;
        if (demographics.ageRange && p.ageRange !== demographics.ageRange) continue;
        if (demographics.country && p.country !== demographics.country) continue;
        if (typeof p.id === "string") result.add(p.id);
      }
    } catch {
      // profiles module unavailable — empty cohort.
    }
    return result;
  }

  private async fetchProfileDemographics(
    profileId: ProfileId,
  ): Promise<{ ageRange?: string; biologicalSex?: string }> {
    try {
      const profilesModulePath = "../profiles";
      const mod: { getProfiles(): unknown } = await import(profilesModulePath);
      const mgr = mod.getProfiles() as {
        get?(id: unknown): unknown;
        list(): unknown;
      };
      const get = mgr.get;
      if (typeof get === "function") {
        const profile = get(profileId) as Record<string, unknown> | undefined;
        if (profile) {
          return {
            ageRange: typeof profile.ageRange === "string" ? profile.ageRange : undefined,
            biologicalSex: typeof profile.biologicalSex === "string" ? profile.biologicalSex : undefined,
          };
        }
      }
      // Fallback: scan the list.
      const raw = mgr.list();
      const profiles = Array.isArray(raw) ? raw : [];
      for (const p of profiles as Array<Record<string, unknown>>) {
        if (p.id === (profileId as string)) {
          return {
            ageRange: typeof p.ageRange === "string" ? p.ageRange : undefined,
            biologicalSex: typeof p.biologicalSex === "string" ? p.biologicalSex : undefined,
          };
        }
      }
    } catch {
      // profiles module unavailable.
    }
    return {};
  }

  private sourceTypeOf(m: Measurement): SourceType | undefined {
    if (m.sourceType) return m.sourceType as SourceType;
    if (m.sourceId) {
      try {
        void 0; // getSources imported at top level
        return getSources().get(m.sourceId)?.type;
      } catch {
        // sources registry unavailable.
      }
    }
    return undefined;
  }

  private unitSymbolOf(m: Measurement): string | undefined {
    if (!m.unitId) return undefined;
    try {
      void 0; // getUnits imported at top level
      return getUnits().get(m.unitId)?.symbol ?? (m.unitId as string);
    } catch {
      return m.unitId as string;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _analytics: AnalyticsEngine | null = null;

export function getAnalytics(): AnalyticsEngine {
  if (!_analytics) _analytics = new AnalyticsEngine();
  return _analytics;
}

export function setAnalytics(engine: AnalyticsEngine): void {
  _analytics = engine;
}

export function resetAnalytics(): void {
  _analytics = null;
}
