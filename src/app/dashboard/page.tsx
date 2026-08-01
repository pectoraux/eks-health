"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ParticipantDashboard } from "@/components/dashboard/participant-dashboard";
import { TechnicianDashboard } from "@/components/dashboard/technician-dashboard";
import { DeveloperDashboard } from "@/components/dashboard/developer-dashboard";
import { ResearcherDashboard } from "@/components/dashboard/researcher-dashboard";
import { OrgAdminDashboard } from "@/components/dashboard/org-admin-dashboard";
import { PlatformAdminDashboard } from "@/components/dashboard/platform-admin-dashboard";

export interface DashboardData {
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
  platform?: { accounts: { id: string; email: string; displayName: string; state: string; personas: string[]; activePersona: string; createdAt: string }[]; waitlist: { id: string; name: string; email: string; country?: string; interestedRoles?: string[]; status: string; createdAt?: string }[] };
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [session, setSession] = useState<{ email: string; displayName: string; activePersona: string; personas: string[]; isDemo: boolean; isAdmin: boolean } | null>(null);

  const [error, setError] = useState(false);

  const fetchData = useCallback(async () => {
    setError(false);
    const sessRes = await fetch("/api/auth/session", { cache: "no-store" });
    const sessData = await sessRes.json();
    if (!sessData.ok || !sessData.data) { router.push("/sign-in"); return; }
    setSession(sessData.data);

    // Retry dashboard fetch up to 3 times on failure (handles cold-start races).
    let dashData: { ok: boolean; data?: DashboardData; error?: { message?: string } } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const dashRes = await fetch("/api/dashboard", { cache: "no-store" });
        dashData = await dashRes.json();
        if (dashData?.ok && dashData.data) {
          setData(dashData.data);
          return;
        }
      } catch {
        // network error — retry
      }
      // Wait 500ms before retrying (exponential backoff would be better but
      // this is simple and effective for the cold-start race).
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }
    // All retries failed — show error state with retry button.
    setError(true);
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetchData();
      } catch {
        if (!cancelled) router.push("/sign-in");
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [fetchData, router]);

  const refreshData = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchData();
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  }, [fetchData]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.push("/");
  }, [router]);

  const switchRole = async (persona: string) => {
    await fetch("/api/auth/switch-role", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona }) });
    // Small delay to let the DB write-behind persist before re-fetching.
    await new Promise((r) => setTimeout(r, 300));
    await fetchData();
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
    <div className="min-h-screen bg-background flex flex-col">
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
            <Button variant="ghost" size="sm" onClick={refreshData} disabled={refreshing} className="text-xs">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
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

        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <p className="text-sm text-muted-foreground">Unable to load dashboard data. This is usually a temporary server issue.</p>
            <Button onClick={refreshData} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Retrying..." : "Retry"}
            </Button>
          </div>
        ) : data ? (
          <RoleContent persona={session.activePersona} data={data} onRefresh={refreshData} />
        ) : null}
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 text-xs text-muted-foreground text-center">
          Eks-Health — Preventive Health Operating System · prototype
        </div>
      </footer>
    </div>
  );
}

function RoleContent({ persona, data, onRefresh }: { persona: string; data: DashboardData; onRefresh: () => void }) {
  switch (persona) {
    case "participant": return <ParticipantDashboard data={data} onRefresh={onRefresh} />;
    case "health_technician": return <TechnicianDashboard data={data} onRefresh={onRefresh} />;
    case "developer": return <DeveloperDashboard data={data} onRefresh={onRefresh} />;
    case "researcher": return <ResearcherDashboard data={data} onRefresh={onRefresh} />;
    case "org_admin": return <OrgAdminDashboard data={data} onRefresh={onRefresh} />;
    case "platform_admin": return <PlatformAdminDashboard data={data} onRefresh={onRefresh} />;
    default: return <ParticipantDashboard data={data} onRefresh={onRefresh} />;
  }
}
