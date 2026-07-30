"use client";

import { Activity, AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState, StateBadge } from "../primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function MonitoringSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const identity = data.identity as Record<string, unknown>;
  const monitoring = (identity.monitoring as {
    incidents?: Array<{ id: string; type?: string; severity: string; status: string; description?: string; createdAt: string; accountId?: string }>;
    openCount?: number;
  }) ?? { incidents: [], openCount: 0 };
  const incidents = monitoring.incidents ?? [];

  async function handleIncident(id: string, action: "acknowledge" | "resolve") {
    const res = await apiPost("/api/identity/monitoring", { incidentId: id, action });
    if (res.ok) {
      toast.success(action === "acknowledge" ? "Incident acknowledged" : "Incident resolved");
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Security Monitoring"
        subtitle="Real anomaly detection: impossible-travel (haversine), credential stuffing, abnormal API usage, permission abuse, data exfiltration, repeated MFA failures. Risk scoring, incident lifecycle, security notifications."
        icon={<Activity className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Open Incidents" value={monitoring.openCount ?? 0} accent />
        <StatCard label="Total Incidents" value={incidents.length} />
        <StatCard label="Detectors" value={9} hint="anomaly types" />
        <StatCard label="Impossible Travel" value="real" hint="haversine + speed" />
      </div>

      <Panel title="Anomaly Detectors">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            ["Impossible travel", "Haversine distance / time delta vs 900 km/h max"],
            ["Credential stuffing", "Burst of failed logins across accounts"],
            ["Abnormal API usage", ">600 calls/min per principal"],
            ["Permission abuse", "Privileged action volume spike"],
            ["Extension abuse", "Program exceeds granted scope"],
            ["Data exfiltration", ">500 MB/hour data volume"],
            ["Repeated MFA failure", "≥5 MFA failures"],
            ["High-risk new device", "Device risk score ≥50"],
            ["Unusual data volume", "Aggregate threshold breach"],
          ].map(([name, desc]) => (
            <div key={name} className="rounded-md border border-border/60 p-2.5">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <p className="text-xs font-medium">{name}</p>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Security Incidents">
        {incidents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)]">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium">No security incidents</p>
            <p className="text-xs text-muted-foreground">All clear. Anomalies will appear here when detected.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {incidents.map((inc) => (
              <div key={inc.id} className="rounded-md border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Badge variant={inc.severity === "critical" ? "destructive" : inc.severity === "high" ? "destructive" : "secondary"} className="text-[10px] uppercase">{inc.severity}</Badge>
                    <span className="text-sm font-medium">{inc.type ?? "anomaly"}</span>
                    <StateBadge state={inc.status} map={{ open: "destructive", investigating: "secondary", contained: "default", resolved: "default", false_positive: "secondary" }} />
                  </div>
                  <span className="text-xs text-muted-foreground">{new Date(inc.createdAt).toLocaleString()}</span>
                </div>
                {inc.description && <p className="text-xs text-muted-foreground mt-1">{inc.description}</p>}
                {inc.accountId && <Mono className="text-[10px] text-muted-foreground block mt-1">account: {inc.accountId.slice(0, 20)}…</Mono>}
                {(inc.status === "open" || inc.status === "investigating") && (
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" variant="outline" onClick={() => handleIncident(inc.id, "acknowledge")}>Acknowledge</Button>
                    <Button size="sm" onClick={() => handleIncident(inc.id, "resolve")}>Resolve</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
