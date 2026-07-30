"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function ComplianceSection({ data }: { data: PlatformSnapshot }) {
  const identity = data.identity as Record<string, unknown>;
  const compliance = (identity.compliance as { frameworks?: Array<{ id: string; name: string; description: string; controls?: Array<{ status: string }> }> }) ?? { frameworks: [] };
  const frameworks = compliance.frameworks ?? [];
  const [reports, setReports] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<string>("");

  async function loadReport(fwId: string) {
    setBusy(fwId);
    try {
      const res = await fetch(`/api/identity/compliance?framework=${fwId}`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) {
        setReports({ ...reports, [fwId]: json.data });
        toast.success("Report generated");
      } else {
        toast.error("Failed", { description: json.error?.message });
      }
    } catch {
      toast.error("Network error");
    }
    setBusy("");
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Compliance Readiness"
        subtitle="GDPR, HIPAA, SOC 2, ISO 27001, CCPA, PIPEDA — declarative mappings, not hardcoded rules. Each control maps to a platform feature. Data subject requests route to the privacy engine automatically."
        icon={<ShieldCheck className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Frameworks" value={frameworks.length} accent />
        <StatCard label="Controls Mapped" value={frameworks.reduce((a, f) => a + (f.controls?.length ?? 0), 0)} />
        <StatCard label="DSR Types" value={6} hint="access/rectify/erase/port/restrict/object" />
        <StatCard label="Breach Tracking" value="ready" hint="framework deadlines" />
      </div>

      <div className="space-y-3">
        {frameworks.map((fw) => {
          const controls = fw.controls ?? [];
          const implemented = controls.filter((c) => c.status === "implemented").length;
          const partial = controls.filter((c) => c.status === "partial").length;
          const readiness = controls.length > 0 ? Math.round((implemented / controls.length) * 100) : 0;
          const report = reports[fw.id];
          return (
            <Panel key={fw.id}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium">{fw.name}</h3>
                    <Badge variant="outline" className="text-[10px]">{controls.length} controls</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{fw.description}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs">
                    <span className="text-[var(--brand)]">{implemented} implemented</span>
                    <span className="text-amber-500">{partial} partial</span>
                    <span className="text-muted-foreground">{controls.length - implemented - partial} other</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-[var(--brand)]" style={{ width: `${readiness}%` }} />
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => loadReport(fw.id)} disabled={busy === fw.id}>
                  {busy === fw.id ? "Generating…" : "Generate report"}
                </Button>
              </div>
              {report ? (
                <div className="mt-3 rounded-md bg-muted/50 p-2 text-xs font-mono max-h-40 overflow-y-auto eks-scroll">
                  {JSON.stringify(report, null, 2)}
                </div>
              ) : null}
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
