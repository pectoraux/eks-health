"use client";

import { Trophy, Calendar, Layers, BarChart3, ShieldCheck } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface CompRow {
  id: string; slug: string; name: string; scope: string; state: string;
  programId: string; currentParticipants: number; maxParticipants?: number;
  startsAt?: string; endsAt?: string; divisionCount: number; seasonCount: number;
  tags: string[]; createdAt: string;
}

export function CompetitionsSection({ data }: { data: PlatformSnapshot }) {
  const comps = (data.competitions as {
    competitions?: CompRow[];
    competitionStats?: { total?: number; byState?: Record<string, number>; byScope?: Record<string, number>; totalParticipants?: number };
    seasons?: Array<{ id: string; name: string; type: string; state: string; sequence: number; startsAt: string; endsAt: string }>;
    seasonStats?: { total?: number; active?: number; upcoming?: number; archived?: number };
    divisions?: Array<{ id: string; name: string; tier: string; minScore?: number; maxScore?: number }>;
    divisionStats?: { total?: number; byTier?: Record<string, number> };
    scoreSpecs?: Array<{ id: string; name: string; description: string; version: number; componentCount: number; totalWeight: number; components?: Array<{ name: string; weight: number; type: string; aggregation: string }> }>;
    antiCheatStats?: { totalFlags?: number; openFlags?: number; confirmedFraud?: number };
  }) ?? {};
  const compList = comps.competitions ?? [];
  const stats = comps.competitionStats ?? {};
  const seasons = comps.seasons ?? [];
  const seasonStats = comps.seasonStats ?? {};
  const divisions = comps.divisions ?? [];
  const divisionStats = comps.divisionStats ?? {};
  const scoreSpecs = comps.scoreSpecs ?? [];
  const antiCheatStats = comps.antiCheatStats ?? {};

  const stateMap: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default", draft: "secondary", scheduled: "secondary", registration: "secondary",
    qualification: "secondary", paused: "destructive", completed: "default",
    archived: "secondary", cancelled: "destructive",
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Competition Platform"
        subtitle="The health economy that rewards better outcomes. Programs create fully configurable competitions — global, national, regional, corporate. Verified measurements automatically update scores and rankings. NOT a leaderboard app — a programmable competitive engine."
        icon={<Trophy className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Competitions" value={stats.total ?? 0} accent />
        <StatCard label="Participants" value={stats.totalParticipants ?? 0} />
        <StatCard label="Seasons" value={seasonStats.total ?? 0} hint={`${seasonStats.active ?? 0} active`} />
        <StatCard label="Divisions" value={divisionStats.total ?? 0} />
      </div>

      <Panel title="Competition Registry">
        <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Competition</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Participants</TableHead>
                <TableHead>Divisions</TableHead>
                <TableHead>Seasons</TableHead>
                <TableHead className="pr-4">Tags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {compList.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm">{c.name}</div>
                    <Mono className="text-muted-foreground">{c.slug}</Mono>
                  </TableCell>
                  <TableCell><span className="text-xs font-mono">{c.scope}</span></TableCell>
                  <TableCell><StateBadge state={c.state} map={stateMap} /></TableCell>
                  <TableCell>
                    <span className="text-xs font-medium">{c.currentParticipants}</span>
                    {c.maxParticipants && <span className="text-xs text-muted-foreground">/{c.maxParticipants}</span>}
                  </TableCell>
                  <TableCell><Mono className="text-xs">{c.divisionCount}</Mono></TableCell>
                  <TableCell><Mono className="text-xs">{c.seasonCount}</Mono></TableCell>
                  <TableCell className="pr-4">
                    <div className="flex flex-wrap gap-0.5">
                      {c.tags.slice(0, 2).map((t) => <Mono key={t} className="text-[10px] text-muted-foreground">{t}</Mono>)}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Seasons">
          <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll">
            {seasons.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                <div className="flex items-center gap-2">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{s.name}</span>
                  <Badge variant="outline" className="text-[10px]">{s.type}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">#{s.sequence}</span>
                  <StateBadge state={s.state} map={{ active: "default", upcoming: "secondary", archived: "secondary", cancelled: "destructive" }} />
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Divisions & Leagues">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {divisions.map((d) => (
              <div key={d.id} className="rounded-md border border-border/60 p-2.5 text-center">
                <p className="text-sm font-medium">{d.name}</p>
                <Badge variant="outline" className="text-[10px] mt-1 capitalize">{d.tier}</Badge>
                {d.minScore !== undefined && d.maxScore !== undefined && (
                  <p className="text-[10px] text-muted-foreground mt-1">{d.minScore}–{d.maxScore}</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Health Score Compiler">
        <p className="text-xs text-muted-foreground mb-3">Programs define scoring formulas as weighted components. The platform validates and executes the specification — no arbitrary code.</p>
        {scoreSpecs.length === 0 ? <p className="text-xs text-muted-foreground">No score specs defined.</p> : (
          <div className="space-y-3">
            {scoreSpecs.map((spec) => (
              <div key={spec.id} className="rounded-md border border-border/60 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium">{spec.name}</p>
                    <p className="text-xs text-muted-foreground">{spec.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">v{spec.version}</Badge>
                    <Badge variant="outline" className="text-[10px]">{spec.componentCount} components</Badge>
                  </div>
                </div>
                {spec.components && (
                  <div className="space-y-1">
                    {spec.components.map((c) => (
                      <div key={c.name} className="flex items-center gap-2">
                        <div className="flex-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium">{c.name}</span>
                            <span className="text-[var(--brand)] font-mono">{c.weight}%</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden mt-0.5">
                            <div className="h-full bg-[var(--brand)]" style={{ width: `${c.weight}%` }} />
                          </div>
                        </div>
                        <Mono className="text-[10px] text-muted-foreground w-24 text-right">{c.aggregation}</Mono>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Anti-Cheating Framework">
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center rounded-md border border-border/60 p-2.5">
            <p className="text-lg font-semibold">{antiCheatStats.totalFlags ?? 0}</p>
            <Mono className="text-[10px] text-muted-foreground">total flags</Mono>
          </div>
          <div className="text-center rounded-md border border-border/60 p-2.5">
            <p className="text-lg font-semibold text-amber-500">{antiCheatStats.openFlags ?? 0}</p>
            <Mono className="text-[10px] text-muted-foreground">open</Mono>
          </div>
          <div className="text-center rounded-md border border-border/60 p-2.5">
            <p className="text-lg font-semibold text-destructive">{antiCheatStats.confirmedFraud ?? 0}</p>
            <Mono className="text-[10px] text-muted-foreground">confirmed</Mono>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          {["score_validation", "duplicate_detection", "rapid_improvement", "collusion_suspected", "abnormal_ranking", "statistical_outlier", "measurement_validation"].map((t) => (
            <div key={t} className="flex items-center gap-1.5 text-xs">
              <ShieldCheck className="h-3 w-3 text-[var(--brand)]" />
              <Mono className="text-[10px] text-muted-foreground">{t}</Mono>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
