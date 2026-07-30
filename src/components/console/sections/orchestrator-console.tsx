"use client";

import { Network, Brain, Calendar, ShieldCheck, TrendingUp, Activity, Zap, Layers } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function OrchestratorSection({ data }: { data: PlatformSnapshot }) {
  const o = (data.orchestrator as Record<string, unknown>) ?? {};
  const twin = (o.twin as { totalTwins?: number; totalContributions?: number; avgVersion?: number }) ?? {};
  const conflicts = (o.conflicts as { total?: number; autoResolved?: number; participantDecided?: number }) ?? {};
  const workload = (o.workload as { totalAssessments?: number; avgMinutes?: number }) ?? {};
  const coordinator = (o.coordinator as { totalDecisions?: number; avgConfidence?: number }) ?? {};
  const timeline = (o.timeline as { totalTimelines?: number; totalEntries?: number }) ?? {};
  const sharedGoals = (o.sharedGoals as { total?: number; achieved?: number; avgContributors?: number }) ?? {};
  const sharedMeasurements = (o.sharedMeasurements as { total?: number; avgConsumingPrograms?: number; deduplicationSavings?: number }) ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Health Orchestrator & Digital Twin"
        subtitle="Transforms independent Programs into one coordinated Health Operating System. Programs remain autonomous but cooperate through a neutral orchestration layer. The Digital Twin is a real-time representation of the participant's health state. AI coordinates recommendations, schedules, measurements, and goals while remaining transparent and explainable."
        icon={<Network className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Digital Twins" value={twin.totalTwins ?? 0} hint={`${twin.totalContributions ?? 0} contributions`} accent />
        <StatCard label="Conflicts Resolved" value={conflicts.total ?? 0} hint={`${conflicts.autoResolved ?? 0} auto-resolved`} />
        <StatCard label="Coordinator Decisions" value={coordinator.totalDecisions ?? 0} hint={`avg confidence: ${coordinator.avgConfidence?.toFixed(2) ?? "—"}`} />
        <StatCard label="Timeline Entries" value={timeline.totalEntries ?? 0} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Shared Goals" value={sharedGoals.total ?? 0} hint={`${sharedGoals.achieved ?? 0} achieved`} />
        <StatCard label="Shared Measurements" value={sharedMeasurements.total ?? 0} hint={`${sharedMeasurements.deduplicationSavings ?? 0} deduped`} />
        <StatCard label="Workload Assessments" value={workload.totalAssessments ?? 0} hint={`avg: ${workload.avgMinutes?.toFixed(0) ?? "—"} min`} />
        <StatCard label="Twin Avg Version" value={twin.avgVersion?.toFixed(0) ?? "—"} hint="updates per twin" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Digital Health Twin">
          <p className="text-xs text-muted-foreground mb-3">A continuously evolving real-time representation of the participant's health state. Built from verified measurements, program progress, mission completion, competition history, technician observations, wearable data, goals, preferences, and consent. The Twin belongs to the participant.</p>
          <div className="space-y-2">
            {[
              { icon: <Activity className="h-3.5 w-3.5" />, name: "Verified Measurements", desc: "Real-time measurement state with trends" },
              { icon: <TrendingUp className="h-3.5 w-3.5" />, name: "Program Progress", desc: "Completion rates, active missions, streaks" },
              { icon: <ShieldCheck className="h-3.5 w-3.5" />, name: "Risk Indicators", desc: "Low/medium/high risk with detail" },
              { icon: <Brain className="h-3.5 w-3.5" />, name: "Fatigue Score", desc: "0-100, prevents overload" },
              { icon: <Layers className="h-3.5 w-3.5" />, name: "Program Contributions", desc: "Each Program adds to the Twin" },
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

        <Panel title="Cross-Program Intelligence">
          <p className="text-xs text-muted-foreground mb-3">The platform coordinates Programs without direct coupling:</p>
          <div className="space-y-2">
            {[
              { icon: <Calendar className="h-3.5 w-3.5" />, name: "Cross-Program Scheduler", desc: "Merges Program schedules into unified routines (Morning Health Session = walk + yoga + measurement)" },
              { icon: <ShieldCheck className="h-3.5 w-3.5" />, name: "Conflict Resolution", desc: "Detects & resolves: high-intensity vs recovery, low-carb vs high-carb, late workout vs sleep" },
              { icon: <TrendingUp className="h-3.5 w-3.5" />, name: "Workload Balancer", desc: "Prevents overload — sums time, physical, mental, recovery, complexity across Programs" },
              { icon: <Brain className="h-3.5 w-3.5" />, name: "AI Coordinator", desc: "Merges recommendations, detects duplication, explains trade-offs — never replaces Program AI" },
              { icon: <Layers className="h-3.5 w-3.5" />, name: "Shared Measurement Registry", desc: "5 Programs need weight → measure once → authorized Programs consume" },
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

      <Panel title="Unified Timeline">
        <p className="text-xs text-muted-foreground mb-3">A global chronological timeline combining every platform event into one experience:</p>
        <div className="flex flex-wrap gap-1.5">
          {["measurement", "mission", "competition", "reward", "appointment", "research", "installation", "achievement", "recommendation", "milestone", "orchestration", "technician_visit"].map((t) => (
            <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
          ))}
        </div>
      </Panel>

      <Panel title="Orchestration Philosophy">
        <div className="rounded-md border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-3">
          <div className="flex items-start gap-2">
            <Zap className="h-4 w-4 text-[var(--brand)] mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-[var(--brand)]">Programs remain independent — the platform coordinates</p>
              <p className="text-xs text-muted-foreground mt-1">
                Programs never communicate directly. All coordination happens through platform services.
                Programs expose capabilities, goals, constraints, dependencies, preferred schedules, required
                measurements, and expected outcomes. The Orchestrator combines them into one coherent
                experience. The AI Coordinator merges recommendations, resolves conflicts, detects
                duplication, and optimizes schedules — but never replaces Program AI. Every decision is
                explainable: participants always understand why today's plan changed, which Programs
                contributed, and which conflicts were resolved.
              </p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
