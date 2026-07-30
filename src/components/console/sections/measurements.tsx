"use client";

import { useState } from "react";
import { Activity, RefreshCw, Plus } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, StateBadge, EmptyState } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function MeasurementsSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const health = (data.health as Record<string, unknown>) ?? {};
  const measurementsData = (health.measurements as {
    stats?: { total?: number; bySchema?: Record<string, number>; byVerification?: Record<string, number>; bySource?: Record<string, number> };
    recent?: Array<{ id: string; schemaId: string; value: unknown; unitSymbol: string; sourceLabel: string; sourceType: string; verificationState: string; collectedAt: string; version: number; superseded: boolean }>;
  }) ?? {};
  const stats = measurementsData.stats ?? {};
  const recent = measurementsData.recent ?? [];
  const schemas = (health.schemas as Array<{ id: string; slug: string; name: string; allowedUnits: string[] }>) ?? [];
  const sources = (health.sources as Array<{ id: string; label: string; type: string }>) ?? [];

  const [showRecord, setShowRecord] = useState(false);
  const [form, setForm] = useState({ schemaId: "", value: "", unitId: "", sourceId: "", profileId: "prof_demo_1", collectedBy: "acc_demo_1" });
  const [busy, setBusy] = useState(false);

  async function record() {
    setBusy(true);
    const value = isNaN(Number(form.value)) ? form.value : Number(form.value);
    const res = await apiPost<{ measurementId: string; verificationState: string }>("/api/health/measurements", {
      schemaId: form.schemaId, profileId: form.profileId, value, unitId: form.unitId,
      sourceId: form.sourceId, collectedBy: form.collectedBy,
    });
    setBusy(false);
    if (res.ok && res.data) {
      toast.success("Measurement recorded", { description: `State: ${res.data.verificationState}` });
      setShowRecord(false);
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.userMessage ?? res.error?.message });
    }
  }

  const byVerification = stats.byVerification ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Measurements"
        subtitle="The core measurement store. Immutable timeline with version history, corrections, supersession, source tracking, time-travel queries, and trend analysis. Nothing is permanently overwritten."
        icon={<Activity className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>
            <Button size="sm" onClick={() => setShowRecord(!showRecord)}><Plus className="h-3.5 w-3.5 mr-1.5" />Record</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Measurements" value={stats.total ?? 0} accent />
        <StatCard label="Verified" value={byVerification.verified ?? 0} />
        <StatCard label="Pending" value={byVerification.pending ?? 0} />
        <StatCard label="Schemas" value={Object.keys(stats.bySchema ?? {}).length} />
      </div>

      {showRecord && (
        <Panel title="Record a measurement">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Schema</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.schemaId} onChange={(e) => {
                const sch = schemas.find((s) => s.id === e.target.value);
                setForm({ ...form, schemaId: e.target.value, unitId: sch?.allowedUnits[0] ?? "" });
              }}>
                <option value="">Select schema…</option>
                {schemas.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div><Label>Value</Label><Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="68" /></div>
            <div>
              <Label>Unit</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
                <option value="">Select unit…</option>
                {schemas.find((s) => s.id === form.schemaId)?.allowedUnits.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div>
              <Label>Source</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.sourceId} onChange={(e) => setForm({ ...form, sourceId: e.target.value })}>
                <option value="">Select source…</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.type})</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button onClick={record} disabled={busy || !form.schemaId || !form.value || !form.unitId || !form.sourceId}>{busy ? "Recording…" : "Record measurement"}</Button>
            <Button variant="outline" onClick={() => setShowRecord(false)}>Cancel</Button>
          </div>
        </Panel>
      )}

      <Panel title="By Verification State">
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {["pending", "verified", "rejected", "expired", "disputed", "superseded"].map((state) => (
            <div key={state} className="rounded-md border border-border/60 p-2.5 text-center">
              <p className="text-lg font-semibold">{byVerification[state] ?? 0}</p>
              <Mono className="text-[10px] text-muted-foreground">{state}</Mono>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Recent Measurements">
        {recent.length === 0 ? <EmptyState message="No measurements yet. Record one to get started." /> : (
          <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Value</TableHead>
                  <TableHead>Schema</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Collected</TableHead>
                  <TableHead className="pr-4">Version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="pl-4">
                      <span className="font-mono text-sm font-medium">{String(m.value)}</span>
                      <Mono className="text-[10px] text-muted-foreground block">{m.unitSymbol}</Mono>
                    </TableCell>
                    <TableCell><Mono className="text-xs">{m.schemaId.slice(0, 20)}…</Mono></TableCell>
                    <TableCell>
                      <div className="text-xs">{m.sourceLabel}</div>
                      <Mono className="text-[10px] text-muted-foreground">{m.sourceType}</Mono>
                    </TableCell>
                    <TableCell><StateBadge state={m.verificationState} map={{ verified: "default", pending: "secondary", rejected: "destructive", expired: "secondary", disputed: "destructive", superseded: "secondary" }} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(m.collectedAt).toLocaleString()}</TableCell>
                    <TableCell className="pr-4"><Mono className="text-xs">v{m.version}</Mono>{m.superseded && <span className="text-[10px] text-muted-foreground block">superseded</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}
