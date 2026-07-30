"use client";

import { useState, useEffect } from "react";
import { Package, ArrowLeft, BadgeCheck, ShieldCheck, Cpu, Play, Pause } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard, EmptyState } from "../primitives";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function ProgramDetailSection({
  data,
  onRefresh,
  programId,
  onBack,
}: {
  data: PlatformSnapshot;
  onRefresh: () => void;
  programId: string | null;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const programs = (data.programs as { programs?: Array<{ id: string; name: string; slug: string; state: string; category: string }> }).programs ?? [];
  const program = programs.find((p) => p.id === programId);
  const observability = ((data.programs as { observability?: Array<{ programId: string; programName: string; health?: string; errorCount?: number; crashCount?: number; avgLatencyMs?: number; p95LatencyMs?: number; installCount?: number }> }).observability ?? []).find((o) => o.programId === programId);

  async function loadDetail() {
    if (!programId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/programs/${programId}`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setDetail(json.data);
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function certify() {
    if (!programId) return;
    setBusy(true);
    const res = await apiPost<{ status: string; passed: number; failed: number }>(`/api/programs/${programId}/certify`);
    setBusy(false);
    if (res.ok && res.data) {
      toast.success(`Certification ${res.data.status}`, { description: `${res.data.passed} passed, ${res.data.failed} failed` });
      onRefresh();
      loadDetail();
    } else {
      toast.error("Certification failed", { description: res.error?.message });
    }
  }

  async function transition(to: string) {
    if (!programId) return;
    setBusy(true);
    const res = await apiPost<{ state: string }>(`/api/programs/${programId}/transition`, { to });
    setBusy(false);
    if (res.ok) {
      toast.success(`State → ${res.data?.state}`);
      onRefresh();
      loadDetail();
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  // Auto-load detail on programId change (lazy fetch, no separate loading state)
  useEffect(() => {
    if (!programId || detail) return;
    let cancelled = false;
    fetch(`/api/programs/${programId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => { if (!cancelled && json.ok) setDetail(json.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [programId, detail]);

  if (!programId || !program) {
    return (
      <div className="space-y-6">
        <SectionHeader title="Program Details" subtitle="Select a program from the Programs list." icon={<Package className="h-5 w-5" />} />
        <EmptyState message="No program selected. Go to Programs and click one." />
      </div>
    );
  }

  const versions = (detail?.versions as Array<{ id: string; version: string; channel: string; certified: boolean; fingerprint: string; createdAt: string; capabilities: string[]; resourceLimits: Record<string, number>; privacy: { dataCollected: string[]; retentionDays: number }; aiUsage: { usesAI: boolean } }>) ?? [];
  const quota = detail?.effectiveQuota as Record<string, number> | undefined;

  return (
    <div className="space-y-6">
      <SectionHeader
        title={program.name}
        subtitle={`Category: ${program.category} · Slug: ${program.slug}`}
        icon={<Package className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5 mr-1.5" />Back</Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="State" value={<StateBadge state={program.state} map={{ draft: "secondary", published: "default", certified: "default", active: "default", deprecated: "secondary", rejected: "destructive" }} />} />
        <StatCard label="Versions" value={versions.length} />
        <StatCard label="Health" value={observability?.health ?? "—"} accent />
        <StatCard label="Installs" value={observability?.installCount ?? 0} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={certify} disabled={busy}><BadgeCheck className="h-4 w-4 mr-1.5" />Run Certification</Button>
        {program.state === "certified" && <Button onClick={() => transition("published")} disabled={busy}>Publish</Button>}
        {program.state === "published" && <Button variant="outline" onClick={() => transition("deprecated")} disabled={busy}>Deprecate</Button>}
        {program.state === "active" && <Button variant="outline" onClick={() => transition("paused")} disabled={busy}><Pause className="h-3.5 w-3.5 mr-1.5" />Pause</Button>}
        {program.state === "paused" && <Button onClick={() => transition("active")} disabled={busy}><Play className="h-3.5 w-3.5 mr-1.5" />Resume</Button>}
      </div>

      <Panel title="Versions">
        {loading && !detail ? <EmptyState message="Loading…" /> : versions.length === 0 ? <EmptyState message="No versions" /> : (
          <div className="space-y-2">
            {versions.map((v) => (
              <div key={v.id} className="rounded-md border border-border/60 p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Mono className="text-[var(--brand)]">v{v.version}</Mono>
                    <Badge variant="outline" className="text-[10px]">{v.channel}</Badge>
                    {v.certified && <Badge className="bg-[var(--brand)] text-[var(--brand-foreground)] text-[10px]"><BadgeCheck className="h-3 w-3 mr-0.5" />certified</Badge>}
                  </div>
                  <Mono className="text-[10px] text-muted-foreground">{v.fingerprint}…</Mono>
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {v.capabilities.map((c) => <Mono key={c} className="text-[10px] text-muted-foreground">{c}</Mono>)}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2 text-xs">
                  <div><span className="text-muted-foreground">Memory:</span> <Mono>{v.resourceLimits?.memoryMb ?? "—"}MB</Mono></div>
                  <div><span className="text-muted-foreground">Retention:</span> <Mono>{v.privacy?.retentionDays ?? "—"}d</Mono></div>
                  <div><span className="text-muted-foreground">AI:</span> <Mono>{v.aiUsage?.usesAI ? "yes" : "no"}</Mono></div>
                  <div><span className="text-muted-foreground">Data:</span> <Mono>{v.privacy?.dataCollected?.length ?? 0} fields</Mono></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Effective Resource Quota">
          {quota ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {Object.entries(quota).map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-border/40 py-1.5">
                  <span className="text-muted-foreground font-mono">{k}</span>
                  <Mono>{String(v)}</Mono>
                </div>
              ))}
            </div>
          ) : <EmptyState message="No quota data" />}
        </Panel>

        <Panel title="Observability">
          {observability ? (
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">Health</span><span className={observability.health === "healthy" ? "text-[var(--brand)]" : "text-amber-500"}>{observability.health}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Errors</span><Mono>{observability.errorCount}</Mono></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Crashes</span><Mono>{observability.crashCount}</Mono></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Avg latency</span><Mono>{observability.avgLatencyMs ?? "—"}ms</Mono></div>
              <div className="flex justify-between"><span className="text-muted-foreground">P95 latency</span><Mono>{observability.p95LatencyMs ?? "—"}ms</Mono></div>
            </div>
          ) : <EmptyState message="No observability data" />}
        </Panel>
      </div>
    </div>
  );
}
