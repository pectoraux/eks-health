"use client";

import { useState, useCallback } from "react";
import {
  Target, Flame, Trophy, Activity, Zap, CheckCircle2, Clock,
  Plus, TrendingUp, ChevronRight, RefreshCw, Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/hooks/use-toast";

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  missions?: {
    stats: { total?: number; active?: number; completed?: number; completionRate?: number };
    today: { id: string; title: string; category: string; state: string; priority: string; difficulty: string; aiGenerated: boolean }[];
  };
  goals?: {
    stats: { total?: number; active?: number; achieved?: number };
    active: { id: string; name: string; targetValue: number; currentValue: number; unit?: string; progress: number }[];
  };
  habits?: {
    stats: { total?: number; active?: number; bestStreak?: number };
    active: { id: string; name: string; currentStreak: number; bestStreak: number; score: number }[];
  };
  competitions?: {
    stats: { total?: number; totalParticipants?: number };
    active: { id: string; name: string; scope: string; currentParticipants: number }[];
  };
  measurements?: {
    stats: { total?: number };
    recent: { id: string; schemaId: string; value: unknown; unitSymbol: string; sourceLabel: string; verificationState: string; collectedAt: string }[];
  };
}

export function ParticipantDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void }) {
  const m = data.missions;
  const g = data.goals;
  const h = data.habits;
  const c = data.competitions;
  const me = data.measurements;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Target className="h-4 w-4" />} label="Today's Missions" value={m?.today.length ?? 0} hint={`${m?.stats.active ?? 0} active`} />
        <StatCard icon={<Flame className="h-4 w-4" />} label="Best Streak" value={h?.stats.bestStreak ?? 0} hint="days" />
        <StatCard icon={<Trophy className="h-4 w-4" />} label="Competitions" value={c?.stats.total ?? 0} hint={`${c?.stats.totalParticipants ?? 0} participants`} />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Measurements" value={me?.stats.total ?? 0} hint="total recorded" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TodayMissionsCard missions={m} onRefresh={onRefresh} />
        <HabitStreaksCard habits={h} onRefresh={onRefresh} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ActiveGoalsCard goals={g} onRefresh={onRefresh} />
        <ActiveCompetitionsCard competitions={c} onRefresh={onRefresh} />
      </div>

      <MeasurementsCard measurements={me} onRefresh={onRefresh} />
    </div>
  );
}

// --- Today's Missions with complete/skip actions ---
function TodayMissionsCard({ missions, onRefresh }: { missions: DashboardData["missions"]; onRefresh: () => void }) {
  const [completing, setCompleting] = useState<string | null>(null);
  const today = missions?.today ?? [];

  const completeMission = async (id: string) => {
    setCompleting(id);
    try {
      const res = await fetch("/api/missions/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ missionId: id, outcome: "success" }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Mission completed!", description: "Great job — keep the streak going." });
        onRefresh();
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not complete mission", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setCompleting(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Today's Missions</CardTitle>
        <Badge variant="outline" className="text-[10px]">{today.filter((m) => m.state === "completed").length}/{today.length} done</Badge>
      </CardHeader>
      <CardContent>
        {today.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No missions for today. Check back later!</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto eks-scroll">
            {today.map((mission) => (
              <div key={mission.id} className="flex items-center gap-3 rounded-lg border border-border/60 p-3">
                <div className={`flex h-8 w-8 items-center justify-center rounded-full shrink-0 ${mission.state === "completed" ? "bg-[var(--brand-muted)] text-[var(--brand)]" : "bg-muted text-muted-foreground"}`}>
                  {mission.state === "completed" ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    {mission.aiGenerated && <Zap className="h-3 w-3 text-[var(--brand)]" />}
                    {mission.title}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">{mission.category} · {mission.difficulty}</p>
                </div>
                {mission.state !== "completed" && (
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 text-xs bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
                    disabled={completing === mission.id}
                    onClick={() => completeMission(mission.id)}
                  >
                    {completing === mission.id ? "..." : "Complete"}
                  </Button>
                )}
                {mission.state === "completed" && (
                  <Badge variant="default" className="text-[10px] bg-[var(--brand-muted)] text-[var(--brand)]">Done</Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Habit Streaks with check-in action ---
function HabitStreaksCard({ habits, onRefresh }: { habits: DashboardData["habits"]; onRefresh: () => void }) {
  const [checkingIn, setCheckingIn] = useState<string | null>(null);
  const active = habits?.active ?? [];

  const checkIn = async (id: string) => {
    setCheckingIn(id);
    try {
      const res = await fetch("/api/missions/habits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ habitId: id, action: "complete" }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Habit checked in!", description: "Streak extended — keep it up." });
        onRefresh();
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not check in", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setCheckingIn(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Habit Streaks</CardTitle>
        <Badge variant="outline" className="text-[10px]">{active.length} active</Badge>
      </CardHeader>
      <CardContent>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No active habits yet.</p>
        ) : (
          <div className="space-y-2">
            {active.map((habit) => (
              <div key={habit.id} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5">
                <div className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-orange-500" />
                  <div>
                    <span className="text-sm font-medium">{habit.name}</span>
                    <p className="text-[10px] text-muted-foreground">best: {habit.bestStreak} days</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <p className="text-lg font-bold text-[var(--brand)]">{habit.currentStreak}</p>
                    <p className="text-[10px] text-muted-foreground">streak</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={checkingIn === habit.id}
                    onClick={() => checkIn(habit.id)}
                  >
                    {checkingIn === habit.id ? "..." : <Plus className="h-3 w-3" />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Active Goals with progress update ---
function ActiveGoalsCard({ goals, onRefresh }: { goals: DashboardData["goals"]; onRefresh: () => void }) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [progressDialog, setProgressDialog] = useState<{ id: string; name: string; current: number; target: number; unit?: string } | null>(null);
  const [progressValue, setProgressValue] = useState("");
  const active = goals?.active ?? [];

  const updateProgress = async () => {
    if (!progressDialog) return;
    setUpdating(progressDialog.id);
    try {
      const res = await fetch("/api/missions/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goalId: progressDialog.id, action: "updateProgress", currentValue: parseFloat(progressValue) }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Progress updated!", description: `${progressDialog.name}: ${progressValue} ${progressDialog.unit ?? ""}` });
        setProgressDialog(null);
        setProgressValue("");
        onRefresh();
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not update progress", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setUpdating(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Active Goals</CardTitle>
        <Badge variant="outline" className="text-[10px]">{active.length} active</Badge>
      </CardHeader>
      <CardContent>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No active goals yet.</p>
        ) : (
          <div className="space-y-3">
            {active.map((goal) => (
              <div key={goal.id} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium">{goal.name}</span>
                  <span className="text-muted-foreground">{goal.currentValue}/{goal.targetValue} {goal.unit ?? ""}</span>
                </div>
                <Progress value={goal.progress} className="h-2" />
                <div className="flex items-center justify-between mt-1">
                  <p className="text-[10px] text-[var(--brand)]">{goal.progress}% complete</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs px-2"
                    onClick={() => {
                      setProgressDialog({ id: goal.id, name: goal.name, current: goal.currentValue, target: goal.targetValue, unit: goal.unit });
                      setProgressValue(String(goal.currentValue));
                    }}
                  >
                    <TrendingUp className="h-3 w-3 mr-1" /> Update
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!progressDialog} onOpenChange={(v) => !v && setProgressDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Progress</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">{progressDialog?.name}</p>
            <div className="space-y-1.5">
              <Label htmlFor="progress">Current value ({progressDialog?.unit ?? "value"})</Label>
              <Input id="progress" type="number" step="any" value={progressValue} onChange={(e) => setProgressValue(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">Target: {progressDialog?.target} {progressDialog?.unit ?? ""}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProgressDialog(null)}>Cancel</Button>
            <Button onClick={updateProgress} disabled={updating !== null || !progressValue}>
              {updating !== null ? "Saving..." : "Save Progress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// --- Active Competitions with join action ---
function ActiveCompetitionsCard({ competitions, onRefresh }: { competitions: DashboardData["competitions"]; onRefresh: () => void }) {
  const [joining, setJoining] = useState<string | null>(null);
  const active = competitions?.active ?? [];

  const joinCompetition = async (id: string) => {
    setJoining(id);
    try {
      const res = await fetch("/api/competitions/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitionId: id }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Joined competition!", description: "Good luck — check the leaderboard for your rank." });
        onRefresh();
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not join", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setJoining(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Active Competitions</CardTitle>
        <Badge variant="outline" className="text-[10px]">{active.length} live</Badge>
      </CardHeader>
      <CardContent>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No active competitions right now.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {active.map((comp) => (
              <div key={comp.id} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Trophy className="h-4 w-4 text-amber-500 shrink-0" />
                  <span className="text-sm font-medium truncate">{comp.name}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                  <Badge variant="outline" className="text-[10px]">{comp.scope}</Badge>
                  <span>{comp.currentParticipants} joined</span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-7 text-xs"
                  disabled={joining === comp.id}
                  onClick={() => joinCompetition(comp.id)}
                >
                  {joining === comp.id ? "Joining..." : "Join Competition"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Measurements with record action ---
function MeasurementsCard({ measurements, onRefresh }: { measurements: DashboardData["measurements"]; onRefresh: () => void }) {
  const [recordDialog, setRecordDialog] = useState(false);
  const [schemas, setSchemas] = useState<{ id: string; name: string; slug: string; unit: string; valueType: string }[]>([]);
  const [sources, setSources] = useState<{ id: string; label: string; type: string }[]>([]);
  const [selectedSchema, setSelectedSchema] = useState("");
  const [selectedSource, setSelectedSource] = useState("");
  const [value, setValue] = useState("");
  const [recording, setRecording] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);

  const openRecordDialog = async () => {
    setRecordDialog(true);
    setLoadingMeta(true);
    try {
      const [schemaRes, sourceRes] = await Promise.all([
        fetch("/api/health/schemas"),
        fetch("/api/health/sources"),
      ]);
      const [schemaData, sourceData] = await Promise.all([schemaRes.json(), sourceRes.json()]);
      // schemas API returns a bare array; sources API returns { sources: [...] }
      const schemaList = Array.isArray(schemaData.data) ? schemaData.data : (schemaData.data?.schemas ?? []);
      const sourceList = sourceData.data?.sources ?? [];
      setSchemas(schemaList);
      setSources(sourceList);
      if (schemaList[0]) setSelectedSchema(schemaList[0].id);
      if (sourceList[0]) setSelectedSource(sourceList[0].id);
    } catch {
      toast({ title: "Error", description: "Could not load measurement types", variant: "destructive" });
    } finally {
      setLoadingMeta(false);
    }
  };

  const recordMeasurement = async () => {
    setRecording(true);
    try {
      const res = await fetch("/api/health/measurements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schemaId: selectedSchema,
          profileId: "prof_demo_1",
          value: parseFloat(value),
          unitId: schemas.find((s) => s.id === selectedSchema)?.unit ?? "count",
          sourceId: selectedSource,
          collectedBy: "self",
          tags: ["self-reported"],
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Measurement recorded!", description: `Verification: ${data.data.verificationState}` });
        setRecordDialog(false);
        setValue("");
        onRefresh();
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not record", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setRecording(false);
    }
  };

  const recent = measurements?.recent ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Recent Measurements</CardTitle>
        <Button size="sm" variant="default" className="h-7 text-xs bg-[var(--brand)] text-[var(--brand-foreground)]" onClick={openRecordDialog}>
          <Plus className="h-3 w-3 mr-1" /> Record
        </Button>
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No measurements yet. Record your first one!</p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll">
            {recent.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-md border border-border/60 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <Activity className="h-3.5 w-3.5 text-muted-foreground" />
                  <div>
                    <span className="font-medium">{typeof m.value === "number" ? m.value : JSON.stringify(m.value)} {m.unitSymbol}</span>
                    <span className="text-muted-foreground ml-2">{m.sourceLabel}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={m.verificationState === "verified" ? "default" : "secondary"} className="text-[9px]">{m.verificationState}</Badge>
                  <span className="text-muted-foreground">{new Date(m.collectedAt).toLocaleDateString()}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={recordDialog} onOpenChange={setRecordDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record Measurement</DialogTitle>
          </DialogHeader>
          {loadingMeta ? (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading measurement types...</div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label>Measurement Type</Label>
                <Select value={selectedSchema} onValueChange={setSelectedSchema}>
                  <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    {schemas.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name} ({s.unit})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Source</Label>
                <Select value={selectedSource} onValueChange={setSelectedSource}>
                  <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                  <SelectContent>
                    {sources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.label} ({s.type})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="value">Value ({schemas.find((s) => s.id === selectedSchema)?.unit ?? ""})</Label>
                <Input id="value" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Enter value" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRecordDialog(false)}>Cancel</Button>
            <Button onClick={recordMeasurement} disabled={recording || !value || !selectedSchema}>
              {recording ? "Recording..." : "Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// --- Shared StatCard ---
function StatCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {icon}
          </div>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className="text-2xl font-bold">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}
