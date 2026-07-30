"use client";

import { BarChart3, Trophy, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function LeaderboardsSection({ data }: { data: PlatformSnapshot }) {
  const comps = (data.competitions as {
    leaderboards?: Array<{ id: string; competitionId: string; name: string; scope: string; rankingMethod: string; entryCount: number }>;
    rewardSchedules?: Array<{ id: string; name: string; type: string; podiumSize: number }>;
  }) ?? {};
  const leaderboards = comps.leaderboards ?? [];
  const rewardSchedules = comps.rewardSchedules ?? [];

  const rankingMethods = ["highest_score", "most_improved", "fastest_improvement", "consistency", "percentile", "elo_rating", "tier_ranking", "hybrid"];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Leaderboards & Ranking"
        subtitle="Programs define leaderboard strategies (global, country, city, org, gender, age, BMI, risk profile, custom). A single competition may generate thousands of leaderboards. Multiple ranking methods: highest score, most improved, Elo, percentile, tier, hybrid."
        icon={<BarChart3 className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Leaderboards" value={leaderboards.length} accent />
        <StatCard label="Total Entries" value={leaderboards.reduce((a, l) => a + l.entryCount, 0)} />
        <StatCard label="Reward Schedules" value={rewardSchedules.length} />
        <StatCard label="Ranking Methods" value={rankingMethods.length} />
      </div>

      <Panel title="Leaderboard Registry">
        {leaderboards.length === 0 ? <EmptyState message="No leaderboards yet. Create a competition to generate leaderboards." /> : (
          <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Leaderboard</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Ranking Method</TableHead>
                  <TableHead>Entries</TableHead>
                  <TableHead className="pr-4">Competition</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaderboards.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="pl-4">
                      <div className="font-medium text-sm">{l.name}</div>
                      <Mono className="text-muted-foreground">{l.id.slice(0, 20)}…</Mono>
                    </TableCell>
                    <TableCell><Badge variant="outline" className="text-[10px] font-mono">{l.scope}</Badge></TableCell>
                    <TableCell><Mono className="text-xs">{l.rankingMethod}</Mono></TableCell>
                    <TableCell><Mono className="text-xs">{l.entryCount}</Mono></TableCell>
                    <TableCell className="pr-4"><Mono className="text-xs">{l.competitionId.slice(0, 16)}…</Mono></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Ranking Methods">
          <div className="grid grid-cols-2 gap-2">
            {rankingMethods.map((m) => (
              <div key={m} className="rounded-md border border-border/60 p-2.5">
                <Mono className="text-xs text-[var(--brand)]">{m}</Mono>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {m === "highest_score" && "Sort by score descending"}
                  {m === "most_improved" && "Sort by improvement delta"}
                  {m === "fastest_improvement" && "Sort by improvement rate"}
                  {m === "consistency" && "Sort by lowest variance"}
                  {m === "percentile" && "Assign percentile ranks"}
                  {m === "elo_rating" && "Elo expected-score formula"}
                  {m === "tier_ranking" && "Group by division, rank within"}
                  {m === "hybrid" && "Weighted combination of methods"}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Dynamic Segmentation">
          <p className="text-xs text-muted-foreground mb-2">Programs define segmentation rules. A single competition auto-generates thousands of leaderboards:</p>
          <div className="flex flex-wrap gap-1.5">
            {["global", "country", "state", "city", "district", "organization", "company", "school", "gender", "age", "bmi_category", "risk_profile", "occupation", "custom"].map((s) => (
              <Badge key={s} variant="outline" className="text-[10px] font-mono">{s}</Badge>
            ))}
          </div>
          <div className="mt-3 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Example Segments</p>
            {["Women aged 18–30", "Men over 60", "Healthcare workers", "BMI > 30", "University students", "Participants in Ghana", "West Africa region"].map((s) => (
              <div key={s} className="flex items-center gap-1.5 text-xs">
                <Trophy className="h-3 w-3 text-[var(--brand)]" />
                <span>{s}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Podium Visualization (demo)">
        <div className="flex items-end justify-center gap-3 h-40">
          {[
            { rank: 2, height: 60, pct: "20%", color: "bg-slate-400" },
            { rank: 1, height: 90, pct: "30%", color: "bg-amber-500" },
            { rank: 3, height: 40, pct: "15%", color: "bg-orange-700" },
            { rank: 4, height: 25, pct: "10%", color: "bg-muted" },
            { rank: 5, height: 15, pct: "5%", color: "bg-muted" },
          ].map((p) => (
            <div key={p.rank} className="flex flex-col items-center">
              <span className="text-xs font-mono mb-1">{p.pct}</span>
              <div className={`w-16 rounded-t ${p.color} flex items-start justify-center pt-2`} style={{ height: `${p.height * 1.5}px` }}>
                <span className="text-white font-bold text-lg">#{p.rank}</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
