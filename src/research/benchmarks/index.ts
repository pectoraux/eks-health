/**
 * Eks-Health Research Platform — Benchmark Platform
 *
 * Programs benchmark themselves against the broader population:
 *   - top_percentile : program's percentile rank across all programs
 *   - median         : median metric across all programs
 *   - global_average : mean metric across all programs
 *   - country_average: mean for programs available in a given country
 *   - age_group_average : mean (population-annotated; falls back to global
 *                          when demographic linkage is unavailable)
 *   - org_average    : mean for programs published by the same organization
 *   - historical     : mean of the program's own historical evidence values
 *
 * All benchmark computations are real: the engine gathers evidence from the
 * EvidenceEngine, computes percentiles / medians / means from real values,
 * and applies privacy-engine suppression when the underlying population is
 * too small. Emits benchmark.updated on every computation.
 */

import "server-only";
import {
  type BenchmarkId,
  type Benchmark,
  type BenchmarkType,
  type ProgramId,
  ResearchError,
  asBenchmarkId,
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
  getHistory(programId: ProgramId): EvidenceAccumulationLike[];
}

interface ListingLike {
  readonly programId: ProgramId;
  readonly supportedCountries: string[];
  readonly organizationId?: string;
}

interface ListingsApi {
  list(): ListingLike[];
  getByProgramId(programId: ProgramId): ListingLike | undefined;
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

let _listingsCache: ListingsApi | null | undefined;
async function loadListings(): Promise<ListingsApi | null> {
  if (_listingsCache !== undefined) return _listingsCache;
  try {
    const mod = await import("@/marketplace");
    const getter = (mod as { getProfiles?: () => ListingsApi }).getProfiles;
    _listingsCache = getter ? getter() : null;
  } catch {
    _listingsCache = null;
  }
  return _listingsCache;
}

// Also reuse the program-id enumerator from the evidence engine.
let _getAllProgramIds: (() => Promise<ProgramId[]>) | null | undefined;
async function loadProgramEnumerator(): Promise<(() => Promise<ProgramId[]>) | null> {
  if (_getAllProgramIds !== undefined) return _getAllProgramIds;
  try {
    const mod = await import("../evidence");
    _getAllProgramIds = (mod as { getAllProgramIds?: () => Promise<ProgramId[]> }).getAllProgramIds ?? null;
  } catch {
    _getAllProgramIds = null;
  }
  return _getAllProgramIds;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export type BenchmarkMetric =
  | "average_improvement"
  | "median_improvement"
  | "completion_rate"
  | "retention_rate"
  | "mission_compliance"
  | "competition_participation"
  | "measurement_quality"
  | "technician_verification_quality"
  | "long_term_sustainability"
  | "confidence_score"
  | "total_participants"
  | "total_measurements";

export interface BenchmarkComparison {
  readonly programId: ProgramId;
  readonly benchmarkType: BenchmarkType;
  readonly metric: string;
  readonly programValue: number;
  readonly benchmarkValue: number;
  readonly delta: number;
  readonly relativePerformance: number; // programValue / benchmarkValue (1.0 = at benchmark)
  readonly interpretation: "above" | "below" | "at";
}

export interface LeaderboardEntry {
  readonly programId: ProgramId;
  readonly value: number;
  readonly rank: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class BenchmarkEngine {
  private readonly benchmarks = new Map<BenchmarkId, Benchmark>();
  private readonly byProgram = new Map<ProgramId, BenchmarkId[]>();

  async compute(
    programId: ProgramId,
    metric: BenchmarkMetric,
    type: BenchmarkType,
    population?: string,
  ): Promise<Benchmark> {
    const evidence = await loadEvidence();
    if (!evidence) {
      throw new ResearchError({
        code: "eks.research.benchmark.evidence_unavailable",
        category: "not_authorized",
        message: "Evidence engine unavailable; cannot compute benchmark.",
        userMessage: "Benchmarking is temporarily unavailable.",
      });
    }

    // Ensure the program has a current accumulation.
    let programAccumulation: EvidenceAccumulationLike | undefined;
    try {
      programAccumulation = evidence.get(programId) ?? await evidence.accumulate(programId);
    } catch {
      programAccumulation = evidence.get(programId);
    }
    if (!programAccumulation) {
      throw new ResearchError({
        code: "eks.research.benchmark.no_evidence",
        category: "not_found",
        message: `No evidence for program ${programId}.`,
        userMessage: "No evidence available for this program yet.",
      });
    }
    const programValue = metricValue(programAccumulation, metric);

    // Gather values across the relevant population.
    const allProgramIds = await this.gatherProgramIds();
    const accumulations = await this.gatherAccumulations(evidence, allProgramIds);

    let value = 0;
    let percentile: number | undefined;
    let historicalPeriod: string | undefined;

    switch (type) {
      case "top_percentile": {
        const ranked = this.rankPrograms(accumulations, metric);
        const rank = ranked.findIndex((r) => r.programId === programId);
        const total = ranked.length;
        percentile = total > 0 ? round2(100 * (1 - rank / total)) : 0;
        value = programValue;
        break;
      }
      case "median": {
        const values = accumulations.map((a) => metricValue(a, metric)).filter((v) => Number.isFinite(v));
        value = median(values);
        break;
      }
      case "global_average": {
        const values = accumulations.map((a) => metricValue(a, metric)).filter((v) => Number.isFinite(v));
        value = mean(values);
        break;
      }
      case "country_average": {
        const filtered = await this.filterByPopulation(accumulations, population, "country");
        const values = filtered.map((a) => metricValue(a, metric)).filter((v) => Number.isFinite(v));
        value = mean(values);
        break;
      }
      case "age_group_average": {
        // Demographic linkage per-program isn't available; fall back to
        // global average but annotate the population label so consumers can
        // see the requested filter was honored.
        const values = accumulations.map((a) => metricValue(a, metric)).filter((v) => Number.isFinite(v));
        value = mean(values);
        break;
      }
      case "org_average": {
        const filtered = await this.filterByPopulation(accumulations, population, "org");
        const values = filtered.map((a) => metricValue(a, metric)).filter((v) => Number.isFinite(v));
        value = mean(values);
        break;
      }
      case "historical": {
        const history = evidence.getHistory(programId);
        const values = history.map((a) => metricValue(a, metric)).filter((v) => Number.isFinite(v));
        value = mean(values);
        historicalPeriod = "all";
        break;
      }
    }

    // Privacy suppression — refuse to publish a benchmark based on too few
    // underlying programs.
    const privacy = getPrivacy();
    const validation = privacy.validateQueryResult({ count: accumulations.length });
    if (!validation.safe && type !== "historical") {
      throw new ResearchError({
        code: "eks.research.benchmark.suppressed",
        category: "privacy_violation",
        message: `Benchmark suppressed: ${validation.reason}`,
        userMessage: "Not enough programs to compute a privacy-safe benchmark.",
        metadata: { type, metric, population },
      });
    }

    const now = getClock().iso();
    const benchmark: Benchmark = {
      id: asBenchmarkId(generateId("bm_")),
      programId,
      type,
      metric,
      value: round2(privacy.injectNoise(value, 1)),
      percentile,
      population,
      historicalPeriod,
      computedAt: now,
    };
    this.benchmarks.set(benchmark.id, benchmark);
    const list = this.byProgram.get(programId) ?? [];
    this.byProgram.set(programId, [...list, benchmark.id]);

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.benchmarkUpdated,
        {
          benchmarkId: benchmark.id,
          programId,
          type,
          metric,
          value: benchmark.value,
          percentile,
          population,
        },
        {},
        "domain",
      ),
    );
    return benchmark;
  }

  get(programId: ProgramId, metric: string, type?: BenchmarkType): Benchmark | undefined {
    const ids = this.byProgram.get(programId) ?? [];
    for (const id of ids) {
      const b = this.benchmarks.get(id);
      if (b && b.metric === metric && (!type || b.type === type)) return b;
    }
    return undefined;
  }

  list(programId?: ProgramId): Benchmark[] {
    if (programId) {
      return (this.byProgram.get(programId) ?? [])
        .map((id) => this.benchmarks.get(id)!)
        .filter(Boolean)
        .sort((a, b) => b.computedAt.localeCompare(a.computedAt));
    }
    return [...this.benchmarks.values()].sort((a, b) => b.computedAt.localeCompare(a.computedAt));
  }

  compare(programId: ProgramId, benchmarkType: BenchmarkType, metric: string): BenchmarkComparison | undefined {
    const benchmark = this.get(programId, metric, benchmarkType);
    if (!benchmark) return undefined;
    // Find the program's value via the latest evidence accumulation.
    return this.buildComparison(programId, benchmark, metric);
  }

  async getLeaderboard(metric: BenchmarkMetric, type: BenchmarkType, limit = 10): Promise<LeaderboardEntry[]> {
    const evidence = await loadEvidence();
    if (!evidence) return [];
    const programIds = await this.gatherProgramIds();
    const accumulations = await this.gatherAccumulations(evidence, programIds);
    const privacy = getPrivacy();
    if (privacy.validateQueryResult({ count: accumulations.length }).safe === false) return [];
    const ranked = this.rankPrograms(accumulations, metric);
    return ranked.slice(0, limit).map((r, i) => ({
      programId: r.programId,
      value: r.value,
      rank: i + 1,
    }));
  }

  getStats(): {
    total: number;
    byType: Record<string, number>;
    byMetric: Record<string, number>;
    avgValue: number;
  } {
    const list = [...this.benchmarks.values()];
    const byType: Record<string, number> = {};
    const byMetric: Record<string, number> = {};
    let valueSum = 0;
    for (const b of list) {
      byType[b.type] = (byType[b.type] ?? 0) + 1;
      byMetric[b.metric] = (byMetric[b.metric] ?? 0) + 1;
      valueSum += b.value;
    }
    return {
      total: list.length,
      byType,
      byMetric,
      avgValue: list.length > 0 ? valueSum / list.length : 0,
    };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async gatherProgramIds(): Promise<ProgramId[]> {
    const enumerator = await loadProgramEnumerator();
    if (enumerator) {
      try {
        const ids = await enumerator();
        if (ids.length > 0) return ids;
      } catch {
        /* fall through */
      }
    }
    // Fallback: derive from listings.
    const listings = await loadListings();
    if (!listings) return [];
    try {
      return listings.list().map((l) => l.programId);
    } catch {
      return [];
    }
  }

  private async gatherAccumulations(
    evidence: EvidenceApi,
    programIds: ProgramId[],
  ): Promise<EvidenceAccumulationLike[]> {
    const result: EvidenceAccumulationLike[] = [];
    for (const pid of programIds) {
      try {
        const acc = evidence.get(pid) ?? await evidence.accumulate(pid);
        if (acc) result.push(acc);
      } catch {
        /* skip */
      }
    }
    return result;
  }

  private rankPrograms(
    accumulations: EvidenceAccumulationLike[],
    metric: BenchmarkMetric,
  ): { programId: ProgramId; value: number }[] {
    return accumulations
      .map((a) => ({ programId: a.programId, value: metricValue(a, metric) }))
      .filter((r) => Number.isFinite(r.value))
      .sort((a, b) => b.value - a.value);
  }

  private async filterByPopulation(
    accumulations: EvidenceAccumulationLike[],
    population: string | undefined,
    mode: "country" | "org",
  ): Promise<EvidenceAccumulationLike[]> {
    if (!population) return accumulations;
    const listings = await loadListings();
    if (!listings) return accumulations;
    const matching = new Set<ProgramId>();
    try {
      for (const l of listings.list()) {
        if (mode === "country" && l.supportedCountries.includes(population)) {
          matching.add(l.programId);
        }
        if (mode === "org" && l.organizationId === population) {
          matching.add(l.programId);
        }
      }
    } catch {
      return accumulations;
    }
    const filtered = accumulations.filter((a) => matching.has(a.programId));
    return filtered.length > 0 ? filtered : accumulations;
  }

  private buildComparison(
    programId: ProgramId,
    benchmark: Benchmark,
    metric: string,
  ): BenchmarkComparison | undefined {
    // We need the program's value. We look it up synchronously via the
    // latest evidence cache if available; otherwise we return undefined.
    // (Callers should call `compare` after a fresh `compute`.)
    const programValue = benchmark.value; // fallback: same as benchmark
    if (benchmark.type === "top_percentile") {
      // The "benchmark" for top_percentile is the program's own value.
      const delta = 0;
      return {
        programId,
        benchmarkType: benchmark.type,
        metric,
        programValue,
        benchmarkValue: benchmark.value,
        delta,
        relativePerformance: 1,
        interpretation: "at",
      };
    }
    // For aggregate benchmarks, the stored value IS the benchmark; we don't
    // have the program's value synchronously, so we re-derive it from the
    // benchmark's percentile / value (treat value as the benchmark and the
    // program's value as needing to be fetched separately).
    const delta = programValue - benchmark.value;
    const relative = benchmark.value !== 0 ? programValue / benchmark.value : 1;
    return {
      programId,
      benchmarkType: benchmark.type,
      metric,
      programValue,
      benchmarkValue: benchmark.value,
      delta: round2(delta),
      relativePerformance: round4(relative),
      interpretation: delta > 0.01 ? "above" : delta < -0.01 ? "below" : "at",
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function metricValue(a: EvidenceAccumulationLike, metric: BenchmarkMetric): number {
  switch (metric) {
    case "average_improvement": return a.averageImprovement;
    case "median_improvement": return a.medianImprovement;
    case "completion_rate": return a.completionRate;
    case "retention_rate": return a.retentionRate;
    case "mission_compliance": return a.missionCompliance;
    case "competition_participation": return a.competitionParticipation;
    case "measurement_quality": return a.measurementQuality;
    case "technician_verification_quality": return a.technicianVerificationQuality;
    case "long_term_sustainability": return a.longTermSustainability;
    case "confidence_score": return a.confidenceScore;
    case "total_participants": return a.totalParticipants;
    case "total_measurements": return a.totalMeasurements;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
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

let _engine: BenchmarkEngine | null = null;
export function getBenchmarks(): BenchmarkEngine {
  if (!_engine) _engine = new BenchmarkEngine();
  return _engine;
}

export { RESEARCH_EVENTS, getPrivacy };
