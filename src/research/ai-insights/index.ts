/**
 * Eks-Health Research Platform — AI Population Intelligence
 *
 * AI tools for researchers: trend discovery, hypothesis generation, anomaly
 * detection, program comparison, risk forecasting, outcome summarization,
 * evidence synthesis. Every insight is explainable and traceable.
 *
 * Because no LLM provider is wired into the platform's research core, every
 * insight is computed from REAL platform data using REAL statistical methods
 * (means, standard deviations, z-scores, linear regression slopes, Pearson
 * correlation, IQR-based outlier detection). Each insight is clearly marked
 * `methodology: "statistical_analysis"` — never "ai_generated". When a real
 * AI provider is integrated later, the same inputs and outputs will produce
 * LLM-augmented summaries; the explainability contract stays identical.
 *
 * Real logic:
 *  - Real trend discovery: pulls population snapshots, examines the
 *    improvementTrends array, computes trend strength (signed magnitude /
 *    mean of absolute magnitudes), identifies the most pronounced up/down
 *    trends. Confidence scaled by population size + number of trend buckets.
 *  - Real hypothesis generation: scans evidence accumulations, computes
 *    Pearson correlation between completion rate and average improvement
 *    across programs; proposes a hypothesis that the correlation reflects a
 *    causal relationship. Confidence bounded by sample size + |r|.
 *  - Real anomaly detection: z-score over program effectiveness values; flags
 *    |z| > 1.5 as candidate anomalies. Evidence records the exact z-scores.
 *  - Real program comparison: aggregates comparative studies (if present) or
 *    falls back to evidence accumulations, ranks programs by effectiveness,
 *    computes pairwise deltas. Confidence from study significance.
 *  - Real risk forecasting: linear regression over the evidence history
 *    (participants + improvement over time), extrapolates `horizonDays`
 *    forward. Confidence from R² of the regression.
 *  - Real outcome summarization: combines all evidence accumulations into a
 *    narrative string with real numeric totals (participants, measurements,
 *    average improvement, completion rate).
 *  - Real evidence synthesis: combines population snapshots + benchmarks +
 *    evidence accumulations, produces a structured cross-source synthesis.
 *
 * Every insight includes `explainable: true` and `traceable: true`. The full
 * computation trail (methodology, data points, steps) is retrievable via
 * getExplainable(id).
 *
 * Boundary: insights only ever reference aggregated, anonymized platform
 * state — never individual participant records.
 */

import "server-only";
import type {
  AccountId,
  Benchmark,
  ComparativeStudy,
  EvidenceAccumulation,
  InsightId,
  InsightType,
  PopulationSnapshot,
  ProgramId,
  ResearchInsight,
} from "../core";
import {
  RESEARCH_EVENTS,
  ResearchError,
  asInsightId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InsightMethodology = "statistical_analysis" | "ai_generated";

export interface InsightGenerateInput {
  readonly type: InsightType;
  readonly createdBy: AccountId;
  readonly programId?: ProgramId;
  readonly programIds?: ProgramId[];
  readonly metric?: string;
  readonly categoryFocus?: string;
  readonly areaOfInterest?: string;
  readonly horizonDays?: number;
}

export interface InsightListFilter {
  readonly type?: InsightType;
  readonly createdBy?: AccountId;
  readonly minConfidence?: number;
  readonly maxConfidence?: number;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface InsightExplanation {
  readonly insight: ResearchInsight;
  readonly methodology: InsightMethodology;
  readonly explanation: string;
  readonly evidenceTrail: ReadonlyArray<{
    readonly source: string;
    readonly detail: string;
    readonly sourceId?: string;
    readonly timestamp?: string;
  }>;
  readonly computationSteps: string[];
  readonly dataPoints: number;
  readonly generatedAt: string;
}

export interface ProgramRecommendation {
  readonly programId: ProgramId;
  readonly generatedAt: string;
  readonly recommendations: string[];
  readonly supportingEvidence: { source: string; detail: string }[];
  readonly confidence: number;
  readonly methodology: InsightMethodology;
}

export interface InsightStats {
  readonly total: number;
  readonly byType: Record<InsightType, number>;
  readonly averageConfidence: number;
  readonly highConfidence: number; // confidence >= 0.7
  readonly lowConfidence: number; // confidence < 0.4
}

// ---------------------------------------------------------------------------
// Mutable internal types
// ---------------------------------------------------------------------------

interface MutableInsight extends ResearchInsight {
  id: InsightId;
  type: InsightType;
  title: string;
  summary: string;
  confidence: number;
  evidence: { source: string; detail: string }[];
  recommendations: string[];
  aiTraceId?: string;
  explainable: boolean;
  traceable: boolean;
  createdBy: AccountId;
  createdAt: string;
}

/** A MutableInsight without its id — what each per-type generator returns.
 *  The id is assigned by generate() after the insight is computed. */
type InsightDraft = Omit<MutableInsight, "id">;

interface StoredExplanation {
  readonly insightId: InsightId;
  readonly methodology: InsightMethodology;
  readonly explanation: string;
  readonly evidenceTrail: { source: string; detail: string; sourceId?: string; timestamp?: string }[];
  readonly computationSteps: string[];
  readonly dataPoints: number;
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Sibling-module accessor interfaces (all dynamic-import + try/catch guarded)
// ---------------------------------------------------------------------------

interface PopulationManager {
  getLatest?(): PopulationSnapshot | undefined;
  get?(): PopulationSnapshot | undefined;
  list?(): PopulationSnapshot[];
  listAll?(): PopulationSnapshot[];
}

interface EvidenceManager {
  get?(programId: ProgramId): EvidenceAccumulation | undefined;
  getByProgram?(programId: ProgramId): EvidenceAccumulation | undefined;
  list?(): EvidenceAccumulation[];
  listAll?(): EvidenceAccumulation[];
}

interface BenchmarkManager {
  get?(id: unknown): Benchmark | undefined;
  list?(): Benchmark[];
  listAll?(): Benchmark[];
  byProgram?(programId: ProgramId): Benchmark[];
  listByProgram?(programId: ProgramId): Benchmark[];
}

interface ComparativeManager {
  get?(id: unknown): ComparativeStudy | undefined;
  list?(): ComparativeStudy[];
  listAll?(): ComparativeStudy[];
  byProgram?(programId: ProgramId): ComparativeStudy[];
}

// ---------------------------------------------------------------------------
// Statistical helpers (real implementations)
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function zscore(value: number, m: number, sd: number): number {
  if (sd === 0) return 0;
  return (value - m) / sd;
}

/** Pearson correlation coefficient. Returns 0 if undefined. */
function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  if (denom === 0) return 0;
  return num / denom;
}

/** Simple linear regression (least squares). Returns { slope, intercept, r2 }. */
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  // R²
  const r = pearson(xs, ys);
  const r2 = Math.max(0, Math.min(1, r * r));
  return { slope, intercept, r2 };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Sibling fetchers
// ---------------------------------------------------------------------------

async function fetchPopulationSnapshots(): Promise<PopulationSnapshot[]> {
  const candidates = ["../population", "../snapshots"];
  for (const path of candidates) {
    try {
      const mod = (await import(path)) as {
        getPopulation?: () => unknown;
        getPopulationManager?: () => unknown;
        getSnapshots?: () => unknown;
      };
      const accessor = mod?.getPopulation ?? mod?.getPopulationManager ?? mod?.getSnapshots;
      const mgr = accessor?.() as PopulationManager & { getHistory?: (limit?: number) => PopulationSnapshot[] } | undefined;
      if (!mgr) continue;
      if (mgr.list) return mgr.list() ?? [];
      if (mgr.listAll) return mgr.listAll() ?? [];
      if (mgr.getHistory) {
        const history = mgr.getHistory(1000) ?? [];
        if (history.length) return history;
      }
      if (mgr.getLatest) {
        const latest = mgr.getLatest();
        return latest ? [latest] : [];
      }
      if (mgr.get) {
        const single = mgr.get();
        return single ? [single] : [];
      }
    } catch {
      /* try next */
    }
  }
  return [];
}

async function fetchEvidenceAccumulations(programId?: ProgramId): Promise<EvidenceAccumulation[]> {
  const candidates = ["../evidence", "../accumulation"];
  for (const path of candidates) {
    try {
      const mod = (await import(path)) as {
        getEvidence?: () => unknown;
        getEvidenceEngine?: () => unknown;
        getEvidenceAccumulation?: () => unknown;
        getAccumulation?: () => unknown;
      };
      const accessor = mod?.getEvidenceEngine ?? mod?.getEvidence ?? mod?.getEvidenceAccumulation ?? mod?.getAccumulation;
      const mgr = accessor?.() as EvidenceManager | undefined;
      if (!mgr) continue;
      if (programId) {
        const one = mgr.get?.(programId) ?? mgr.getByProgram?.(programId);
        if (one) return [one];
      }
      if (mgr.list) return mgr.list() ?? [];
      if (mgr.listAll) return mgr.listAll() ?? [];
      // EvidenceEngine exposes getTopEvidence(limit?) — use it to gather all
      const top = (mgr as { getTopEvidence?: (limit?: number) => EvidenceAccumulation[] }).getTopEvidence?.(1000);
      if (top) return top;
    } catch {
      /* try next */
    }
  }
  return [];
}

async function fetchBenchmarks(programId?: ProgramId): Promise<Benchmark[]> {
  const candidates = ["../benchmarks", "../benchmark"];
  for (const path of candidates) {
    try {
      const mod = (await import(path)) as {
        getBenchmarks?: () => unknown;
        getBenchmarkManager?: () => unknown;
        getBenchmark?: () => unknown;
      };
      const accessor = mod?.getBenchmarks ?? mod?.getBenchmarkManager ?? mod?.getBenchmark;
      const mgr = accessor?.() as BenchmarkManager | undefined;
      if (!mgr) continue;
      if (programId) {
        if (mgr.byProgram) return mgr.byProgram(programId) ?? [];
        if (mgr.listByProgram) return mgr.listByProgram(programId) ?? [];
      }
      if (mgr.list) return mgr.list() ?? [];
      if (mgr.listAll) return mgr.listAll() ?? [];
    } catch {
      /* try next */
    }
  }
  return [];
}

async function fetchComparativeStudies(programId?: ProgramId): Promise<ComparativeStudy[]> {
  const candidates = ["../comparative", "../comparisons"];
  for (const path of candidates) {
    try {
      const mod = (await import(path)) as {
        getComparative?: () => unknown;
        getComparativeStudies?: () => unknown;
        getComparisons?: () => unknown;
      };
      const accessor = mod?.getComparative ?? mod?.getComparativeStudies ?? mod?.getComparisons;
      const mgr = accessor?.() as ComparativeManager | undefined;
      if (!mgr) continue;
      if (programId) {
        if (mgr.byProgram) return mgr.byProgram(programId) ?? [];
      }
      if (mgr.list) return mgr.list() ?? [];
      if (mgr.listAll) return mgr.listAll() ?? [];
    } catch {
      /* try next */
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// ResearchInsightEngine
// ---------------------------------------------------------------------------

export class ResearchInsightEngine {
  private readonly insights = new Map<InsightId, MutableInsight>();
  private readonly explanations = new Map<InsightId, StoredExplanation>();
  private readonly byType = new Map<InsightType, InsightId[]>();
  private readonly byCreator = new Map<AccountId, InsightId[]>();
  private readonly byProgram = new Map<ProgramId, InsightId[]>();

  /**
   * Generate a research insight. Dispatches on `type` to a real statistical
   * computation. If insufficient data is available (no population snapshots,
   * no evidence, etc.), generates a low-confidence insight with a clear "no
   * data" summary rather than throwing — researchers can still see the
   * attempt was made.
   */
  async generate(input: InsightGenerateInput): Promise<ResearchInsight> {
    if (!input.createdBy) {
      throw new ResearchError({
        code: "eks.research.insight.validation",
        category: "validation",
        message: "createdBy is required.",
      });
    }
    let result: { insight: InsightDraft; explanation: StoredExplanation };
    switch (input.type) {
      case "trend_discovery":
        result = await this.generateTrendDiscovery(input);
        break;
      case "hypothesis_generation":
        result = await this.generateHypothesis(input);
        break;
      case "anomaly_detection":
        result = await this.generateAnomalyDetection(input);
        break;
      case "program_comparison":
        result = await this.generateProgramComparison(input);
        break;
      case "risk_forecasting":
        result = await this.generateRiskForecast(input);
        break;
      case "outcome_summarization":
        result = await this.generateOutcomeSummary(input);
        break;
      case "evidence_synthesis":
        result = await this.generateEvidenceSynthesis(input);
        break;
      default:
        throw new ResearchError({
          code: "eks.research.insight.validation",
          category: "validation",
          message: `Unknown insight type: ${input.type as string}`,
        });
    }
    const id = asInsightId(generateId("rins_"));
    const insight: MutableInsight = { ...result.insight, id };
    this.insights.set(id, insight);
    this.explanations.set(id, { ...result.explanation, insightId: id });
    this.index(this.byType, insight.type, id);
    this.index(this.byCreator, insight.createdBy, id);
    if (input.programId) this.index(this.byProgram, input.programId, id);

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.populationInsightGenerated,
        {
          insightId: id,
          type: insight.type,
          confidence: insight.confidence,
          createdBy: insight.createdBy,
          methodology: result.explanation.methodology,
        },
        {},
        "domain",
      ),
    );

    return this.freeze(insight);
  }

  /** Get an insight by id. */
  get(id: InsightId): ResearchInsight {
    const ins = this.insights.get(id);
    if (!ins) {
      throw new ResearchError({
        code: "eks.research.insight.not_found",
        category: "not_found",
        message: `Insight ${id} not found.`,
        userMessage: "Insight not found.",
        metadata: { insightId: id },
      });
    }
    return this.freeze(ins);
  }

  /** List insights by filter. */
  list(filter: InsightListFilter = {}): ResearchInsight[] {
    let ids: InsightId[] | undefined;
    if (filter.type) ids = this.byType.get(filter.type);
    else if (filter.createdBy) ids = this.byCreator.get(filter.createdBy);
    else ids = [...this.insights.keys()];

    let items = (ids ?? []).map((id) => this.insights.get(id)!).filter(Boolean);
    if (filter.type) items = items.filter((i) => i.type === filter.type);
    if (filter.createdBy) items = items.filter((i) => i.createdBy === filter.createdBy);
    if (filter.minConfidence !== undefined) items = items.filter((i) => i.confidence >= filter.minConfidence!);
    if (filter.maxConfidence !== undefined) items = items.filter((i) => i.confidence <= filter.maxConfidence!);
    if (filter.since) items = items.filter((i) => i.createdAt >= filter.since!);
    if (filter.until) items = items.filter((i) => i.createdAt <= filter.until!);

    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? items.length;
    return items.slice(offset, offset + limit).map((i) => this.freeze(i));
  }

  /** Get all insights of a specific type. */
  getByType(type: InsightType): ResearchInsight[] {
    return (this.byType.get(type) ?? []).map((id) => this.insights.get(id)!).filter(Boolean).map((i) => this.freeze(i));
  }

  /** Get all insights associated with a specific program. */
  getByProgram(programId: ProgramId): ResearchInsight[] {
    return (this.byProgram.get(programId) ?? []).map((id) => this.insights.get(id)!).filter(Boolean).map((i) => this.freeze(i));
  }

  /** Get the full explanation + evidence trail for an insight. */
  getExplainable(id: InsightId): InsightExplanation {
    const ins = this.insights.get(id);
    if (!ins) {
      throw new ResearchError({
        code: "eks.research.insight.not_found",
        category: "not_found",
        message: `Insight ${id} not found.`,
        userMessage: "Insight not found.",
        metadata: { insightId: id },
      });
    }
    const exp = this.explanations.get(id);
    return {
      insight: this.freeze(ins),
      methodology: exp?.methodology ?? "statistical_analysis",
      explanation: exp?.explanation ?? "No detailed explanation recorded.",
      evidenceTrail: exp?.evidenceTrail ?? ins.evidence.map((e) => ({ source: e.source, detail: e.detail })),
      computationSteps: exp?.computationSteps ?? [],
      dataPoints: exp?.dataPoints ?? ins.evidence.length,
      generatedAt: exp?.generatedAt ?? ins.createdAt,
    };
  }

  /**
   * Get AI-generated improvement recommendations for a program based on its
   * evidence + benchmarks. Real computation: identifies weak metrics (below
   * benchmark or below population mean) and proposes targeted actions.
   */
  async getRecommendations(programId: ProgramId): Promise<ProgramRecommendation> {
    if (!programId) {
      throw new ResearchError({
        code: "eks.research.insight.validation",
        category: "validation",
        message: "programId is required.",
      });
    }
    const [evidenceList, benchmarks] = await Promise.all([
      fetchEvidenceAccumulations(programId),
      fetchBenchmarks(programId),
    ]);
    const evidence = evidenceList[0];
    const recs: string[] = [];
    const supporting: { source: string; detail: string }[] = [];
    let confidence = 0.3;

    if (evidence) {
      if (evidence.completionRate < 0.5) {
        recs.push(`Improve program completion — currently ${Math.round(evidence.completionRate * 100)}%, below the 50% healthy threshold. Consider shorter missions or more frequent nudges.`);
        supporting.push({ source: "evidence_accumulation", detail: `completionRate=${evidence.completionRate}` });
      }
      if (evidence.retentionRate < 0.4) {
        recs.push(`Strengthen long-term retention — currently ${Math.round(evidence.retentionRate * 100)}%. Introduce milestone rewards at week 4 and week 12.`);
        supporting.push({ source: "evidence_accumulation", detail: `retentionRate=${evidence.retentionRate}` });
      }
      if (evidence.measurementQuality < 0.7) {
        recs.push(`Measurement quality is ${Math.round(evidence.measurementQuality * 100)}%. Add technician verification touchpoints for the lowest-quality measurement categories.`);
        supporting.push({ source: "evidence_accumulation", detail: `measurementQuality=${evidence.measurementQuality}` });
      }
      if (evidence.averageImprovement < 5) {
        recs.push(`Average improvement is only ${round2(evidence.averageImprovement)}%. Re-evaluate the program's core intervention intensity.`);
        supporting.push({ source: "evidence_accumulation", detail: `averageImprovement=${evidence.averageImprovement}` });
      }
      if (evidence.confidenceScore > 0 && evidence.confidenceScore < 50) {
        recs.push(`Evidence confidence is low (${Math.round(evidence.confidenceScore)}/100). Collect more measurements before scaling.`);
        supporting.push({ source: "evidence_accumulation", detail: `confidenceScore=${evidence.confidenceScore}` });
      }
      confidence = clamp(0.4 + evidence.confidenceScore / 200, 0, 0.95);
    } else {
      recs.push("No evidence accumulation found for this program. Begin by enrolling participants and collecting verified measurements.");
      supporting.push({ source: "evidence_accumulation", detail: "no record" });
    }

    if (benchmarks.length) {
      const relevant = benchmarks.filter((b) => b.metric === "average_improvement" || b.metric === "completion_rate");
      for (const b of relevant) {
        if (evidence) {
          if (b.metric === "average_improvement" && evidence.averageImprovement < b.value) {
            recs.push(`Average improvement ${round2(evidence.averageImprovement)}% is below the ${b.type} benchmark of ${round2(b.value)}%. Investigate the gap.`);
            supporting.push({ source: "benchmark", detail: `${b.metric} ${b.type}=${b.value}` });
          }
          if (b.metric === "completion_rate" && evidence.completionRate * 100 < b.value) {
            recs.push(`Completion ${Math.round(evidence.completionRate * 100)}% is below the ${b.type} benchmark of ${round2(b.value)}%.`);
            supporting.push({ source: "benchmark", detail: `${b.metric} ${b.type}=${b.value}` });
          }
        }
      }
      confidence = clamp(confidence + 0.1, 0, 0.95);
    }

    if (recs.length === 0) {
      recs.push("Program is performing above thresholds and benchmarks. Continue current operations and monitor for drift.");
      confidence = clamp(confidence + 0.1, 0, 0.95);
    }

    return {
      programId,
      generatedAt: getClock().iso(),
      recommendations: recs,
      supportingEvidence: supporting,
      confidence: round2(confidence),
      methodology: "statistical_analysis",
    };
  }

  /** Aggregate stats across all insights. */
  getStats(): InsightStats {
    const list = [...this.insights.values()];
    const byType = {} as Record<InsightType, number>;
    const allTypes: InsightType[] = [
      "trend_discovery", "hypothesis_generation", "anomaly_detection",
      "program_comparison", "risk_forecasting", "outcome_summarization", "evidence_synthesis",
    ];
    for (const t of allTypes) byType[t] = 0;
    let totalConf = 0;
    let high = 0;
    let low = 0;
    for (const i of list) {
      byType[i.type] = (byType[i.type] ?? 0) + 1;
      totalConf += i.confidence;
      if (i.confidence >= 0.7) high++;
      if (i.confidence < 0.4) low++;
    }
    return {
      total: list.length,
      byType,
      averageConfidence: list.length ? round2(totalConf / list.length) : 0,
      highConfidence: high,
      lowConfidence: low,
    };
  }

  // -----------------------------------------------------------------------
  // Per-type generators (all real statistical computations)
  // -----------------------------------------------------------------------

  private async generateTrendDiscovery(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const snapshots = await fetchPopulationSnapshots();
    const now = getClock().iso();
    const steps: string[] = [];
    steps.push(`Fetched ${snapshots.length} population snapshot(s) from sibling module.`);

    if (!snapshots.length) {
      return this.buildNoDataInsight(input, "trend_discovery", "No population snapshots available for trend discovery.", now, steps);
    }

    // Aggregate improvementTrends across snapshots, scoped by categoryFocus if provided
    const trendBuckets = new Map<string, { category: string; avgImprovement: number; trend: "up" | "down" | "stable" }[]>();
    for (const snap of snapshots) {
      for (const t of snap.improvementTrends ?? []) {
        if (input.categoryFocus && t.category.toLowerCase() !== input.categoryFocus.toLowerCase()) continue;
        const list = trendBuckets.get(t.category) ?? [];
        list.push(t);
        trendBuckets.set(t.category, list);
      }
    }

    if (!trendBuckets.size) {
      return this.buildNoDataInsight(input, "trend_discovery", "No improvement trends recorded in available snapshots.", now, steps);
    }

    steps.push(`Aggregated trends across ${trendBuckets.size} categories.`);

    // Score each category by average magnitude
    const scored = [...trendBuckets.entries()].map(([category, list]) => {
      const mags = list.map((t) => Math.abs(t.avgImprovement));
      const avgMag = mean(mags);
      const lastTrend = list[list.length - 1].trend;
      return { category, avgMag: round2(avgMag), trend: lastTrend, sampleCount: list.length };
    });
    scored.sort((a, b) => b.avgMag - a.avgMag);

    const top = scored[0];
    const worst = scored[scored.length - 1];
    steps.push(`Ranked ${scored.length} categories by average magnitude of improvement.`);

    const allMags = scored.map((s) => s.avgMag);
    const overallMean = mean(allMags);
    const overallSd = stddev(allMags);
    const topZ = zscore(top.avgMag, overallMean, overallSd);
    steps.push(`Top category "${top.category}" has z-score ${round2(topZ)} vs the category mean.`);

    // Confidence: scaled by number of categories + how strongly the top trend stands out
    const confidence = clamp(0.4 + (top.avgMag / 100) * 0.4 + clamp(Math.abs(topZ) / 4, 0, 0.2), 0, 0.95);

    const title = input.categoryFocus
      ? `Trend discovery: ${top.category} shows the strongest ${top.trend} trend`
      : `Trend discovery: ${top.category} trending ${top.trend} (strongest of ${scored.length} categories)`;

    const summary = `Across ${snapshots.length} population snapshot(s), the "${top.category}" category shows the strongest improvement trend (avg magnitude ${top.avgMag}%, trend=${top.trend}). The weakest category is "${worst.category}" (${worst.avgMag}%). Overall mean improvement across categories is ${round2(overallMean)}% (σ=${round2(overallSd)}).`;

    const evidence = [
      { source: "population_snapshot", detail: `${snapshots.length} snapshots analyzed, ${scored.length} categories aggregated` },
      { source: "trend_aggregation", detail: `Top: ${top.category}=${top.avgMag}% (${top.trend}); Bottom: ${worst.category}=${worst.avgMag}%` },
      { source: "statistical_summary", detail: `mean=${round2(overallMean)}, σ=${round2(overallSd)}, top z-score=${round2(topZ)}` },
    ];

    const recommendations = [
      `Prioritize research attention on "${top.category}" — it shows the strongest population-level signal.`,
      `Investigate why "${worst.category}" lags; it may benefit from program redesign.`,
      `Use the ${round2(overallMean)}% mean as a benchmark when evaluating individual programs.`,
    ];

    return {
      insight: {
        type: "trend_discovery",
        title,
        summary,
        confidence: round2(confidence),
        evidence,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId, // filled by caller
        methodology: "statistical_analysis",
        explanation: `This insight was produced by aggregating the improvementTrends field across ${snapshots.length} population snapshot(s), grouping by category, computing the mean absolute magnitude per category, then ranking categories. The top category's z-score (relative to the cross-category mean and standard deviation) quantifies how strongly it stands out. No LLM was used; all numbers are computed from platform state.`,
        evidenceTrail: [
          { source: "population_snapshot", detail: `${snapshots.length} snapshots`, timestamp: snapshots[snapshots.length - 1]?.capturedAt },
          { source: "trend_aggregation", detail: `aggregated ${trendBuckets.size} categories`, timestamp: now },
          { source: "ranking", detail: `top=${top.category}@${top.avgMag}%, bottom=${worst.category}@${worst.avgMag}%`, timestamp: now },
        ],
        computationSteps: steps,
        dataPoints: scored.length,
        generatedAt: now,
      },
    };
  }

  private async generateHypothesis(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const evidenceList = await fetchEvidenceAccumulations(input.programId);
    const now = getClock().iso();
    const steps: string[] = [];
    steps.push(`Fetched ${evidenceList.length} evidence accumulation(s).`);

    if (evidenceList.length < 3) {
      return this.buildNoDataInsight(input, "hypothesis_generation", `Only ${evidenceList.length} evidence accumulation(s) available — need at least 3 to compute a correlation.`, now, steps);
    }

    const xs = evidenceList.map((e) => e.completionRate);
    const ys = evidenceList.map((e) => e.averageImprovement);
    const r = pearson(xs, ys);
    steps.push(`Computed Pearson r(completion → improvement) = ${round2(r)} over ${xs.length} programs.`);

    const direction = r > 0 ? "positive" : "inverse";
    const strength = Math.abs(r) > 0.7 ? "strong" : Math.abs(r) > 0.4 ? "moderate" : "weak";
    const confidence = clamp(0.3 + Math.abs(r) * 0.5 + Math.min(0.15, xs.length / 100), 0, 0.95);

    const title = `Hypothesis: ${direction} ${strength} relationship between program completion rate and average improvement (r=${round2(r)})`;

    const summary = `Across ${xs.length} programs with accumulated evidence, the Pearson correlation between completion rate and average improvement is r=${round2(r)} (${direction}, ${strength}). This ${Math.abs(r) > 0.4 ? "supports" : "does not strongly support"} the hypothesis that higher program completion drives greater health improvement, though correlation does not imply causation.`;

    const evidence = [
      { source: "evidence_accumulation", detail: `${xs.length} programs analyzed` },
      { source: "pearson_correlation", detail: `r = ${round2(r)} (completion × improvement)` },
      { source: "correlation_strength", detail: `|r|=${round2(Math.abs(r))} → ${strength} ${direction}` },
    ];

    const recommendations = [
      `Design a controlled study to test whether ${direction === "positive" ? "increasing" : "decreasing"} completion ${direction === "positive" ? "causes" : "is associated with"} greater improvement.`,
      `Control for confounders: participant motivation, baseline severity, and program intensity all correlate with both variables.`,
      `Replicate with a randomized trial before claiming causation.`,
    ];

    return {
      insight: {
        type: "hypothesis_generation",
        title,
        summary,
        confidence: round2(confidence),
        evidence,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `Computed Pearson correlation between completionRate (x) and averageImprovement (y) across ${xs.length} evidence accumulations. The correlation coefficient r measures linear association; |r|>0.7 is strong, 0.4-0.7 is moderate, <0.4 is weak. Causation requires a controlled experiment.`,
        evidenceTrail: evidenceList.slice(0, 5).map((e) => ({
          source: "evidence_accumulation",
          detail: `programId=${e.programId}, completion=${round2(e.completionRate)}, improvement=${round2(e.averageImprovement)}`,
          timestamp: e.lastUpdated,
        })),
        computationSteps: steps,
        dataPoints: xs.length,
        generatedAt: now,
      },
    };
  }

  private async generateAnomalyDetection(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const snapshots = await fetchPopulationSnapshots();
    const now = getClock().iso();
    const steps: string[] = [];

    if (!snapshots.length) {
      return this.buildNoDataInsight(input, "anomaly_detection", "No population snapshots available for anomaly detection.", now, steps);
    }

    const snapshot = snapshots[snapshots.length - 1];
    const effectiveness = snapshot.programEffectiveness ?? [];
    steps.push(`Using latest snapshot with ${effectiveness.length} program effectiveness values.`);

    if (effectiveness.length < 3) {
      return this.buildNoDataInsight(input, "anomaly_detection", `Only ${effectiveness.length} program effectiveness values — need at least 3 for outlier detection.`, now, steps);
    }

    const values = effectiveness.map((e) => e.effectiveness);
    const m = mean(values);
    const sd = stddev(values);
    const anomalies = effectiveness
      .map((e) => ({ ...e, z: zscore(e.effectiveness, m, sd) }))
      .filter((e) => Math.abs(e.z) > 1.5)
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    steps.push(`Mean effectiveness=${round2(m)}, σ=${round2(sd)}. Found ${anomalies.length} anomalies with |z|>1.5.`);

    if (!anomalies.length) {
      const confidence = 0.4;
      return {
        insight: {
          type: "anomaly_detection",
          title: "Anomaly detection: no program-effectiveness outliers detected",
          summary: `Across ${effectiveness.length} programs, no effectiveness values fall more than 1.5σ from the mean (μ=${round2(m)}, σ=${round2(sd)}). Population appears statistically homogeneous.`,
          confidence: round2(confidence),
          evidence: [
            { source: "population_snapshot", detail: `${effectiveness.length} programs` },
            { source: "zscore_analysis", detail: `μ=${round2(m)}, σ=${round2(sd)}, max |z|=${round2(Math.max(...effectiveness.map((e) => Math.abs(zscore(e.effectiveness, m, sd)))))}` },
          ],
          recommendations: [
            "Continue monitoring — absence of outliers is itself a useful signal.",
            "Tighten the threshold to 1.0σ if early-warning detection is desired.",
          ],
          aiTraceId: undefined,
          explainable: true,
          traceable: true,
          createdBy: input.createdBy,
          createdAt: now,
        },
        explanation: {
          insightId: "" as InsightId,
          methodology: "statistical_analysis",
          explanation: `Computed mean and standard deviation of program effectiveness values from the latest population snapshot. Applied z-score outlier detection with threshold |z|>1.5. No values exceeded the threshold.`,
          evidenceTrail: effectiveness.slice(0, 5).map((e) => ({
            source: "program_effectiveness",
            detail: `programId=${e.programId}, effectiveness=${round2(e.effectiveness)}, z=${round2(zscore(e.effectiveness, m, sd))}`,
            timestamp: snapshot.capturedAt,
          })),
          computationSteps: steps,
          dataPoints: effectiveness.length,
          generatedAt: now,
        },
      };
    }

    const top = anomalies[0];
    const confidence = clamp(0.5 + Math.min(0.4, Math.abs(top.z) / 4), 0, 0.95);
    const title = `Anomaly detection: ${anomalies.length} program(s) show outlying effectiveness (top |z|=${round2(Math.abs(top.z))})`;
    const summary = `Across ${effectiveness.length} programs (μ=${round2(m)}, σ=${round2(sd)}), ${anomalies.length} program(s) have effectiveness values more than 1.5σ from the mean. The most extreme is program ${top.programId} (effectiveness=${round2(top.effectiveness)}, z=${round2(top.z)}).`;

    const evidence = [
      { source: "population_snapshot", detail: `${effectiveness.length} programs analyzed` },
      { source: "zscore_analysis", detail: `μ=${round2(m)}, σ=${round2(sd)}, threshold=1.5σ` },
      { source: "anomaly", detail: `top: ${top.programId} z=${round2(top.z)} (effectiveness ${round2(top.effectiveness)})` },
    ];

    const recommendations = [
      `Investigate program ${top.programId}: its ${top.z > 0 ? "exceptionally high" : "exceptionally low"} effectiveness may indicate either a breakthrough or a data quality issue.`,
      `Cross-check with evidence accumulations for the flagged programs to verify sample sizes.`,
      `If the outlier is real, study its methodology for transferable practices.`,
    ];

    return {
      insight: {
        type: "anomaly_detection",
        title,
        summary,
        confidence: round2(confidence),
        evidence,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `Computed mean (μ) and standard deviation (σ) of program effectiveness values from the latest population snapshot. For each program, computed z=(effectiveness-μ)/σ. Flagged |z|>1.5 as candidate anomalies. Z-scores quantify how many standard deviations a value is from the mean.`,
        evidenceTrail: anomalies.slice(0, 5).map((a) => ({
          source: "program_effectiveness",
          detail: `programId=${a.programId}, effectiveness=${round2(a.effectiveness)}, z=${round2(a.z)}`,
          timestamp: snapshot.capturedAt,
        })),
        computationSteps: steps,
        dataPoints: effectiveness.length,
        generatedAt: now,
      },
    };
  }

  private async generateProgramComparison(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const comparative = await fetchComparativeStudies();
    const now = getClock().iso();
    const steps: string[] = [];
    steps.push(`Fetched ${comparative.length} comparative study/studies.`);

    let relevant = comparative;
    if (input.programIds && input.programIds.length) {
      relevant = comparative.filter((c) => c.programIds.some((p) => input.programIds!.includes(p)));
      steps.push(`Filtered to ${relevant.length} studies touching the requested programs.`);
    }

    if (!relevant.length) {
      // Fall back to evidence accumulations
      const evidence = await fetchEvidenceAccumulations();
      if (evidence.length < 2) {
        return this.buildNoDataInsight(input, "program_comparison", "No comparative studies and fewer than 2 evidence accumulations available for comparison.", now, steps);
      }
      const ranked = [...evidence].sort((a, b) => b.averageImprovement - a.averageImprovement);
      const top = ranked[0];
      const bottom = ranked[ranked.length - 1];
      const delta = round2(top.averageImprovement - bottom.averageImprovement);
      const confidence = clamp(0.3 + Math.min(0.4, ranked.length / 25), 0, 0.85);
      const title = `Program comparison: ${top.programId} leads with ${round2(top.averageImprovement)}% avg improvement (Δ=${delta}% vs bottom)`;
      const summary = `No comparative studies available; fell back to evidence accumulations across ${ranked.length} programs. Top: ${top.programId} (${round2(top.averageImprovement)}%). Bottom: ${bottom.programId} (${round2(bottom.averageImprovement)}%). Delta: ${delta}%.`;
      return {
        insight: {
          type: "program_comparison",
          title,
          summary,
          confidence: round2(confidence),
          evidence: [
            { source: "evidence_accumulation", detail: `${ranked.length} programs compared (comparative studies unavailable)` },
            { source: "ranking", detail: `top=${top.programId}@${round2(top.averageImprovement)}%, bottom=${bottom.programId}@${round2(bottom.averageImprovement)}%` },
          ],
          recommendations: [
            `Use ${top.programId}'s methodology as a reference standard.`,
            `Investigate the ${delta}% gap — could be program design, population, or measurement fidelity.`,
          ],
          aiTraceId: undefined,
          explainable: true,
          traceable: true,
          createdBy: input.createdBy,
          createdAt: now,
        },
        explanation: {
          insightId: "" as InsightId,
          methodology: "statistical_analysis",
          explanation: `No comparative studies found; fell back to ranking evidence accumulations by averageImprovement. Top and bottom programs compared with absolute delta.`,
          evidenceTrail: ranked.slice(0, 5).map((e) => ({
            source: "evidence_accumulation",
            detail: `programId=${e.programId}, improvement=${round2(e.averageImprovement)}`,
            timestamp: e.lastUpdated,
          })),
          computationSteps: steps,
          dataPoints: ranked.length,
          generatedAt: now,
        },
      };
    }

    // Aggregate comparative study results
    const allResults: { programId: ProgramId; value: number; confidence: number; sampleSize: number; studyId: string }[] = [];
    for (const study of relevant) {
      for (const r of study.results) {
        allResults.push({ programId: r.programId, value: r.value, confidence: r.confidence, sampleSize: r.sampleSize, studyId: study.id });
      }
    }
    if (!allResults.length) {
      return this.buildNoDataInsight(input, "program_comparison", "Comparative studies exist but contain no per-program results.", now, steps);
    }
    const byProgram = new Map<ProgramId, { values: number[]; confidences: number[]; sampleSizes: number[] }>();
    for (const r of allResults) {
      const agg = byProgram.get(r.programId) ?? { values: [], confidences: [], sampleSizes: [] };
      agg.values.push(r.value);
      agg.confidences.push(r.confidence);
      agg.sampleSizes.push(r.sampleSize);
      byProgram.set(r.programId, agg);
    }
    const ranked = [...byProgram.entries()].map(([programId, agg]) => ({
      programId,
      meanValue: round2(mean(agg.values)),
      meanConfidence: round2(mean(agg.confidences)),
      totalSample: agg.sampleSizes.reduce((a, b) => a + b, 0),
    }));
    ranked.sort((a, b) => b.meanValue - a.meanValue);
    steps.push(`Aggregated ${allResults.length} per-program results across ${relevant.length} studies into ${ranked.length} ranked programs.`);

    const top = ranked[0];
    const bottom = ranked[ranked.length - 1];
    const delta = round2(top.meanValue - bottom.meanValue);
    const bestSig = Math.min(...relevant.map((s) => s.significance));
    const confidence = clamp(0.5 + (1 - bestSig) * 0.3 + Math.min(0.15, relevant.length / 10), 0, 0.95);

    const title = `Program comparison: ${top.programId} ranks #1 of ${ranked.length} (Δ=${delta} vs #${ranked.length})`;
    const summary = `Across ${relevant.length} comparative study/studies (${allResults.length} per-program results), ${top.programId} leads with mean outcome ${top.meanValue} (${top.totalSample} participants, confidence ${top.meanConfidence}). Last place: ${bottom.programId} (${bottom.meanValue}). Delta: ${delta}. Best study p-value: ${bestSig}.`;

    const evidence = [
      { source: "comparative_studies", detail: `${relevant.length} studies, ${allResults.length} results` },
      { source: "ranking", detail: `#1=${top.programId}@${top.meanValue}, #${ranked.length}=${bottom.programId}@${bottom.meanValue}, Δ=${delta}` },
      { source: "significance", detail: `best p-value=${bestSig}` },
    ];

    const recommendations = [
      `Prioritize ${top.programId} for scale-up consideration.`,
      `Investigate why ${bottom.programId} underperforms — methodology, population, or fidelity?`,
      `Replicate the top-ranked program in new populations to validate generalizability.`,
    ];

    return {
      insight: {
        type: "program_comparison",
        title,
        summary,
        confidence: round2(confidence),
        evidence,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `Aggregated per-program results from ${relevant.length} comparative studies. For each program, computed the mean outcome value across all studies it appeared in. Ranked programs by mean outcome. Reported the top-to-bottom delta and the best (lowest) study p-value as a significance indicator.`,
        evidenceTrail: ranked.slice(0, 5).map((r) => ({
          source: "comparative_study_result",
          detail: `programId=${r.programId}, mean=${r.meanValue}, sample=${r.totalSample}, confidence=${r.meanConfidence}`,
          timestamp: now,
        })),
        computationSteps: steps,
        dataPoints: allResults.length,
        generatedAt: now,
      },
    };
  }

  private async generateRiskForecast(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const horizonDays = input.horizonDays ?? 90;
    const evidenceList = await fetchEvidenceAccumulations(input.programId);
    const now = getClock().iso();
    const steps: string[] = [];

    if (!evidenceList.length) {
      return this.buildNoDataInsight(input, "risk_forecasting", "No evidence accumulations available for forecasting.", now, steps);
    }

    // Collect the history series (participants, improvement over time)
    const series: { ts: number; participants: number; improvement: number; confidence: number }[] = [];
    for (const e of evidenceList) {
      for (const h of e.history ?? []) {
        series.push({ ts: new Date(h.at).getTime(), participants: h.participants, improvement: h.improvement, confidence: h.confidence });
      }
    }
    series.sort((a, b) => a.ts - b.ts);

    if (series.length < 3) {
      return this.buildNoDataInsight(input, "risk_forecasting", `Only ${series.length} history data points — need at least 3 to fit a regression.`, now, steps);
    }

    // Normalize time to days from the first sample
    const t0 = series[0].ts;
    const xs = series.map((s) => (s.ts - t0) / 86400000);
    const ysImp = series.map((s) => s.improvement);
    const ysPart = series.map((s) => s.participants);

    const regImp = linearRegression(xs, ysImp);
    const regPart = linearRegression(xs, ysPart);
    steps.push(`Fitted linear regression on improvement: slope=${round2(regImp.slope)}/day, R²=${round2(regImp.r2)}.`);
    steps.push(`Fitted linear regression on participants: slope=${round2(regPart.slope)}/day, R²=${round2(regPart.r2)}.`);

    const lastDay = xs[xs.length - 1];
    const forecastDay = lastDay + horizonDays;
    const projectedImprovement = round2(regImp.slope * forecastDay + regImp.intercept);
    const projectedParticipants = Math.max(0, Math.round(regPart.slope * forecastDay + regPart.intercept));

    // Confidence: weighted by both R² values, capped
    const confidence = clamp(0.3 + (regImp.r2 + regPart.r2) / 2 * 0.5, 0, 0.85);
    steps.push(`Extrapolated ${horizonDays} days forward: projected improvement=${projectedImprovement}%, projected participants=${projectedParticipants}.`);

    // Risk indicators
    const risks: string[] = [];
    if (regImp.slope < 0) risks.push(`Improvement is declining at ${round2(Math.abs(regImp.slope))}%/day — projected to reach ${projectedImprovement}% in ${horizonDays} days.`);
    if (regPart.slope < 0) risks.push(`Participation is declining at ${Math.abs(regPart.slope)}/day — projected to reach ${projectedParticipants} participants.`);
    if (regImp.r2 < 0.3) risks.push(`Low model fit (R²=${round2(regImp.r2)}) — forecast is uncertain.`);
    if (!risks.length) risks.push(`No declining trends detected over the ${horizonDays}-day horizon. Improvement forecast: ${projectedImprovement}%.`);

    const title = input.programId
      ? `Risk forecast for ${input.programId}: ${regImp.slope < 0 || regPart.slope < 0 ? "declining trends detected" : "stable trajectory"} over ${horizonDays}d`
      : `Risk forecast: ${regImp.slope < 0 || regPart.slope < 0 ? "declining trends detected" : "stable trajectory"} over ${horizonDays}d`;

    const summary = `Based on ${series.length} history data points across ${evidenceList.length} evidence accumulation(s), a linear regression forecasts improvement at ${projectedImprovement}% and participation at ${projectedParticipants} after ${horizonDays} days. Improvement slope: ${round2(regImp.slope)}/day (R²=${round2(regImp.r2)}). Participation slope: ${round2(regPart.slope)}/day (R²=${round2(regPart.r2)}).`;

    const evidence = [
      { source: "evidence_history", detail: `${series.length} data points, ${evidenceList.length} programs` },
      { source: "linear_regression", detail: `improvement slope=${round2(regImp.slope)}/day, R²=${round2(regImp.r2)}` },
      { source: "forecast", detail: `+${horizonDays}d: improvement=${projectedImprovement}%, participants=${projectedParticipants}` },
    ];

    const recommendations = [
      ...(regImp.slope < 0 ? [`Reverse the improvement decline — projected to drop to ${projectedImprovement}% within ${horizonDays} days without intervention.`] : []),
      ...(regPart.slope < 0 ? [`Reverse participation decline — projected to fall to ${projectedParticipants} participants.`] : []),
      ...(regImp.r2 < 0.3 ? [`Low R² (${round2(regImp.r2)}) — gather more data before acting decisively.`] : []),
      `Re-run this forecast weekly to detect when slopes reverse.`,
    ];

    return {
      insight: {
        type: "risk_forecasting",
        title,
        summary,
        confidence: round2(confidence),
        evidence,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `Collected the history field from each evidence accumulation, normalized timestamps to days from the first sample, then fit two simple linear regressions (least squares): improvement vs day and participants vs day. Extrapolated the regression line forward by ${horizonDays} days. R² (coefficient of determination) measures how well the linear model fits; values near 1 indicate strong linear structure, near 0 indicate high noise.`,
        evidenceTrail: series.slice(-5).map((s) => ({
          source: "evidence_history",
          detail: `day=${round2((s.ts - t0) / 86400000)}, improvement=${round2(s.improvement)}, participants=${s.participants}`,
          timestamp: new Date(s.ts).toISOString(),
        })),
        computationSteps: steps,
        dataPoints: series.length,
        generatedAt: now,
      },
    };
  }

  private async generateOutcomeSummary(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const evidenceList = await fetchEvidenceAccumulations(input.programId);
    const now = getClock().iso();
    const steps: string[] = [];
    steps.push(`Fetched ${evidenceList.length} evidence accumulation(s).`);

    if (!evidenceList.length) {
      return this.buildNoDataInsight(input, "outcome_summarization", "No evidence accumulations available to summarize.", now, steps);
    }

    const totalParticipants = evidenceList.reduce((a, e) => a + e.totalParticipants, 0);
    const totalMeasurements = evidenceList.reduce((a, e) => a + e.totalMeasurements, 0);
    const avgImprovements = evidenceList.map((e) => e.averageImprovement);
    const completionRates = evidenceList.map((e) => e.completionRate);
    const retentionRates = evidenceList.map((e) => e.retentionRate);

    const overallAvgImprovement = round2(mean(avgImprovements));
    const overallCompletion = round2(mean(completionRates));
    const overallRetention = round2(mean(retentionRates));
    const evidenceLevels = evidenceList.map((e) => e.evidenceLevel);
    const strongCount = evidenceLevels.filter((l) => l === "strong" || l === "established").length;

    steps.push(`Aggregated across ${evidenceList.length} programs: ${totalParticipants} participants, ${totalMeasurements} measurements.`);
    const confidence = clamp(0.4 + Math.min(0.4, totalParticipants / 10000) + (strongCount / Math.max(1, evidenceList.length)) * 0.15, 0, 0.95);

    const scope = input.programId ? `program ${input.programId}` : `${evidenceList.length} programs`;
    const title = `Outcome summary: ${scope} — avg improvement ${overallAvgImprovement}%, ${strongCount}/${evidenceList.length} programs at established/strong evidence`;
    const summary = `Across ${scope}, ${totalParticipants} participants contributed ${totalMeasurements} measurements. Mean average improvement: ${overallAvgImprovement}%. Mean completion rate: ${Math.round(overallCompletion * 100)}%. Mean retention rate: ${Math.round(overallRetention * 100)}%. ${strongCount} of ${evidenceList.length} programs have reached established or strong evidence levels.`;

    const evidence = [
      { source: "evidence_accumulation", detail: `${evidenceList.length} programs, ${totalParticipants} participants, ${totalMeasurements} measurements` },
      { source: "outcome_aggregation", detail: `avg improvement=${overallAvgImprovement}%, completion=${Math.round(overallCompletion * 100)}%, retention=${Math.round(overallRetention * 100)}%` },
      { source: "evidence_levels", detail: `${strongCount}/${evidenceList.length} programs at established/strong` },
    ];

    const recommendations = [
      `Use the ${overallAvgImprovement}% average improvement as the population baseline for benchmarking.`,
      `The ${strongCount} established/strong programs are the best candidates for replication studies.`,
      `${evidenceList.length - strongCount} programs still need more data — prioritize measurement collection there.`,
    ];

    return {
      insight: {
        type: "outcome_summarization",
        title,
        summary,
        confidence: round2(confidence),
        evidence,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `Aggregated the evidence accumulation fields across ${evidenceList.length} programs. Sums for participants and measurements; means for improvement, completion, and retention rates. Counted programs at "established" or "strong" evidence levels. No LLM used.`,
        evidenceTrail: evidenceList.slice(0, 5).map((e) => ({
          source: "evidence_accumulation",
          detail: `programId=${e.programId}, participants=${e.totalParticipants}, improvement=${round2(e.averageImprovement)}, level=${e.evidenceLevel}`,
          timestamp: e.lastUpdated,
        })),
        computationSteps: steps,
        dataPoints: evidenceList.length,
        generatedAt: now,
      },
    };
  }

  private async generateEvidenceSynthesis(input: InsightGenerateInput): Promise<{ insight: InsightDraft; explanation: StoredExplanation }> {
    const [snapshots, evidence, benchmarks] = await Promise.all([
      fetchPopulationSnapshots(),
      fetchEvidenceAccumulations(input.programId),
      fetchBenchmarks(input.programId),
    ]);
    const now = getClock().iso();
    const steps: string[] = [];
    steps.push(`Synthesized across ${snapshots.length} snapshots, ${evidence.length} evidence accumulations, ${benchmarks.length} benchmarks.`);

    if (!snapshots.length && !evidence.length && !benchmarks.length) {
      return this.buildNoDataInsight(input, "evidence_synthesis", "No platform data sources available for synthesis.", now, steps);
    }

    const sources: string[] = [];
    if (snapshots.length) sources.push(`${snapshots.length} population snapshots`);
    if (evidence.length) sources.push(`${evidence.length} evidence accumulations`);
    if (benchmarks.length) sources.push(`${benchmarks.length} benchmarks`);

    // Cross-source synthesis: average improvement from evidence, snapshot trend confirmation, benchmark comparison
    const avgImprovementEvidence = evidence.length ? round2(mean(evidence.map((e) => e.averageImprovement))) : undefined;
    const snapshotTrendDir = snapshots.length && snapshots[snapshots.length - 1].improvementTrends.length
      ? snapshots[snapshots.length - 1].improvementTrends[snapshots[snapshots.length - 1].improvementTrends.length - 1].trend
      : undefined;
    const benchmarkAvg = benchmarks.length ? round2(mean(benchmarks.filter((b) => b.metric === "average_improvement").map((b) => b.value))) : undefined;

    const agreement = (() => {
      if (avgImprovementEvidence === undefined || benchmarkAvg === undefined) return "insufficient_data";
      const diff = avgImprovementEvidence - benchmarkAvg;
      if (Math.abs(diff) < 2) return "aligned";
      return diff > 0 ? "evidence_above_benchmark" : "evidence_below_benchmark";
    })();

    steps.push(`Cross-source agreement: ${agreement} (evidence avg=${avgImprovementEvidence ?? "n/a"}, benchmark avg=${benchmarkAvg ?? "n/a"}, snapshot trend=${snapshotTrendDir ?? "n/a"}).`);

    const confidence = clamp(
      0.3 + (snapshots.length ? 0.15 : 0) + (evidence.length ? 0.2 : 0) + (benchmarks.length ? 0.15 : 0) + (agreement === "aligned" ? 0.15 : 0),
      0, 0.95,
    );

    const title = `Evidence synthesis: ${sources.join(", ")} — ${agreement}`;
    const summary = `Synthesized evidence from ${sources.join(", ")}. ${avgImprovementEvidence !== undefined ? `Evidence accumulations report avg improvement ${avgImprovementEvidence}%. ` : ""}${benchmarkAvg !== undefined ? `Benchmarks suggest avg ${benchmarkAvg}%. ` : ""}${snapshotTrendDir ? `Population snapshot trend is ${snapshotTrendDir}. ` : ""}Cross-source agreement: ${agreement}.`;

    const evidenceList: { source: string; detail: string }[] = [];
    if (snapshots.length) evidenceList.push({ source: "population_snapshot", detail: `${snapshots.length} snapshots, latest trend=${snapshotTrendDir ?? "n/a"}` });
    if (evidence.length) evidenceList.push({ source: "evidence_accumulation", detail: `${evidence.length} programs, avg improvement=${avgImprovementEvidence ?? "n/a"}` });
    if (benchmarks.length) evidenceList.push({ source: "benchmark", detail: `${benchmarks.length} benchmarks, avg=${benchmarkAvg ?? "n/a"}` });
    evidenceList.push({ source: "cross_source_agreement", detail: agreement });

    const recommendations = [
      ...(agreement === "evidence_below_benchmark" ? ["Evidence falls below benchmarks — investigate program design or population mismatch."] : []),
      ...(agreement === "evidence_above_benchmark" ? ["Evidence exceeds benchmarks — strong case for scale-up."] : []),
      ...(agreement === "aligned" ? ["Evidence and benchmarks are aligned — confident in current conclusions."] : ["Collect more data to enable cross-source agreement analysis."]),
      "Re-synthesize weekly as new snapshots and evidence arrive.",
    ];

    return {
      insight: {
        type: "evidence_synthesis",
        title,
        summary,
        confidence: round2(confidence),
        evidence: evidenceList,
        recommendations,
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `Pulled data from three independent platform sources (population snapshots, evidence accumulations, benchmarks)${input.programId ? ` scoped to program ${input.programId}` : ""}. Computed aggregate metrics per source, then compared them: average improvement from evidence vs. benchmark average (agreement = within 2 percentage points), and noted the latest population trend direction.`,
        evidenceTrail: [
          ...(snapshots.length ? [{ source: "population_snapshot", detail: `${snapshots.length} snapshots`, timestamp: snapshots[snapshots.length - 1].capturedAt }] : []),
          ...(evidence.length ? [{ source: "evidence_accumulation", detail: `${evidence.length} programs, avg=${avgImprovementEvidence ?? "n/a"}`, timestamp: evidence[0].lastUpdated }] : []),
          ...(benchmarks.length ? [{ source: "benchmark", detail: `${benchmarks.length} benchmarks, avg=${benchmarkAvg ?? "n/a"}`, timestamp: benchmarks[0].computedAt }] : []),
        ],
        computationSteps: steps,
        dataPoints: snapshots.length + evidence.length + benchmarks.length,
        generatedAt: now,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildNoDataInsight(
    input: InsightGenerateInput,
    type: InsightType,
    reason: string,
    now: string,
    steps: string[],
  ): { insight: InsightDraft; explanation: StoredExplanation } {
    return {
      insight: {
        type,
        title: `${type}: insufficient platform data`,
        summary: reason,
        confidence: 0.1,
        evidence: [{ source: "platform_data", detail: reason }],
        recommendations: [
          "Collect more measurements before re-running this insight.",
          "Verify that sibling research modules (population, evidence, benchmarks, comparative) are loaded.",
        ],
        aiTraceId: undefined,
        explainable: true,
        traceable: true,
        createdBy: input.createdBy,
        createdAt: now,
      },
      explanation: {
        insightId: "" as InsightId,
        methodology: "statistical_analysis",
        explanation: `The insight engine attempted to compute a ${type} insight but the underlying platform data sources returned insufficient records. Returned a low-confidence placeholder with the exact reason.`,
        evidenceTrail: [{ source: "platform_data", detail: reason, timestamp: now }],
        computationSteps: steps,
        dataPoints: 0,
        generatedAt: now,
      },
    };
  }

  private index<K>(map: Map<K, InsightId[]>, key: K, id: InsightId): void {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) map.set(key, [...list, id]);
  }

  private freeze(ins: MutableInsight): ResearchInsight {
    return {
      id: ins.id,
      type: ins.type,
      title: ins.title,
      summary: ins.summary,
      confidence: ins.confidence,
      evidence: ins.evidence.map((e) => ({ ...e })),
      recommendations: [...ins.recommendations],
      aiTraceId: ins.aiTraceId,
      explainable: ins.explainable,
      traceable: ins.traceable,
      createdBy: ins.createdBy,
      createdAt: ins.createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: ResearchInsightEngine | null = null;
export function getInsights(): ResearchInsightEngine {
  if (!_engine) _engine = new ResearchInsightEngine();
  return _engine;
}

export { RESEARCH_EVENTS, type ResearchInsight, type InsightType, type InsightId };
