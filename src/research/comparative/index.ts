/**
 * Eks-Health Research Platform — Comparative Effectiveness Engine
 *
 * Compare Programs head-to-head: Weight Program A vs Weight Program B,
 * Traditional vs Clinical, Hybrid vs Exercise-only. Statistically
 * transparent — every study reports mean, standard deviation, Cohen's d
 * effect size, an approximated t-test p-value, sample sizes, and an
 * explicit list of limitations (small samples, uncontrolled confounders,
 * observational design, etc.).
 *
 * All data is gathered from REAL platform signals (the EvidenceEngine and
 * underlying measurements / missions). Cross-subsystem calls are guarded
 * so a missing subsystem degrades gracefully.
 */

import "server-only";
import {
  type ComparativeStudyId,
  type ComparativeStudy,
  type ProgramId,
  ResearchError,
  asComparativeStudyId,
} from "../core";
import { getPrivacy } from "../privacy";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { RESEARCH_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Defensive loaders
// ---------------------------------------------------------------------------

interface EvidenceAccumulationLike {
  readonly programId: ProgramId;
  readonly totalParticipants: number;
  readonly totalMeasurements: number;
  readonly averageImprovement: number;
  readonly medianImprovement: number;
  readonly completionRate: number;
  readonly retentionRate: number;
  readonly missionCompliance: number;
  readonly competitionParticipation: number;
  readonly measurementQuality: number;
  readonly technicianVerificationQuality: number;
  readonly longTermSustainability: number;
  readonly confidenceScore: number;
}

interface EvidenceApi {
  get(programId: ProgramId): EvidenceAccumulationLike | undefined;
  accumulate(programId: ProgramId): Promise<EvidenceAccumulationLike>;
}

interface HealthProfileLike {
  readonly id: string;
  readonly accountId: string;
  readonly programs: { programId: string; status: "active" | "paused" | "uninstalled" }[];
}

interface MeasurementLike {
  readonly id: string;
  readonly profileId: string;
  readonly schemaId: string;
  readonly value: number | { value?: number };
  readonly provenance: { collectedAt: string };
  readonly supersededBy?: string;
}

interface MeasurementsApi {
  list(filter?: { profileId?: string; includeSuperseded?: boolean }): MeasurementLike[];
}

interface MissionsApi {
  list(filter?: { participantId?: string; programId?: string }): {
    state: string;
    programId: string;
    participantId: string;
  }[];
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ComparativeMetric =
  | "average_improvement"
  | "median_improvement"
  | "completion_rate"
  | "retention_rate"
  | "mission_compliance"
  | "measurement_quality"
  | "confidence_score";

export interface ProgramStatistic {
  readonly programId: ProgramId;
  readonly values: number[];
  readonly mean: number;
  readonly stddev: number;
  readonly sampleSize: number;
}

export interface PairwiseStatistic {
  readonly programA: ProgramId;
  readonly programB: ProgramId;
  readonly meanA: number;
  readonly meanB: number;
  readonly meanDelta: number;
  readonly pooledStddev: number;
  readonly cohensD: number;
  readonly tStatistic: number;
  readonly pValue: number;
  readonly significant: boolean;
}

export interface ComparativeResults {
  readonly study: ComparativeStudy;
  readonly perProgram: ProgramStatistic[];
  readonly pairwise: PairwiseStatistic[];
}

export interface SignificantDifference {
  readonly programA: ProgramId;
  readonly programB: ProgramId;
  readonly metric: string;
  readonly pValue: number;
  readonly cohensD: number;
  readonly meanDelta: number;
}

export interface ComparativeListFilter {
  readonly metric?: string;
  readonly minPrograms?: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ComparativeEngine {
  private readonly studies = new Map<ComparativeStudyId, ComparativeStudy>();
  private readonly results = new Map<ComparativeStudyId, ComparativeResults>();

  async createStudy(
    name: string,
    programIds: ProgramId[],
    metric: ComparativeMetric,
  ): Promise<ComparativeStudy> {
    if (!name?.trim()) {
      throw new ResearchError({
        code: "eks.research.comparative.empty_name",
        category: "validation",
        message: "Study name is required.",
        userMessage: "Please provide a name for the study.",
      });
    }
    if (programIds.length < 2) {
      throw new ResearchError({
        code: "eks.research.comparative.min_programs",
        category: "validation",
        message: "A comparative study requires at least two programs.",
        userMessage: "Select at least two programs to compare.",
      });
    }

    const evidence = await loadEvidence();
    if (!evidence) {
      throw new ResearchError({
        code: "eks.research.comparative.evidence_unavailable",
        category: "not_authorized",
        message: "Evidence engine unavailable.",
        userMessage: "Comparative analysis is temporarily unavailable.",
      });
    }

    // Gather per-program statistics from real platform data.
    const perProgram: ProgramStatistic[] = [];
    for (const pid of programIds) {
      const stats = await this.gatherProgramStatistic(pid, metric, evidence);
      perProgram.push(stats);
    }

    // Compute pairwise statistics across all program pairs.
    const pairwise: PairwiseStatistic[] = [];
    for (let i = 0; i < perProgram.length; i++) {
      for (let j = i + 1; j < perProgram.length; j++) {
        pairwise.push(this.computePairwise(perProgram[i], perProgram[j]));
      }
    }

    // Headline significance = smallest p-value; headline effect = max |Cohen's d|.
    const minPValue = pairwise.length > 0 ? Math.min(...pairwise.map((p) => p.pValue)) : 1;
    const maxEffect = pairwise.length > 0
      ? Math.max(...pairwise.map((p) => Math.abs(p.cohensD)))
      : 0;

    const limitations = this.computeLimitations(perProgram, programIds.length, metric);

    const results: ComparativeStudy["results"] = perProgram.map((s) => ({
      programId: s.programId,
      value: round4(s.mean),
      confidence: round4(clamp01(1 - minPValue)),
      sampleSize: s.sampleSize,
    }));

    const now = getClock().iso();
    const study: ComparativeStudy = {
      id: asComparativeStudyId(generateId("cmp_")),
      name: name.trim(),
      programIds: [...programIds],
      metric,
      results,
      statisticalMethod: "Welch's two-sample t-test (normal approximation) with Cohen's d effect size",
      significance: round4(minPValue),
      effectSize: round4(maxEffect),
      limitations,
      computedAt: now,
    };

    this.studies.set(study.id, study);
    this.results.set(study.id, { study, perProgram, pairwise });

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.comparativeStudyCompleted,
        {
          studyId: study.id,
          name: study.name,
          programIds: study.programIds,
          metric,
          significance: study.significance,
          effectSize: study.effectSize,
          programCount: study.programIds.length,
        },
        {},
        "domain",
      ),
    );
    return study;
  }

  get(id: ComparativeStudyId): ComparativeStudy | undefined {
    return this.studies.get(id);
  }

  list(filter?: ComparativeListFilter): ComparativeStudy[] {
    let list = [...this.studies.values()];
    if (filter?.metric) list = list.filter((s) => s.metric === filter.metric);
    if (filter?.minPrograms) list = list.filter((s) => s.programIds.length >= filter.minPrograms!);
    return list.sort((a, b) => b.computedAt.localeCompare(a.computedAt));
  }

  getResults(id: ComparativeStudyId): ComparativeResults | undefined {
    const study = this.studies.get(id);
    if (!study) return undefined;
    return this.results.get(id) ?? { study, perProgram: [], pairwise: [] };
  }

  async comparePair(
    programIdA: ProgramId,
    programIdB: ProgramId,
    metric: ComparativeMetric,
  ): Promise<ComparativeResults> {
    const study = await this.createStudy(
      `Pairwise: ${programIdA} vs ${programIdB}`,
      [programIdA, programIdB],
      metric,
    );
    return this.getResults(study.id)!;
  }

  async getSignificantDifferences(
    metric: ComparativeMetric,
    threshold = 0.05,
  ): Promise<SignificantDifference[]> {
    const evidence = await loadEvidence();
    if (!evidence) return [];
    // Gather all program IDs from the evidence engine's per-program data.
    const profiles = await loadProfiles();
    const programSet = new Set<ProgramId>();
    if (profiles) {
      try {
        for (const p of profiles.list()) {
          for (const pp of p.programs) {
            if (pp.status === "active") programSet.add(pp.programId as ProgramId);
          }
        }
      } catch {
        /* skip */
      }
    }
    if (programSet.size < 2) return [];

    const programIds = [...programSet];
    const perProgram: ProgramStatistic[] = [];
    for (const pid of programIds) {
      try {
        perProgram.push(await this.gatherProgramStatistic(pid, metric, evidence));
      } catch {
        /* skip */
      }
    }

    // Privacy suppression — don't report pairs if the total population is
    // too small to be privacy-safe.
    const privacy = getPrivacy();
    if (privacy.validateQueryResult({ count: perProgram.reduce((a, s) => a + s.sampleSize, 0) }).safe === false) {
      return [];
    }

    const results: SignificantDifference[] = [];
    for (let i = 0; i < perProgram.length; i++) {
      for (let j = i + 1; j < perProgram.length; j++) {
        const pair = this.computePairwise(perProgram[i], perProgram[j]);
        if (pair.significant && pair.pValue < threshold) {
          results.push({
            programA: pair.programA,
            programB: pair.programB,
            metric,
            pValue: round4(pair.pValue),
            cohensD: round4(pair.cohensD),
            meanDelta: round4(pair.meanDelta),
          });
        }
      }
    }
    return results.sort((a, b) => a.pValue - b.pValue);
  }

  getStats(): {
    total: number;
    avgProgramsCompared: number;
    avgSignificance: number;
    avgEffectSize: number;
    significantCount: number;
  } {
    const list = [...this.studies.values()];
    let programSum = 0;
    let sigSum = 0;
    let effectSum = 0;
    let significant = 0;
    for (const s of list) {
      programSum += s.programIds.length;
      sigSum += s.significance;
      effectSum += s.effectSize;
      if (s.significance < 0.05) significant++;
    }
    return {
      total: list.length,
      avgProgramsCompared: list.length > 0 ? programSum / list.length : 0,
      avgSignificance: list.length > 0 ? sigSum / list.length : 0,
      avgEffectSize: list.length > 0 ? effectSum / list.length : 0,
      significantCount: significant,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: real per-program statistics
  // -------------------------------------------------------------------------

  private async gatherProgramStatistic(
    programId: ProgramId,
    metric: ComparativeMetric,
    evidence: EvidenceApi,
  ): Promise<ProgramStatistic> {
    // Per-participant values give us a real distribution for t-test /
    // Cohen's d. We support a subset of metrics with per-participant data;
    // for the rest, we fall back to the program-level accumulation.
    let values: number[] = [];
    if (metric === "average_improvement") {
      values = await this.gatherPerParticipantImprovement(programId);
    } else if (metric === "completion_rate") {
      values = await this.gatherPerParticipantCompletion(programId);
    }
    if (values.length === 0) {
      // Fall back to a single-value distribution from the accumulation.
      let acc: EvidenceAccumulationLike | undefined;
      try {
        acc = evidence.get(programId) ?? await evidence.accumulate(programId);
      } catch {
        acc = evidence.get(programId);
      }
      const v = acc ? accumulationMetric(acc, metric) : 0;
      values = Number.isFinite(v) ? [v] : [];
    }
    const mean = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    const variance = values.length > 1
      ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)
      : 0;
    const stddev = Math.sqrt(variance);
    return {
      programId,
      values,
      mean: round4(mean),
      stddev: round4(stddev),
      sampleSize: values.length,
    };
  }

  private async gatherPerParticipantImprovement(programId: ProgramId): Promise<number[]> {
    const profiles = await loadProfiles();
    const measurements = await loadMeasurements();
    if (!profiles || !measurements) return [];
    let profileList: HealthProfileLike[] = [];
    try {
      profileList = profiles.list().filter((p) => p.programs.some((pp) => pp.programId === programId));
    } catch {
      return [];
    }
    const results: number[] = [];
    for (const profile of profileList) {
      try {
        const list = measurements.list({ profileId: profile.id, includeSuperseded: false }) ?? [];
        const bySchema = new Map<string, MeasurementLike[]>();
        for (const m of list) {
          const arr = bySchema.get(m.schemaId) ?? [];
          arr.push(m);
          bySchema.set(m.schemaId, arr);
        }
        const percents: number[] = [];
        for (const [, arr] of bySchema) {
          if (arr.length < 2) continue;
          const sorted = [...arr].sort((a, b) => a.provenance.collectedAt.localeCompare(b.provenance.collectedAt));
          const first = measurementValue(sorted[0]);
          const last = measurementValue(sorted[sorted.length - 1]);
          if (first === 0 || !Number.isFinite(first) || !Number.isFinite(last)) continue;
          percents.push(((last - first) / Math.abs(first)) * 100);
        }
        if (percents.length > 0) {
          results.push(percents.reduce((a, b) => a + b, 0) / percents.length);
        }
      } catch {
        /* skip profile */
      }
    }
    return results;
  }

  private async gatherPerParticipantCompletion(programId: ProgramId): Promise<number[]> {
    const profiles = await loadProfiles();
    const missions = await loadMissions();
    if (!profiles || !missions) return [];
    let profileList: HealthProfileLike[] = [];
    try {
      profileList = profiles.list().filter((p) => p.programs.some((pp) => pp.programId === programId));
    } catch {
      return [];
    }
    const results: number[] = [];
    for (const profile of profileList) {
      try {
        const list = missions.list({ participantId: profile.accountId }) ?? [];
        const attempted = list.filter((m) => m.state === "completed" || m.state === "skipped" || m.state === "expired" || m.state === "cancelled");
        const completed = list.filter((m) => m.state === "completed");
        if (attempted.length > 0) {
          results.push(completed.length / attempted.length);
        }
      } catch {
        /* skip */
      }
    }
    return results;
  }

  private computePairwise(a: ProgramStatistic, b: ProgramStatistic): PairwiseStatistic {
    const meanDelta = a.mean - b.mean;
    // Pooled stddev (Welch-style: we don't assume equal variances, but for
    // Cohen's d the pooled estimate is standard).
    const nA = a.sampleSize;
    const nB = b.sampleSize;
    const denom = Math.max(1, nA + nB - 2);
    const pooledStddev = Math.sqrt(
      ((nA > 1 ? nA - 1 : 0) * a.stddev ** 2 + (nB > 1 ? nB - 1 : 0) * b.stddev ** 2) / denom,
    );
    const cohensD = pooledStddev > 0 ? meanDelta / pooledStddev : 0;
    // Welch's t-statistic
    const se = Math.sqrt(
      (nA > 1 ? a.stddev ** 2 / nA : 0) + (nB > 1 ? b.stddev ** 2 / nB : 0),
    );
    const t = se > 0 ? meanDelta / se : 0;
    // Approximate p-value via the normal CDF (large-sample approximation).
    const pValue = 2 * (1 - normalCdf(Math.abs(t)));
    return {
      programA: a.programId,
      programB: b.programId,
      meanA: a.mean,
      meanB: b.mean,
      meanDelta: round4(meanDelta),
      pooledStddev: round4(pooledStddev),
      cohensD: round4(cohensD),
      tStatistic: round4(t),
      pValue: round4(clamp01(pValue)),
      significant: pValue < 0.05,
    };
  }

  private computeLimitations(
    perProgram: ProgramStatistic[],
    programCount: number,
    metric: ComparativeMetric,
  ): string[] {
    const limitations: string[] = [];
    const minSample = Math.min(...perProgram.map((s) => s.sampleSize));
    if (minSample < 30) {
      limitations.push(`Small sample size: smallest group has ${minSample} participant(s); statistical power is limited.`);
    }
    if (programCount === 2) {
      limitations.push("Only two programs compared; results are not generalizable to the broader program population.");
    }
    if (perProgram.some((s) => s.sampleSize < 10)) {
      limitations.push("At least one program has fewer than 10 participants; per-group estimates are unstable.");
    }
    limitations.push("Observational design: participants self-select into programs; no randomization or confounder control.");
    limitations.push(`Metric '${metric}' is a single outcome dimension; multi-outcome evaluation is recommended for robust conclusions.`);
    limitations.push("P-values are approximated from a normal CDF; for small samples, exact t-distribution p-values would be more accurate.");
    limitations.push("Confounders (baseline severity, demographics, adherence, co-interventions) are not controlled.");
    return limitations;
  }
}

// ---------------------------------------------------------------------------
// Math helpers — real normal CDF (Abramowitz & Stegun 26.2.17 approximation)
// ---------------------------------------------------------------------------

function normalCdf(x: number): number {
  // Cumulative distribution function for the standard normal distribution.
  // Returns P(Z <= x). For |x| > ~8 the result is effectively 0 or 1.
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  // erf approximation
  const t = 1 / (1 + 0.3275911 * absX);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absX * absX);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

function accumulationMetric(a: EvidenceAccumulationLike, metric: ComparativeMetric): number {
  switch (metric) {
    case "average_improvement": return a.averageImprovement;
    case "median_improvement": return a.medianImprovement;
    case "completion_rate": return a.completionRate;
    case "retention_rate": return a.retentionRate;
    case "mission_compliance": return a.missionCompliance;
    case "measurement_quality": return a.measurementQuality;
    case "confidence_score": return a.confidenceScore;
  }
}

function measurementValue(m: MeasurementLike): number {
  if (typeof m.value === "number") return m.value;
  if (m.value && typeof m.value === "object" && typeof m.value.value === "number") return m.value.value;
  return NaN;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function round4(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: ComparativeEngine | null = null;
export function getComparative(): ComparativeEngine {
  if (!_engine) _engine = new ComparativeEngine();
  return _engine;
}

export { RESEARCH_EVENTS, getPrivacy };
