"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  HeartPulse, LogOut, Zap, Activity, Trophy, Target, Flame,
  TrendingUp, CheckCircle2, Clock, Users, Building2, Code2,
  FlaskConical, ShieldCheck, Store, ArrowRight, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  missions?: { stats: { total?: number; active?: number; completed?: number; completionRate?: number }; today: { id: string; title: string; category: string; state: string; priority: string; difficulty: string; aiGenerated: boolean }[] };
  goals?: { stats: { total?: number; active?: number; achieved?: number }; active: { id: string; name: string; targetValue: number; currentValue: number; unit?: string; progress: number }[] };
  habits?: { stats: { total?: number; active?: number; bestStreak?: number }; active: { id: string; name: string; currentStreak: number; bestStreak: number; score: number }[] };
  competitions?: { stats: { total?: number; totalParticipants?: number }; active: { id: string; name: string; scope: string; currentParticipants: number }[] };
  measurements?: { stats: { total?: number }; recent: { id: string; schemaId: string; value: unknown; unitSymbol: string; sourceLabel: string; verificationState: string; collectedAt: string }[] };
  technicians?: { stats: { total?: number; active?: number }; list: { id: string; displayName: string; rating?: number; totalSessions: number; verifiedSessions: number }[] };
  developer?: { profiles: { id: string; name: string; email: string; verified: boolean; metrics: { programsCount?: number; publishedCount?: number; totalInstalls?: number; avgRating?: number } }[] };
  marketplace?: { stats: { total?: number; published?: number; totalInstalls?: number; activeInstalls?: number } };
  research?: { consentStats: { total?: number; active?: number } };
  population?: { stats: { totalContexts?: number; avgGoals?: number } };
  platform?: { accounts: { id: string; email: string; displayName: string; state: string; personas: string[]; activePersona: string; createdAt: string }[]; waitlist: { id: string; name: string; email: string; status: string }[] };
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<{ email: string; displayName: string; activePersona: string; personas: string[]; isDemo: boolean; isAdmin: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sessRes, dashRes] = await Promise.all([
          fetch("/api/auth/session", { cache: "no-store" }),
          fetch("/api/dashboard", { cache: "no-store" }),
        ]);
        const sessData = await sessRes.json();
        const dashData = await dashRes.json();
        if (cancelled) return;
        if (!sessData.ok || !sessData.data) { router.push("/sign-in"); return; }
        setSession(sessData.data);
        if (dashData.ok) setData(dashData.data);
      } catch {
        if (!cancelled) router.push("/sign-in");
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [router]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.push("/");
  }, [router]);

  const switchRole = async (persona: string) => {
    await fetch("/api/auth/switch-role", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona }) });
    // Refresh both session and dashboard data
    const [sessRes, dashRes] = await Promise.all([
      fetch("/api/auth/session", { cache: "no-store" }),
      fetch("/api/dashboard", { cache: "no-store" }),
    ]);
    const sessData = await sessRes.json();
    const dashData = await dashRes.json();
    if (sessData.ok && sessData.data) setSession(sessData.data);
    if (dashData.ok) setData(dashData.data);
  };

  if (loading || !session) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <div className="h-10 w-10 rounded-full border-2 border-muted border-t-foreground animate-spin" />
        <p className="text-sm text-muted-foreground font-mono">Loading dashboard...</p>
      </div>
    );
  }

  const personaLabels: Record<string, string> = {
    participant: "Participant", health_technician: "Health Technician", developer: "Developer",
    researcher: "Researcher", org_admin: "Organization Admin", platform_admin: "Platform Admin",
    marketplace_reviewer: "Marketplace Reviewer", support_agent: "Support Agent",
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/")} className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]">
                <HeartPulse className="h-4 w-4" />
              </div>
              <span className="font-bold text-sm hidden sm:inline">Eks-Health</span>
            </button>
            <Badge variant="outline" className="text-[10px]">{personaLabels[session.activePersona] ?? session.activePersona}</Badge>
            {session.isDemo && <Badge className="text-[10px] bg-amber-500/20 text-amber-600">DEMO</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => router.push("/marketplace")} className="text-xs">Marketplace</Button>
            <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/timeline")} className="text-xs">Timeline</Button>
            <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard/settings")} className="text-xs">Settings</Button>
            <Button variant="ghost" size="sm" onClick={() => router.push("/console")} className="text-xs">Console</Button>
            <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome + Role Switcher */}
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Welcome, {session.displayName}</h1>
            <p className="text-sm text-muted-foreground mt-1">{session.email} · {personaLabels[session.activePersona]}</p>
          </div>
          {session.personas.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {session.personas.map((p) => (
                <Button key={p} size="sm" variant={p === session.activePersona ? "default" : "outline"}
                  onClick={() => switchRole(p)}
                  className={p === session.activePersona ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : ""}>
                  {personaLabels[p] ?? p}
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* Role-specific content */}
        {data && <RoleContent persona={session.activePersona} data={data} />}
      </main>
    </div>
  );
}

function RoleContent({ persona, data }: { persona: string; data: DashboardData }) {
  switch (persona) {
    case "participant": return <ParticipantDashboard data={data} />;
    case "health_technician": return <TechnicianDashboard data={data} />;
    case "developer": return <DeveloperDashboard data={data} />;
    case "researcher": return <ResearcherDashboard data={data} />;
    case "org_admin": return <OrgAdminDashboard data={data} />;
    case "platform_admin": return <AdminDashboard data={data} />;
    default: return <ParticipantDashboard data={data} />;
  }
}

// --- Participant Dashboard ---
function ParticipantDashboard({ data }: { data: DashboardData }) {
  const m = data.missions;
  const g = data.goals;
  const h = data.habits;
  const c = data.competitions;
  const me = data.measurements;
  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Target className="h-4 w-4" />} label="Today's Missions" value={m?.today.length ?? 0} hint={`${m?.stats.active ?? 0} active`} />
        <StatCard icon={<Flame className="h-4 w-4" />} label="Best Streak" value={h?.stats.bestStreak ?? 0} hint="days" />
        <StatCard icon={<Trophy className="h-4 w-4" />} label="Competitions" value={c?.stats.total ?? 0} hint={`${c?.stats.totalParticipants ?? 0} participants`} />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Measurements" value={me?.stats.total ?? 0} hint="total recorded" />
      </div>

      {/* Today's Missions */}
      <Card>
        <CardHeader><CardTitle className="text-base">Today's Missions</CardTitle></CardHeader>
        <CardContent>
          {m?.today.length === 0 || !m?.today ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No missions for today. Check back later!</p>
          ) : (
            <div className="space-y-2">
              {m.today.map((mission) => (
                <div key={mission.id} className="flex items-center gap-3 rounded-lg border border-border/60 p-3">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-full ${mission.state === "completed" ? "bg-[var(--brand-muted)] text-[var(--brand)]" : "bg-muted text-muted-foreground"}`}>
                    {mission.state === "completed" ? <CheckCircle2 className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium flex items-center gap-1.5">
                      {mission.aiGenerated && <Zap className="h-3 w-3 text-[var(--brand)]" />}
                      {mission.title}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">{mission.category} · {mission.difficulty}</p>
                  </div>
                  <Badge variant={mission.state === "completed" ? "default" : mission.state === "active" ? "default" : "secondary"} className="text-[10px]">{mission.state}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Goals */}
        <Card>
          <CardHeader><CardTitle className="text-base">Active Goals</CardTitle></CardHeader>
          <CardContent>
            {g?.active.length === 0 || !g?.active ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No active goals yet.</p>
            ) : (
              <div className="space-y-3">
                {g.active.map((goal) => (
                  <div key={goal.id}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-medium">{goal.name}</span>
                      <span className="text-muted-foreground">{goal.currentValue}/{goal.targetValue} {goal.unit ?? ""}</span>
                    </div>
                    <Progress value={goal.progress} className="h-2" />
                    <p className="text-[10px] text-[var(--brand)] mt-0.5">{goal.progress}% complete</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Habits */}
        <Card>
          <CardHeader><CardTitle className="text-base">Habit Streaks</CardTitle></CardHeader>
          <CardContent>
            {h?.active.length === 0 || !h?.active ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No active habits yet.</p>
            ) : (
              <div className="space-y-2">
                {h.active.map((habit) => (
                  <div key={habit.id} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5">
                    <div className="flex items-center gap-2">
                      <Flame className="h-4 w-4 text-orange-500" />
                      <span className="text-sm font-medium">{habit.name}</span>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-[var(--brand)]">{habit.currentStreak}</p>
                      <p className="text-[10px] text-muted-foreground">streak (best: {habit.bestStreak})</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Active Competitions */}
      {c?.active && c.active.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Active Competitions</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {c.active.map((comp) => (
                <div key={comp.id} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Trophy className="h-4 w-4 text-amber-500" />
                    <span className="text-sm font-medium truncate">{comp.name}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline" className="text-[10px]">{comp.scope}</Badge>
                    <span>{comp.currentParticipants} participants</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// --- Technician Dashboard ---
function TechnicianDashboard({ data }: { data: DashboardData }) {
  const t = data.technicians;
  const m = data.measurements;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Users className="h-4 w-4" />} label="Technicians" value={t?.stats.total ?? 0} hint={`${t?.stats.active ?? 0} active`} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Measurements" value={m?.stats.total ?? 0} />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Avg Sessions" value={t?.list?.[0]?.totalSessions ?? 0} />
        <StatCard icon={<TrendingUp className="h-4 w-4" />} label="Verified" value={t?.list?.[0]?.verifiedSessions ?? 0} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Technician Network</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            {t?.list?.map((tech) => (
              <div key={tech.id} className="flex items-center justify-between rounded-lg border border-border/60 p-3">
                <div>
                  <p className="text-sm font-medium">{tech.displayName}</p>
                  <p className="text-xs text-muted-foreground">{tech.verifiedSessions}/{tech.totalSessions} sessions verified</p>
                </div>
                {tech.rating && <Badge className="bg-amber-500/20 text-amber-600">{tech.rating.toFixed(1)}★</Badge>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Developer Dashboard ---
function DeveloperDashboard({ data }: { data: DashboardData }) {
  const d = data.developer;
  const mp = data.marketplace;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Code2 className="h-4 w-4" />} label="Programs" value={d?.profiles?.[0]?.metrics?.programsCount ?? 0} />
        <StatCard icon={<Store className="h-4 w-4" />} label="Published" value={d?.profiles?.[0]?.metrics?.publishedCount ?? 0} />
        <StatCard icon={<TrendingUp className="h-4 w-4" />} label="Total Installs" value={d?.profiles?.[0]?.metrics?.totalInstalls ?? 0} />
        <StatCard icon={<Trophy className="h-4 w-4" />} label="Marketplace" value={mp?.stats.total ?? 0} hint={`${mp?.stats.published ?? 0} published`} />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Developer Profile</CardTitle></CardHeader>
        <CardContent>
          {d?.profiles?.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-lg border border-border/60 p-3 mb-2">
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5">
                  {p.name}
                  {p.verified && <ShieldCheck className="h-3.5 w-3.5 text-[var(--brand)]" />}
                </p>
                <p className="text-xs text-muted-foreground">{p.email}</p>
              </div>
              <div className="text-right text-xs">
                <p>{p.metrics.programsCount} programs · {p.metrics.publishedCount} published</p>
                <p className="text-muted-foreground">{p.metrics.totalInstalls} installs · {p.metrics.avgRating?.toFixed(1) ?? "—"}★</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// --- Researcher Dashboard ---
function ResearcherDashboard({ data }: { data: DashboardData }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<FlaskConical className="h-4 w-4" />} label="Consents" value={data.research?.consentStats.total ?? 0} />
        <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Active" value={data.research?.consentStats.active ?? 0} />
        <StatCard icon={<TrendingUp className="h-4 w-4" />} label="AI Insights" value={0} />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Publications" value={0} />
      </div>
      <Card>
        <CardContent className="p-6 text-center">
          <FlaskConical className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Research workspace features are available in the full console.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => window.location.href = "/console"}>Open Console <ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Org Admin Dashboard ---
function OrgAdminDashboard({ data }: { data: DashboardData }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Building2 className="h-4 w-4" />} label="Organizations" value={0} />
        <StatCard icon={<Users className="h-4 w-4" />} label="Members" value={0} />
        <StatCard icon={<Trophy className="h-4 w-4" />} label="Campaigns" value={0} />
        <StatCard icon={<Activity className="h-4 w-4" />} label="Population" value={data.population?.stats.totalContexts ?? 0} />
      </div>
      <Card>
        <CardContent className="p-6 text-center">
          <Building2 className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Population management features are available in the full console.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => window.location.href = "/console"}>Open Console <ArrowRight className="h-3.5 w-3.5 ml-1" /></Button>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Platform Admin Dashboard ---
function AdminDashboard({ data }: { data: DashboardData }) {
  const p = data.platform;
  const accounts = p?.accounts ?? [];
  const waitlist = p?.waitlist ?? [];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Users className="h-4 w-4" />} label="Total Accounts" value={accounts.length} accent />
        <StatCard icon={<Clock className="h-4 w-4" />} label="Waitlist" value={waitlist.length} hint={`${waitlist.filter((w) => w.status === "pending").length} pending`} />
        <StatCard icon={<Store className="h-4 w-4" />} label="Marketplace" value={data.marketplace?.stats.total ?? 0} />
        <StatCard icon={<ShieldCheck className="h-4 w-4" />} label="Security" value={0} hint="alerts" />
      </div>

      {/* Waitlist */}
      {waitlist.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Waitlist ({waitlist.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto eks-scroll">
              {waitlist.map((w) => (
                <div key={w.id} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5 text-xs">
                  <div>
                    <span className="font-medium">{w.name}</span>
                    <span className="text-muted-foreground ml-2">{w.email}</span>
                  </div>
                  <Badge variant={w.status === "pending" ? "secondary" : w.status === "approved" ? "default" : "destructive"} className="text-[10px]">{w.status}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Accounts */}
      <Card>
        <CardHeader><CardTitle className="text-base">Platform Accounts ({accounts.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-96 overflow-y-auto eks-scroll">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5 text-xs">
                <div>
                  <span className="font-medium">{a.displayName}</span>
                  <span className="text-muted-foreground ml-2">{a.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex gap-0.5">
                    {a.personas.map((p) => <Badge key={p} variant="outline" className="text-[9px] py-0">{p}</Badge>)}
                  </div>
                  <Badge variant={a.state === "active" ? "default" : "destructive"} className="text-[10px]">{a.state}</Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Helper ---
function StatCard({ icon, label, value, hint, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string; accent?: boolean }) {
  return (
    <Card className={accent ? "border-[var(--brand)]/40 bg-[var(--brand-muted)]/20" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className={`flex h-7 w-7 items-center justify-center rounded-md ${accent ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "bg-muted text-muted-foreground"}`}>
            {icon}
          </div>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className={`text-2xl font-bold ${accent ? "text-[var(--brand)]" : ""}`}>{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}
