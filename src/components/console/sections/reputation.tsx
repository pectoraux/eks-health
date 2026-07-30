"use client";

import { Star, TrendingUp, TrendingDown, Minus, ShieldCheck, AlertTriangle } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface RepRow {
  technicianId: string; technicianName?: string; overallScore: number;
  trend: string; reviewCount: number; positiveCount: number; negativeCount: number;
}

export function ReputationSection({ data }: { data: PlatformSnapshot }) {
  const techs = (data.technicians as { reputation?: { profiles?: RepRow[] }; disputes?: { stats?: { total?: number; resolved?: number; overturned?: number }; recent?: Array<{ status: string; reason: string }> }; fraud?: { stats?: { totalAlerts?: number; confirmedFraud?: number } } }) ?? {};
  const profiles = techs.reputation?.profiles ?? [];
  const disputeStats = techs.disputes?.stats ?? {};
  const fraudStats = techs.fraud?.stats ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Reputation System"
        subtitle="Trust and reputation engine tracking accuracy, consistency, participant feedback, verification quality, dispute rate, completion rate, response time, fraud indicators, and platform violations. Programs may incorporate reputation into eligibility decisions."
        icon={<Star className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Avg Score" value={profiles.length > 0 ? (profiles.reduce((a, p) => a + p.overallScore, 0) / profiles.length).toFixed(1) : "—"} accent />
        <StatCard label="Total Reviews" value={profiles.reduce((a, p) => a + p.reviewCount, 0)} />
        <StatCard label="Disputes" value={disputeStats.total ?? 0} hint={`${disputeStats.overturned ?? 0} overturned`} />
        <StatCard label="Fraud Alerts" value={fraudStats.totalAlerts ?? 0} />
      </div>

      <Panel title="Technician Reputation">
        {profiles.length === 0 ? <EmptyState message="No reputation profiles yet. Technicians earn reputation through verified sessions." /> : (
          <div className="space-y-2">
            {profiles.map((p) => {
              const TrendIcon = p.trend === "improving" ? TrendingUp : p.trend === "declining" ? TrendingDown : Minus;
              const trendColor = p.trend === "improving" ? "text-[var(--brand)]" : p.trend === "declining" ? "text-destructive" : "text-muted-foreground";
              return (
                <div key={p.technicianId} className="flex items-center justify-between rounded-md border border-border/60 p-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)]">
                      <Star className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{p.technicianName ?? p.technicianId.slice(0, 20)}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted-foreground">{p.reviewCount} reviews</span>
                        <span className="text-xs text-[var(--brand)]">{p.positiveCount} positive</span>
                        {p.negativeCount > 0 && <span className="text-xs text-destructive">{p.negativeCount} negative</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-2xl font-semibold">{p.overallScore.toFixed(0)}</p>
                      <p className="text-[10px] text-muted-foreground">/ 100</p>
                    </div>
                    <div className={`flex items-center gap-1 ${trendColor}`}>
                      <TrendIcon className="h-4 w-4" />
                      <span className="text-xs">{p.trend}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Reputation Factors">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              ["accuracy", 20, "Measurement accuracy"],
              ["verification_quality", 15, "Verified vs total"],
              ["dispute_rate", 15, "Disputes per session"],
              ["completion_rate", 10, "Sessions completed"],
              ["participant_feedback", 15, "Participant ratings"],
              ["response_time", 5, "Booking response speed"],
              ["fraud_indicators", 10, "Fraud alerts"],
              ["platform_violations", 5, "Policy violations"],
              ["certification_history", 5, "Cert maintenance"],
            ].map(([factor, weight, desc]) => (
              <div key={factor as string} className="rounded-md border border-border/40 p-2.5">
                <div className="flex items-center justify-between">
                  <Mono className="text-[10px] text-[var(--brand)]">{factor}</Mono>
                  <span className="text-[10px] text-muted-foreground">{weight}%</span>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Trust Indicators">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 p-2.5">
              <ShieldCheck className="h-4 w-4 text-[var(--brand)]" />
              <div>
                <p className="text-xs font-medium">Chain of Custody</p>
                <p className="text-[11px] text-muted-foreground">Every verified measurement has a sealed, traceable chain</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 p-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <div>
                <p className="text-xs font-medium">Fraud Detection</p>
                <p className="text-[11px] text-muted-foreground">7 detectors: improbable improvement, duplicate evidence, device anomalies, collusion, impossible travel</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 rounded-md border border-border/40 p-2.5">
              <Star className="h-4 w-4 text-[var(--brand)]" />
              <div>
                <p className="text-xs font-medium">Weighted Scoring</p>
                <p className="text-[11px] text-muted-foreground">9-factor weighted average with time decay (90-day half-life)</p>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
