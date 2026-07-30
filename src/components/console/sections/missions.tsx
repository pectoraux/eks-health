"use client";

import { Target, CheckCircle2, Flame, TrendingUp, BookOpen, Zap } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function MissionsSection({ data }: { data: PlatformSnapshot }) {
  const m = (data.missions as {
    missions?: {
      stats?: { total?: number; active?: number; completed?: number; skipped?: number; expired?: number; completionRate?: number; byCategory?: Record<string, number> };
      recent?: Array<{ id: string; title: string; type: string; category: string; state: string; priority: string; scheduledFor: string; participantId: string; aiGenerated: boolean; difficulty: string }>;
      templates?: Array<{ id: string; slug: string; name: string; type: string; category: string }>;
    };
    goals?: {
      stats?: { total?: number; active?: number; achieved?: number; achievementRate?: number };
      recent?: Array<{ id: string; name: string; type: string; state: string; targetValue: number; currentValue: number; unit?: string; progress: number; milestoneCount: number; achievedMilestones: number; adaptive: boolean }>;
    };
    habits?: {
      stats?: { total?: number; active?: number; totalCompletions?: number; avgStreak?: number; bestStreak?: number };
      recent?: Array<{ id: string; name: string; frequency: string; active: boolean; currentStreak: number; bestStreak: number; totalCompletions: number; score: number }>;
    };
    plans?: {
      stats?: { total?: number; active?: number; completed?: number; avgMissionsPerPlan?: number };
      recent?: Array<{ id: string; name: string; state: string; version: number; missionCount: number; goalCount: number; habitCount: number; participantId: string }>;
    };
    knowledge?: {
      stats?: { totalBases?: number; totalEntries?: number };
      bases?: Array<{ id: string; name: string; type: string; entryCount: number; allowedRetrieval: boolean }>;
    };
  }) ?? {};
  const missions = m.missions ?? {};
  const goals = m.goals ?? {};
  const habits = m.habits ?? {};
  const plans = m.plans ?? {};
  const knowledge = m.knowledge ?? {};
  const mStats = missions.stats ?? {};
  const gStats = goals.stats ?? {};
  const hStats = habits.stats ?? {};
  const pStats = plans.stats ?? {};
  const kStats = knowledge.stats ?? {};

  const stateMap: Record<string, "default" | "secondary" | "destructive"> = {
    active: "default", assigned: "secondary", completed: "default", skipped: "secondary",
    expired: "destructive", cancelled: "destructive", draft: "secondary", scheduled: "secondary", archived: "secondary",
  };
  const priorityMap: Record<string, "default" | "secondary" | "destructive"> = {
    low: "secondary", normal: "default", high: "default", critical: "destructive",
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Missions, Goals & Habits"
        subtitle="The intelligence that personalizes every participant's journey. Programs generate daily missions, adaptive plans, habits with streaks, and goals with milestones. AI generates and adapts the experience — the platform stores, schedules, tracks, and audits."
        icon={<Target className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Missions" value={mStats.total ?? 0} hint={`${mStats.active ?? 0} active`} accent />
        <StatCard label="Completion Rate" value={mStats.completionRate ? `${Math.round(mStats.completionRate * 100)}%` : "—"} />
        <StatCard label="Goals Active" value={gStats.active ?? 0} hint={`${gStats.achieved ?? 0} achieved`} />
        <StatCard label="Habit Streaks" value={hStats.bestStreak ?? 0} hint="best streak" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Plans" value={pStats.total ?? 0} hint={`${pStats.active ?? 0} active`} />
        <StatCard label="Knowledge Bases" value={kStats.totalBases ?? 0} hint={`${kStats.totalEntries ?? 0} entries`} />
        <StatCard label="Habit Completions" value={hStats.totalCompletions ?? 0} />
        <StatCard label="Mission Templates" value={missions.templates?.length ?? 0} />
      </div>

      <Panel title="Today's Missions">
        <div className="max-h-[24rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Mission</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Difficulty</TableHead>
                <TableHead>State</TableHead>
                <TableHead>AI</TableHead>
                <TableHead className="pr-4">Scheduled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(missions.recent ?? []).map((mis) => (
                <TableRow key={mis.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm flex items-center gap-1.5">
                      {mis.aiGenerated && <Zap className="h-3 w-3 text-[var(--brand)]" />}
                      {mis.title}
                    </div>
                    <Mono className="text-muted-foreground">{mis.id.slice(0, 16)}…</Mono>
                  </TableCell>
                  <TableCell><span className="text-xs font-mono">{mis.category}</span></TableCell>
                  <TableCell><Badge variant={priorityMap[mis.priority] ?? "secondary"} className="text-[10px]">{mis.priority}</Badge></TableCell>
                  <TableCell><span className="text-xs">{mis.difficulty}</span></TableCell>
                  <TableCell><StateBadge state={mis.state} map={stateMap} /></TableCell>
                  <TableCell>{mis.aiGenerated ? <span className="text-[var(--brand)] text-xs">✓</span> : <span className="text-muted-foreground text-xs">—</span>}</TableCell>
                  <TableCell className="pr-4 text-xs text-muted-foreground">{new Date(mis.scheduledFor).toLocaleDateString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Goals & Milestones">
          <div className="space-y-2 max-h-64 overflow-y-auto eks-scroll">
            {(goals.recent ?? []).map((g) => (
              <div key={g.id} className="rounded-md border border-border/60 p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium">{g.name}</span>
                  <div className="flex items-center gap-1">
                    {g.adaptive && <Badge variant="outline" className="text-[10px]">adaptive</Badge>}
                    <StateBadge state={g.state} map={{ active: "default", achieved: "default", draft: "secondary", missed: "destructive", cancelled: "destructive", archived: "secondary" }} />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Progress:</span>
                  <span className="font-medium">{g.currentValue}/{g.targetValue} {g.unit ?? ""}</span>
                  <span className="text-[var(--brand)]">{g.progress}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden mt-1.5">
                  <div className="h-full bg-[var(--brand)]" style={{ width: `${Math.min(g.progress, 100)}%` }} />
                </div>
                <div className="flex items-center gap-1 mt-1.5">
                  <CheckCircle2 className="h-3 w-3 text-[var(--brand)]" />
                  <span className="text-[10px] text-muted-foreground">{g.achievedMilestones}/{g.milestoneCount} milestones</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Habits & Streaks">
          <div className="space-y-2 max-h-64 overflow-y-auto eks-scroll">
            {(habits.recent ?? []).map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)]">
                    <Flame className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{h.name}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{h.frequency}</span>
                      {h.active ? <span className="text-[var(--brand)]">active</span> : <span>inactive</span>}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-[var(--brand)]">{h.currentStreak}</p>
                  <p className="text-[10px] text-muted-foreground">current (best: {h.bestStreak})</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Plans & Adaptivity">
        <div className="space-y-1.5">
          {(plans.recent ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <Badge variant="outline" className="text-[10px]">v{p.version}</Badge>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">{p.missionCount} missions</span>
                <span className="text-muted-foreground">{p.goalCount} goals</span>
                <span className="text-muted-foreground">{p.habitCount} habits</span>
                <StateBadge state={p.state} map={{ active: "default", draft: "secondary", paused: "destructive", completed: "default", archived: "secondary" }} />
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Knowledge Bases">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {(knowledge.bases ?? []).map((kb) => (
            <div key={kb.id} className="rounded-md border border-border/60 p-3">
              <div className="flex items-center gap-1.5">
                <BookOpen className="h-4 w-4 text-[var(--brand)]" />
                <span className="text-sm font-medium">{kb.name}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className="text-[10px]">{kb.type}</Badge>
                <span className="text-xs text-muted-foreground">{kb.entryCount} entries</span>
                {kb.allowedRetrieval ? (
                  <span className="text-[10px] text-[var(--brand)]">retrieval allowed</span>
                ) : (
                  <span className="text-[10px] text-amber-500">retrieval blocked</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
