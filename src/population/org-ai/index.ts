/**
 * Eks-Health Population Platform — Organization AI
 *
 * Statistical insight engine for organizations. Generates actionable
 * insights from the Organization Digital Twin and platform analytics:
 *   - participation forecasting (linear regression on historical snapshots)
 *   - program recommendations (gap analysis vs. research evidence)
 *   - competition optimization (engagement-based structure suggestions)
 *   - budget optimization (utilization-based reallocation)
 *   - population insights (aggregate health-trend summaries)
 *   - resource planning (utilization-based allocation suggestions)
 *   - engagement analysis (temporal pattern detection)
 *
 * IMPORTANT: every insight is computed via deterministic statistical
 * methods (linear regression, means, ratios, thresholds). It is explicitly
 * marked `statistical_analysis`, NOT `ai_generated`. The engine NEVER
 * touches individual health data — only aggregate counts and rates already
 * published by the org twin, evidence engine, and catalog manager.
 *
 * Built on all prior milestones. Pure TS, strict, ESM. No external deps.
 */

import "server-only";
import {
  type OrgInsightId,
  type PopulationOrgId,
  type ProgramId,
  type OrgInsightType,
  type OrganizationInsight,
  PopulationError,
  asOrgInsightId,
  POPULATION_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getHierarchy } from "../hierarchy";
import { getOrgTwin, type TwinSnapshot } from "../org-twin";
import { getOrgCatalog } from "../org-marketplace";

// ---------------------------------------------------------------------------
// Forecast metric
// ---------------------------------------------------------------------------

export type ForecastMetric = "participation" | "engagement" | "budget_utilization";

export interface ForecastResult {
  readonly orgId: PopulationOrgId;
  readonly metric: ForecastMetric;
  readonly horizonDays: number;
  readonly points: { timestamp: string; value: number }[];
  readonly forecast: { timestamp: string; value: number }[];
  readonly slope: number; // value per day
  readonly intercept: number;
  readonly rSquared: number;
  readonly projectedValue: number;
  readonly confidence: number;
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Defensive external loaders
// ---------------------------------------------------------------------------

interface MarketplaceListingLike {
  readonly programId: ProgramId;
  readonly name: string;
  readonly status: string;
  readonly category?: string;
  readonly rating?: { average?: number; count?: number };
  readonly pricingModel?: string;
}

interface MarketplaceApi {
  listListings(filter?: { status?: string }): MarketplaceListingLike[];
}

interface EvidenceLike {
  readonly programId: ProgramId;
  readonly totalParticipants: number;
  readonly confidenceScore: number;
  readonly averageImprovement: number;
  readonly completionRate: number;
  readonly retentionRate: number;
  readonly evidenceLevel: string;
}

interface EvidenceApi {
  get(programId: ProgramId): EvidenceLike | undefined;
  getTopEvidence(limit?: number): EvidenceLike[];
}

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

// ---------------------------------------------------------------------------
// Statistical helpers — real least-squares linear regression
// ---------------------------------------------------------------------------

interface Regression {
  slope: number;
  intercept: number;
  rSquared: number;
}

function linearRegression(xs: number[], ys: number[]): Regression {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, rSquared: 0 };
  const sumX = xs.reduce((a, x) => a + x, 0);
  const sumY = ys.reduce((a, y) => a + y, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slope = denX === 0 ? 0 : num / denX;
  const intercept = meanY - slope * meanX;
  const rSquared = denX === 0 || denY === 0 ? 0 : Math.max(0, Math.min(1, (num * num) / (denX * denY)));
  return { slope, intercept, rSquared };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class OrgAIEngine {
  private readonly insights = new Map<OrgInsightId, OrganizationInsight>();
  private readonly byOrg = new Map<PopulationOrgId, OrgInsightId[]>();

  /**
   * Generate an insight for an org. Real statistical computation from
   * aggregate platform data. Emits insight.generated.
   */
  async generate(orgId: PopulationOrgId, type: OrgInsightType): Promise<OrganizationInsight> {
    const org = getHierarchy().get(orgId);
    if (!org) {
      throw new PopulationError({
        code: "eks.population.orgai.org_not_found",
        category: "not_found",
        message: `Organization ${orgId} not found.`,
        userMessage: "Organization not found.",
      });
    }

    // Ensure the twin exists; rebuild lazily so insights reflect fresh data.
    const twinMgr = getOrgTwin();
    twinMgr.getOrCreate(orgId);
    let twin;
    try {
      twin = await twinMgr.update(orgId);
    } catch {
      twin = twinMgr.get(orgId)!;
    }
    const history = twinMgr.getHistory(orgId);

    let title = "";
    let summary = "";
    let confidence = 0;
    const recommendations: string[] = [];
    const dataSources: string[] = ["org_twin"];

    switch (type) {
      case "participation_forecasting": {
        const fc = this.forecastInternal(history, "participation", 30);
        dataSources.push("twin_history");
        const projected = fc.projectedValue;
        const current = twin.populationHealth.activeParticipants;
        const delta = projected - current;
        title = `Participation forecast: ${round2(projected)} active members in 30 days`;
        summary = `Based on ${fc.points.length} historical snapshots, active participation is projected to move from ${current} to ${round2(projected)} (slope ${round2(fc.slope)}/day, R²=${round2(fc.rSquared)}).`;
        confidence = fc.confidence;
        if (delta < 0) {
          recommendations.push(`Investigate engagement drivers: projected decline of ${round2(Math.abs(delta))} active members.`);
        } else if (delta > 0) {
          recommendations.push(`Sustain current initiatives: projected growth of ${round2(delta)} active members.`);
        } else {
          recommendations.push("Participation is stable; consider new campaigns to drive growth.");
        }
        if (fc.rSquared < 0.3) recommendations.push("Low model fit — collect more historical data before relying on this forecast.");
        break;
      }

      case "program_recommendations": {
        const installed = new Set<ProgramId>(twin.programAdoption.map((p) => p.programId));
        dataSources.push("org_catalog", "research.evidence", "programs.marketplace");
        const candidates: { programId: ProgramId; name: string; confidence: number; improvement: number; rating: number }[] = [];
        try {
          const evidence = await loadEvidence();
          const marketplace = await loadMarketplace();
          const topEvidence = evidence?.getTopEvidence(50) ?? [];
          const listings = marketplace?.listListings({ status: "published" }) ?? [];
          const listingByProgram = new Map<ProgramId, MarketplaceListingLike>();
          for (const l of listings) listingByProgram.set(l.programId, l);
          for (const acc of topEvidence) {
            if (installed.has(acc.programId)) continue;
            const listing = listingByProgram.get(acc.programId);
            candidates.push({
              programId: acc.programId,
              name: listing?.name ?? (acc.programId as string),
              confidence: acc.confidenceScore,
              improvement: acc.averageImprovement,
              rating: listing?.rating?.average ?? 0,
            });
          }
        } catch {
          /* optional */
        }
        // Rank: high confidence + high improvement + high rating
        candidates.sort((a, b) => (b.confidence + b.improvement + b.rating * 10) - (a.confidence + a.improvement + a.rating * 10));
        const top = candidates.slice(0, 5);
        title = `Program recommendations: ${top.length} candidate programs for adoption`;
        summary = `${twin.programAdoption.length} programs currently installed. Identified ${candidates.length} evidence-backed candidate programs not yet adopted by the organization.`;
        confidence = top.length > 0 ? Math.min(100, Math.round(mean(top.map((c) => c.confidence)))) : 20;
        for (const c of top) {
          recommendations.push(`Adopt '${c.name}' (confidence ${round2(c.confidence)}, avg improvement ${round2(c.improvement)}%).`);
        }
        if (top.length === 0) recommendations.push("No new evidence-backed programs available; revisit when research evidence accumulates.");
        break;
      }

      case "competition_optimization": {
        const comps = twin.competitions;
        dataSources.push("twin_competitions");
        const lowEngagement = comps.filter((c) => c.engagement < 40);
        const highEngagement = comps.filter((c) => c.engagement >= 70);
        title = `Competition optimization: ${comps.length} competitions, ${lowEngagement.length} low-engagement`;
        summary = `Avg engagement across org competitions: ${comps.length > 0 ? round2(mean(comps.map((c) => c.engagement))) : 0}/100. ${lowEngagement.length} low-engagement, ${highEngagement.length} high-engagement.`;
        confidence = comps.length > 0 ? Math.min(100, 40 + comps.length * 10) : 20;
        if (lowEngagement.length > 0) {
          recommendations.push(`Restructure ${lowEngagement.length} low-engagement competitions: shorten duration, add divisions, or align rewards with participant preferences.`);
        }
        if (highEngagement.length > 0) {
          recommendations.push(`Use ${highEngagement.length} high-engagement competitions as templates for future design.`);
        }
        if (comps.length === 0) {
          recommendations.push("No active competitions — launch a pilot competition scoped to the highest-adoption program.");
        }
        if (comps.length > 10) {
          recommendations.push("Competition saturation risk: consolidate overlapping competitions to reduce participant fatigue.");
        }
        break;
      }

      case "budget_optimization": {
        const b = twin.budgets;
        dataSources.push("twin_budgets");
        const utilization = b.allocated > 0 ? b.spent / b.allocated : 0;
        title = `Budget optimization: ${round2(utilization * 100)}% utilization, ${round2(b.remaining)} ${b.currency} remaining`;
        summary = `Allocated ${round2(b.allocated)} ${b.currency}, spent ${round2(b.spent)} ${b.currency}, remaining ${round2(b.remaining)} ${b.currency}. Utilization ${round2(utilization * 100)}%.`;
        confidence = b.allocated > 0 ? 70 : 20;
        if (utilization < 0.4 && b.allocated > 0) {
          recommendations.push(`Under-utilization: redirect ${round2(b.remaining * 0.5)} ${b.currency} to highest-evidence programs or competitions.`);
        } else if (utilization > 0.9) {
          recommendations.push("Near-exhaustion: request budget increase or pause low-ROI sponsorships.");
        } else {
          recommendations.push("Budget utilization is healthy; continue current allocation.");
        }
        // ROI hint: programs with strong evidence should get more budget
        try {
          const evidence = await loadEvidence();
          if (evidence && twin.programAdoption.length > 0) {
            const strong = twin.programAdoption
              .map((p) => ({ p, acc: evidence.get(p.programId) }))
              .filter((x) => x.acc && x.acc.confidenceScore >= 70)
              .sort((a, b) => (b.acc!.confidenceScore) - (a.acc!.confidenceScore));
            if (strong.length > 0) {
              recommendations.push(`Increase sponsorship for top-evidence program '${strong[0].p.programId}' (confidence ${strong[0].acc!.confidenceScore}).`);
            }
          }
        } catch {
          /* optional */
        }
        break;
      }

      case "population_insights": {
        dataSources.push("twin_population_health", "twin_evidence");
        const ph = twin.populationHealth;
        const risks = twin.risks;
        const highRisks = risks.filter((r) => r.level === "high");
        title = `Population insights: ${ph.activeParticipants} active, engagement ${round2(ph.engagementScore)}/100`;
        summary = `Avg improvement across adopted programs: ${round2(ph.avgImprovement)}%. Participation rate ${round2(ph.participationRate * 100)}%. ${risks.length} risk indicators (${highRisks.length} high).`;
        confidence = ph.activeParticipants > 0 ? Math.min(100, 50 + ph.activeParticipants) : 20;
        if (ph.avgImprovement < 5) {
          recommendations.push("Average improvement is low; review program mix and consider replacing low-evidence programs.");
        } else {
          recommendations.push(`Health outcomes trending positively (${round2(ph.avgImprovement)}% avg improvement); sustain current programs.`);
        }
        for (const r of highRisks) {
          recommendations.push(`Address high-priority risk: ${r.name}${r.detail ? ` — ${r.detail}` : ""}.`);
        }
        if (ph.engagementScore < 40) {
          recommendations.push("Engagement below 40/100: launch a campaign combining competitions + rewards.");
        }
        break;
      }

      case "resource_planning": {
        dataSources.push("twin_resources");
        const resources = twin.resources;
        title = `Resource planning: ${resources.length} resource types tracked`;
        const lowUtil = resources.filter((r) => r.utilization < 0.4);
        const highUtil = resources.filter((r) => r.utilization > 0.85);
        summary = resources.length === 0
          ? "No resource utilization data available yet."
          : `Resource utilization ranges from ${resources.length > 0 ? round2(Math.min(...resources.map((r) => r.utilization)) * 100) : 0}% to ${round2(Math.max(...resources.map((r) => r.utilization)) * 100)}%.`;
        confidence = resources.length > 0 ? 60 : 20;
        for (const r of lowUtil) {
          recommendations.push(`Under-utilized ${r.type} (${round2(r.utilization * 100)}%): reduce allocation or repurpose to higher-demand programs.`);
        }
        for (const r of highUtil) {
          recommendations.push(`Over-utilized ${r.type} (${round2(r.utilization * 100)}%): schedule additional capacity or stagger sessions.`);
        }
        if (resources.length === 0) {
          recommendations.push("Begin tracking technician sessions and device usage to enable resource planning.");
        }
        break;
      }

      case "engagement_analysis": {
        dataSources.push("twin_history");
        const points = history.map((s) => ({ t: Date.parse(s.capturedAt), v: s.twin.populationHealth.engagementScore })).filter((p) => !Number.isNaN(p.t));
        if (points.length >= 2) {
          const xs = points.map((p) => p.t);
          const ys = points.map((p) => p.v);
          const reg = linearRegression(xs, ys);
          const trend = reg.slope > 0.001 ? "improving" : reg.slope < -0.001 ? "declining" : "stable";
          title = `Engagement analysis: ${trend} trend (${round2(reg.slope * 86400000)} pts/day)`;
          summary = `Engagement over ${points.length} snapshots is ${trend}. Current: ${round2(twin.populationHealth.engagementScore)}/100. R²=${round2(reg.rSquared)}.`;
          confidence = Math.min(100, 40 + points.length * 10);
          if (trend === "declining") {
            recommendations.push("Engagement is declining — review recent program/competition changes and re-launch successful past initiatives.");
          } else if (trend === "improving") {
            recommendations.push("Engagement is improving — document and replicate the current playbook across other orgs.");
          } else {
            recommendations.push("Engagement is stable; introduce A/B-tested initiatives to break the plateau.");
          }
        } else {
          title = "Engagement analysis: insufficient history";
          summary = `Only ${points.length} historical snapshot(s) available; need at least 2 to compute a trend.`;
          confidence = 20;
          recommendations.push("Wait for more twin updates to enable trend analysis.");
        }
        break;
      }

      case "custom":
      default: {
        title = `Custom insight for ${org.name}`;
        summary = "No statistical computation defined for custom insight type.";
        confidence = 0;
        recommendations.push("Define a custom insight generator for this type.");
        break;
      }
    }

    const insight: OrganizationInsight = {
      id: asOrgInsightId(generateId("orgins_")),
      orgId,
      type,
      title,
      summary,
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      recommendations,
      dataSources,
      createdAt: getClock().iso(),
    };
    this.insights.set(insight.id, insight);
    const list = this.byOrg.get(orgId) ?? [];
    this.byOrg.set(orgId, [...list, insight.id]);

    void getEventBus().publish(
      buildEvent(
        POPULATION_EVENTS.orgInsightGenerated,
        { insightId: insight.id, orgId, type, confidence: insight.confidence, analysisMethod: "statistical_analysis" },
        {},
        "domain",
      ),
    );
    return insight;
  }

  get(id: OrgInsightId): OrganizationInsight | undefined {
    return this.insights.get(id);
  }

  list(orgId?: PopulationOrgId, type?: OrgInsightType): OrganizationInsight[] {
    let list: OrganizationInsight[];
    if (orgId) {
      const ids = this.byOrg.get(orgId) ?? [];
      list = ids.map((id) => this.insights.get(id)!).filter(Boolean);
    } else {
      list = [...this.insights.values()];
    }
    if (type) list = list.filter((i) => i.type === type);
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Top actionable recommendations across all insights for an org. */
  getRecommendations(orgId: PopulationOrgId): { insightId: OrgInsightId; insightType: OrgInsightType; recommendation: string; confidence: number }[] {
    const insights = this.list(orgId);
    const out: { insightId: OrgInsightId; insightType: OrgInsightType; recommendation: string; confidence: number }[] = [];
    for (const i of insights) {
      for (const r of i.recommendations) {
        out.push({ insightId: i.id, insightType: i.type, recommendation: r, confidence: i.confidence });
      }
    }
    // Higher confidence first.
    return out.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
  }

  /**
   * Forecast a metric N days into the future using linear regression on
   * historical twin snapshots. Returns the historical points used, the
   * projected points, slope/intercept/R², and a confidence score.
   */
  async getForecast(orgId: PopulationOrgId, metric: ForecastMetric, days: number): Promise<ForecastResult> {
    if (days <= 0) {
      throw new PopulationError({
        code: "eks.population.orgai.invalid_horizon",
        category: "validation",
        message: "Forecast horizon must be positive.",
        userMessage: "Forecast horizon must be a positive number of days.",
      });
    }
    const twinMgr = getOrgTwin();
    twinMgr.getOrCreate(orgId);
    // Include current twin as the most recent point.
    const current = twinMgr.get(orgId);
    const history = twinMgr.getHistory(orgId);
    const snapshots: TwinSnapshot[] = [...history];
    if (current) snapshots.push({ twin: current, capturedAt: current.lastUpdated });
    const fc = this.forecastInternal(snapshots, metric, days);
    return fc;
  }

  getStats(): {
    totalInsights: number;
    byType: Record<string, number>;
    avgConfidence: number;
  } {
    const list = [...this.insights.values()];
    const byType: Record<string, number> = {};
    for (const i of list) byType[i.type] = (byType[i.type] ?? 0) + 1;
    const avgConfidence = list.length > 0 ? Math.round(mean(list.map((i) => i.confidence))) : 0;
    return {
      totalInsights: list.length,
      byType,
      avgConfidence,
    };
  }

  // -----------------------------------------------------------------------
  // Internal: forecast from a snapshot series
  // -----------------------------------------------------------------------

  private forecastInternal(
    snapshots: TwinSnapshot[],
    metric: ForecastMetric,
    horizonDays: number,
  ): ForecastResult {
    const points: { timestamp: string; value: number }[] = [];
    for (const s of snapshots) {
      let v: number | undefined;
      if (metric === "participation") v = s.twin.populationHealth.activeParticipants;
      else if (metric === "engagement") v = s.twin.populationHealth.engagementScore;
      else if (metric === "budget_utilization") {
        const allocated = s.twin.budgets.allocated;
        v = allocated > 0 ? s.twin.budgets.spent / allocated : 0;
      }
      if (v === undefined) continue;
      points.push({ timestamp: s.capturedAt, value: v });
    }
    // Sort chronologically.
    points.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const xs = points.map((p) => Date.parse(p.timestamp));
    const ys = points.map((p) => p.value);
    const reg = linearRegression(xs, ys);
    const lastTs = xs.length > 0 ? xs[xs.length - 1] : Date.now();
    const projectedTs = lastTs + horizonDays * 86_400_000;
    const projectedValue = reg.slope * projectedTs + reg.intercept;

    // Confidence: blend of sample size and fit quality.
    const sampleScore = Math.min(1, points.length / 10); // 10+ points = full
    const fitScore = reg.rSquared;
    const confidence = Math.round(Math.min(1, 0.5 * sampleScore + 0.5 * fitScore) * 100);

    // Generate forecast points (one per horizon day).
    const forecast: { timestamp: string; value: number }[] = [];
    for (let d = 1; d <= horizonDays; d++) {
      const ts = lastTs + d * 86_400_000;
      forecast.push({ timestamp: new Date(ts).toISOString(), value: Math.round((reg.slope * ts + reg.intercept) * 100) / 100 });
    }

    return {
      orgId: snapshots[0]?.twin.orgId ?? ("" as PopulationOrgId),
      metric,
      horizonDays,
      points,
      forecast,
      slope: Math.round(reg.slope * 86400000 * 1000) / 1000, // per day
      intercept: reg.intercept,
      rSquared: Math.round(reg.rSquared * 1000) / 1000,
      projectedValue: Math.round(projectedValue * 100) / 100,
      confidence,
      computedAt: getClock().iso(),
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: OrgAIEngine | null = null;
export function getOrgAI(): OrgAIEngine {
  if (!_engine) _engine = new OrgAIEngine();
  return _engine;
}
