"use client";

import { LineChart, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function TimelineSection({ data }: { data: PlatformSnapshot }) {
  const health = (data.health as Record<string, unknown>) ?? {};
  const measurementsData = (health.measurements as {
    stats?: { total?: number; bySchema?: Record<string, number>; dateRange?: { from: string; to: string } };
    recent?: Array<{ id: string; schemaId: string; value: unknown; unitSymbol: string; sourceLabel: string; verificationState: string; collectedAt: string; version: number }>;
  }) ?? {};
  const stats = measurementsData.stats ?? {};
  const recent = measurementsData.recent ?? [];
  const bySchema = stats.bySchema ?? {};

  // Group measurements by schema for timeline view
  const bySchemaMap = new Map<string, typeof recent>();
  for (const m of recent) {
    const list = bySchemaMap.get(m.schemaId) ?? [];
    list.push(m);
    bySchemaMap.set(m.schemaId, list);
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Measurement Timeline"
        subtitle="Every participant owns an immutable measurement timeline. Historical records, version history, corrections, superseded records, source tracking, time-travel queries, trend analysis. Nothing is permanently overwritten."
        icon={<LineChart className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Entries" value={stats.total ?? 0} accent />
        <StatCard label="Unique Schemas" value={Object.keys(bySchema).length} />
        <StatCard label="Date Range" value={stats.dateRange ? `${Math.round((new Date(stats.dateRange.to).getTime() - new Date(stats.dateRange.from).getTime()) / 86400000)}d` : "—"} hint={stats.dateRange ? new Date(stats.dateRange.from).toLocaleDateString() : undefined} />
        <StatCard label="Immutability" value="100%" hint="nothing overwritten" />
      </div>

      <Panel title="Timeline by Schema">
        {bySchemaMap.size === 0 ? <EmptyState message="No measurements yet. Record measurements to populate the timeline." /> : (
          <div className="space-y-4">
            {[...bySchemaMap.entries()].map(([schemaId, measurements]) => {
              const sorted = [...measurements].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
              const values = sorted.map((m) => typeof m.value === "number" ? m.value : Number(m.value)).filter((v) => !isNaN(v));
              const trend = values.length >= 2 ? values[0] - values[values.length - 1] : 0;
              const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;
              return (
                <div key={schemaId} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <Mono className="text-xs text-[var(--brand)]">{schemaId.slice(0, 24)}…</Mono>
                      <p className="text-xs text-muted-foreground mt-0.5">{measurements.length} measurements</p>
                    </div>
                    {values.length >= 2 && (
                      <div className="flex items-center gap-1.5">
                        <TrendIcon className={`h-4 w-4 ${trend > 0 ? "text-[var(--brand)]" : trend < 0 ? "text-destructive" : "text-muted-foreground"}`} />
                        <span className={`text-xs font-mono ${trend > 0 ? "text-[var(--brand)]" : trend < 0 ? "text-destructive" : "text-muted-foreground"}`}>
                          {trend > 0 ? "+" : ""}{trend.toFixed(1)}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-end gap-1 h-20">
                    {sorted.slice(0, 20).reverse().map((m) => {
                      const v = typeof m.value === "number" ? m.value : Number(m.value);
                      if (isNaN(v)) return <div key={m.id} className="flex-1 rounded-t bg-muted h-4" title={String(m.value)} />;
                      const max = Math.max(...values);
                      const min = Math.min(...values);
                      const range = max - min || 1;
                      const height = 20 + ((v - min) / range) * 60;
                      return (
                        <div
                          key={m.id}
                          className="flex-1 rounded-t bg-[var(--brand)]/70 hover:bg-[var(--brand)] transition-colors min-w-[8px]"
                          style={{ height: `${height}px` }}
                          title={`${v} ${m.unitSymbol} — ${new Date(m.collectedAt).toLocaleDateString()}`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
                    <span>{sorted.length > 0 ? new Date(sorted[sorted.length - 1].collectedAt).toLocaleDateString() : "—"}</span>
                    <span>{sorted.length > 0 ? new Date(sorted[0].collectedAt).toLocaleDateString() : "—"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Timeline Properties">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            ["Historical records", "All past measurements preserved"],
            ["Version history", "Every correction creates a new version"],
            ["Superseded records", "Old values linked to replacements, never deleted"],
            ["Source tracking", "Each entry records its origin"],
            ["Time-travel queries", "Snapshot at any past timestamp"],
            ["Trend analysis", "Linear regression slope + change %"],
            ["Corrections", "New version supersedes the old"],
            ["Rollback", "Revert to any prior version"],
            ["Immutable", "Nothing is permanently overwritten"],
          ].map(([name, desc]) => (
            <div key={name} className="rounded-md border border-border/40 p-2.5">
              <p className="text-xs font-medium">{name}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
