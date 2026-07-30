"use client";

import { FlaskConical, ShieldCheck, TrendingUp, Database, BookOpen, Brain, Scale, BarChart3, Zap } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function ResearchSection({ data }: { data: PlatformSnapshot }) {
  const r = (data.research as Record<string, unknown>) ?? {};
  const consent = (r.consent as { stats?: { total?: number; active?: number; revoked?: number; expired?: number; byType?: Record<string, number> }; types?: Array<{ type: string; status: string; purpose: string; expiresAt?: string }> }) ?? {};
  const privacy = (r.privacy as { kAnonymityThreshold?: number; suppressionThreshold?: number; noiseEnabled?: boolean }) ?? {};
  const evidence = (r.evidence as { totalPrograms?: number; byLevel?: Record<string, number>; avgConfidence?: number }) ?? {};
  const population = (r.population as { latest?: { totalParticipants?: number; totalMeasurements?: number; totalPrograms?: number; totalCompetitions?: number }; stats?: { totalSnapshots?: number } }) ?? {};
  const insights = (r.insights as { total?: number; byType?: Record<string, number>; avgConfidence?: number }) ?? {};
  const governance = (r.governance as { total?: number; pending?: number; approved?: number; rejected?: number; approvalRate?: number }) ?? {};
  const datasets = (r.datasets as { total?: number; byStatus?: Record<string, number>; totalExports?: number }) ?? {};
  const publications = (r.publications as { total?: number; byType?: Record<string, number>; peerReviewed?: number }) ?? {};
  const benchmarks = (r.benchmarks as { total?: number; byType?: Record<string, number> }) ?? {};
  const comparative = (r.comparative as { total?: number; avgSignificance?: number }) ?? {};
  const workspaces = (r.workspaces as { total?: number; totalMembers?: number; totalStudies?: number }) ?? {};
  const cohorts = (r.cohorts as { total?: number; byPrivacyLevel?: Record<string, number> }) ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Research & Population Intelligence"
        subtitle="The self-improving knowledge ecosystem. Every verified health journey contributes to better preventive healthcare for everyone — while preserving participant privacy. K-anonymity, differential privacy, consent-gated research, and AI-generated insights create a flywheel: more participants → better evidence → better AI → better Programs → better outcomes."
        icon={<FlaskConical className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Active Consents" value={consent.stats?.active ?? 0} accent hint="research participants" />
        <StatCard label="Evidence Tracked" value={evidence.totalPrograms ?? 0} hint={`avg confidence: ${evidence.avgConfidence?.toFixed(0) ?? "—"}`} />
        <StatCard label="AI Insights" value={insights.total ?? 0} hint={`avg confidence: ${insights.avgConfidence?.toFixed(2) ?? "—"}`} />
        <StatCard label="Datasets" value={datasets.total ?? 0} hint={`${datasets.totalExports ?? 0} exports`} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Population Size" value={population.latest?.totalParticipants ?? 0} hint={`${population.latest?.totalMeasurements ?? 0} measurements`} />
        <StatCard label="Publications" value={publications.total ?? 0} hint={`${publications.peerReviewed ?? 0} peer-reviewed`} />
        <StatCard label="Governance Requests" value={governance.total ?? 0} hint={`${governance.pending ?? 0} pending`} />
        <StatCard label="Workspaces" value={workspaces.total ?? 0} hint={`${workspaces.totalStudies ?? 0} studies`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Research Consent Platform">
          <p className="text-xs text-muted-foreground mb-3">Participants independently consent to 10 research types. Each consent is granular, revocable, versioned, time-limited, purpose-specific.</p>
          <div className="space-y-1.5">
            {(consent.types ?? []).map((t) => (
              <div key={t.type} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                <div>
                  <span className="font-medium">{t.type.replace(/_/g, " ")}</span>
                  <p className="text-[10px] text-muted-foreground">{t.purpose}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant={t.status === "granted" ? "default" : "secondary"} className="text-[10px]">{t.status}</Badge>
                  {t.expiresAt && <span className="text-[10px] text-muted-foreground">expires {new Date(t.expiresAt).toLocaleDateString()}</span>}
                </div>
              </div>
            ))}
            {(consent.types ?? []).length === 0 && <EmptyState message="No active research consents." />}
          </div>
        </Panel>

        <Panel title="Privacy Protection">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 p-2.5">
              <ShieldCheck className="h-4 w-4 text-[var(--brand)]" />
              <div>
                <p className="text-xs font-medium">K-Anonymity (k={privacy.kAnonymityThreshold ?? 10})</p>
                <p className="text-[11px] text-muted-foreground">Groups smaller than k are suppressed</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 p-2.5">
              <ShieldCheck className="h-4 w-4 text-[var(--brand)]" />
              <div>
                <p className="text-xs font-medium">Differential Privacy</p>
                <p className="text-[11px] text-muted-foreground">Laplace noise injection enabled ({privacy.noiseEnabled ? "on" : "off"})</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 p-2.5">
              <ShieldCheck className="h-4 w-4 text-[var(--brand)]" />
              <div>
                <p className="text-xs font-medium">Suppression Threshold ({privacy.suppressionThreshold ?? 5})</p>
                <p className="text-[11px] text-muted-foreground">Small populations are suppressed</p>
              </div>
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Evidence Engine">
          <p className="text-xs text-muted-foreground mb-2">Programs continuously accumulate evidence from verified outcomes:</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              ["preliminary", evidence.byLevel?.preliminary ?? 0],
              ["emerging", evidence.byLevel?.emerging ?? 0],
              ["established", evidence.byLevel?.established ?? 0],
              ["strong", evidence.byLevel?.strong ?? 0],
            ].map(([level, count]) => (
              <div key={level} className="rounded-md border border-border/40 p-2 text-center">
                <p className="text-lg font-semibold">{count as number}</p>
                <Mono className="text-[10px] text-muted-foreground">{level}</Mono>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="AI Population Intelligence">
          <p className="text-xs text-muted-foreground mb-2">Statistical insights from real platform data — explainable and traceable:</p>
          <div className="flex flex-wrap gap-1.5">
            {["trend_discovery", "hypothesis_generation", "anomaly_detection", "program_comparison", "risk_forecasting", "outcome_summarization", "evidence_synthesis"].map((t) => (
              <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
            ))}
          </div>
          {insights.byType && Object.keys(insights.byType).length > 0 && (
            <div className="mt-2 space-y-0.5">
              {Object.entries(insights.byType).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between text-xs">
                  <Mono className="text-muted-foreground">{type}</Mono>
                  <span className="font-medium">{count}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Research Capabilities">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            { icon: <FlaskConical className="h-4 w-4" />, name: "Cohort Builder", desc: "Privacy-protected cohort definitions with real criteria evaluation" },
            { icon: <Database className="h-4 w-4" />, name: "Dataset Management", desc: "Privacy-protected datasets with k-anonymity + noise injection exports" },
            { icon: <Scale className="h-4 w-4" />, name: "Comparative Effectiveness", desc: "Program vs program with Cohen's d + statistical significance" },
            { icon: <BarChart3 className="h-4 w-4" />, name: "Benchmarks", desc: "Top percentile, median, global/country/age/org averages" },
            { icon: <TrendingUp className="h-4 w-4" />, name: "Population Intelligence", desc: "Improvement trends, seasonal effects, regional differences" },
            { icon: <Brain className="h-4 w-4" />, name: "AI Insights", desc: "Trend discovery, hypothesis generation, anomaly detection" },
            { icon: <BookOpen className="h-4 w-4" />, name: "Publications", desc: "Reports, dashboards, evidence summaries linked to Programs" },
            { icon: <ShieldCheck className="h-4 w-4" />, name: "Governance", desc: "Dataset approval, access requests, legal holds, audit trails" },
            { icon: <Zap className="h-4 w-4" />, name: "Self-Improving Flywheel", desc: "Every verified health journey contributes to better healthcare for everyone" },
          ].map((c) => (
            <div key={c.name} className="flex items-start gap-2.5 rounded-md border border-border/40 p-2.5">
              <div className="text-[var(--brand)] mt-0.5">{c.icon}</div>
              <div>
                <p className="text-xs font-medium">{c.name}</p>
                <p className="text-[11px] text-muted-foreground">{c.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
