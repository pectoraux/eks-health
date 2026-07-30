"use client";

import { BadgeCheck, ShieldCheck, AlertCircle, RefreshCw } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface CertRule { id: string; category: string; severity: string; description: string }
interface CertRun { id: string; programId: string; versionId: string; status: string; startedAt: string }

export function CertificationSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const cert = (data.programs as { certification?: { rules?: CertRule[]; runs?: CertRun[] } }).certification ?? {};
  const rules = cert.rules ?? [];
  const runs = cert.runs ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Certification Pipeline"
        subtitle="Before publication, every Program undergoes automated review: manifest correctness, security, permissions, performance, resource usage, API compatibility, privacy, dependencies, static analysis, malicious behavior. Only certified Programs can be listed publicly."
        icon={<BadgeCheck className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Certification Rules" value={rules.length} accent />
        <StatCard label="Total Runs" value={runs.length} />
        <StatCard label="Passed" value={runs.filter((r) => r.status === "passed").length} />
        <StatCard label="Failed" value={runs.filter((r) => r.status === "failed").length} />
      </div>

      <Panel title="Certification Rules">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-96 overflow-y-auto eks-scroll">
          {rules.map((r) => (
            <div key={r.id} className={`rounded-md border p-2.5 ${r.severity === "critical" ? "border-red-500/30 bg-red-500/5" : r.severity === "high" ? "border-amber-500/30 bg-amber-500/5" : "border-border/60"}`}>
              <div className="flex items-center justify-between gap-1">
                <Mono className="text-[10px] text-muted-foreground">{r.category}</Mono>
                <Badge variant={r.severity === "critical" || r.severity === "high" ? "destructive" : "secondary"} className="text-[10px]">{r.severity}</Badge>
              </div>
              <p className="text-xs font-medium mt-1">{r.id}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{r.description}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Recent Certification Runs">
        {runs.length === 0 ? <EmptyState message="No certification runs yet. Open a program and click 'Run Certification'." /> : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-border/40 p-2 text-xs">
                <div className="flex items-center gap-2">
                  {r.status === "passed" ? <BadgeCheck className="h-3.5 w-3.5 text-[var(--brand)]" /> : r.status === "failed" ? <AlertCircle className="h-3.5 w-3.5 text-destructive" /> : <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />}
                  <Mono className="text-muted-foreground">{r.programId.slice(0, 20)}…</Mono>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={r.status === "passed" ? "default" : r.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">{r.status}</Badge>
                  <span className="text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
