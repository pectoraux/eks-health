"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, LogOut, RefreshCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConsoleLoading } from "@/components/console/loading";

interface Session {
  accountId: string;
  email: string;
  displayName: string;
  activePersona: string;
  personas: string[];
  isDemo: boolean;
  isAdmin: boolean;
}

export default function DashboardPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session", { cache: "no-store" });
      const data = await res.json();
      if (data.ok && data.data) {
        setSession(data.data);
      } else {
        router.push("/sign-in");
      }
    } catch {
      router.push("/sign-in");
    }
    setLoading(false);
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (data.ok && data.data) {
          setSession(data.data);
        } else {
          router.push("/sign-in");
        }
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
    await fetch("/api/auth/switch-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona }),
    });
    fetchSession();
  };

  if (loading || !session) {
    return <ConsoleLoading />;
  }

  const personaLabels: Record<string, string> = {
    participant: "Participant",
    health_technician: "Health Technician",
    developer: "Developer",
    researcher: "Researcher",
    org_admin: "Organization Admin",
    platform_admin: "Platform Admin",
    marketplace_reviewer: "Marketplace Reviewer",
    support_agent: "Support Agent",
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Top Bar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/")} className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]">
                <HeartPulse className="h-4 w-4" />
              </div>
              <span className="font-bold text-sm hidden sm:inline">Eks-Health</span>
            </button>
            <Badge variant="outline" className="text-[10px] capitalize">
              {personaLabels[session.activePersona] ?? session.activePersona}
            </Badge>
            {session.isDemo && <Badge className="text-[10px] bg-amber-500/20 text-amber-600">DEMO</Badge>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => router.push("/console")} className="text-xs">
              Platform Console
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Dashboard Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Welcome, {session.displayName}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {session.email} · Active role: {personaLabels[session.activePersona] ?? session.activePersona}
          </p>
        </div>

        {/* Role Switcher */}
        {session.personas.length > 1 && (
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="h-4 w-4 text-[var(--brand)]" />
              <span className="text-sm font-medium">Switch Role</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {session.personas.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={p === session.activePersona ? "default" : "outline"}
                  onClick={() => switchRole(p)}
                  className={p === session.activePersona ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : ""}
                >
                  {personaLabels[p] ?? p}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Role-specific content */}
        <RoleDashboard persona={session.activePersona} session={session} />
      </main>
    </div>
  );
}

function RoleDashboard({ persona, session }: { persona: string; session: Session }) {
  const dashboards: Record<string, { title: string; desc: string; items: { label: string; value: string; icon: string }[]; cta: { label: string; href: string }[] }> = {
    participant: {
      title: "Your Health Journey",
      desc: "Track verified measurements, complete daily missions, compete, and earn rewards.",
      items: [
        { label: "Today's Missions", value: "4 active", icon: "🎯" },
        { label: "Current Streak", value: "7 days", icon: "🔥" },
        { label: "Competition Rank", value: "#12", icon: "🏆" },
        { label: "Total Rewards", value: "$45", icon: "💰" },
      ],
      cta: [
        { label: "View Today's Missions", href: "/console" },
        { label: "Browse Marketplace", href: "/console" },
        { label: "Health Timeline", href: "/console" },
      ],
    },
    health_technician: {
      title: "Technician Dashboard",
      desc: "Manage appointments, verify measurements, and build your reputation.",
      items: [
        { label: "Today's Appointments", value: "5", icon: "📅" },
        { label: "Reputation Score", value: "96/100", icon: "⭐" },
        { label: "Verified Sessions", value: "1,247", icon: "✅" },
        { label: "Active Certifications", value: "3", icon: "📜" },
      ],
      cta: [
        { label: "Today's Schedule", href: "/console" },
        { label: "Measurement Sessions", href: "/console" },
        { label: "My Reputation", href: "/console" },
      ],
    },
    developer: {
      title: "Developer Dashboard",
      desc: "Build, test, certify, and publish health Programs.",
      items: [
        { label: "Published Programs", value: "5", icon: "📦" },
        { label: "Active Installs", value: "3,421", icon: "📥" },
        { label: "Total Revenue", value: "$2,847", icon: "💰" },
        { label: "Avg Rating", value: "4.8★", icon: "⭐" },
      ],
      cta: [
        { label: "SDK Dashboard", href: "/console" },
        { label: "AI Workflow Builder", href: "/console" },
        { label: "Marketplace", href: "/console" },
      ],
    },
    researcher: {
      title: "Research Dashboard",
      desc: "Build cohorts, run studies, and generate AI-powered insights.",
      items: [
        { label: "Active Studies", value: "3", icon: "🔬" },
        { label: "Dataset Records", value: "1.2M", icon: "📊" },
        { label: "Publications", value: "12", icon: "📄" },
        { label: "AI Insights", value: "47", icon: "🤖" },
      ],
      cta: [
        { label: "Cohort Builder", href: "/console" },
        { label: "Population Analytics", href: "/console" },
        { label: "AI Insights", href: "/console" },
      ],
    },
    org_admin: {
      title: "Organization Dashboard",
      desc: "Manage population health, sponsor Programs, and launch campaigns.",
      items: [
        { label: "Active Members", value: "1,247", icon: "👥" },
        { label: "Programs Sponsored", value: "8", icon: "📦" },
        { label: "Campaigns Active", value: "2", icon: "📢" },
        { label: "Budget Utilized", value: "67%", icon: "💰" },
      ],
      cta: [
        { label: "Population Dashboard", href: "/console" },
        { label: "Campaigns", href: "/console" },
        { label: "Funding", href: "/console" },
      ],
    },
    platform_admin: {
      title: "Platform Administration",
      desc: "Manage users, approve waitlist, moderate marketplace, and monitor security.",
      items: [
        { label: "Waitlist Pending", value: "—", icon: "⏳" },
        { label: "Total Users", value: "—", icon: "👥" },
        { label: "Active Programs", value: "—", icon: "📦" },
        { label: "Security Alerts", value: "0", icon: "🔒" },
      ],
      cta: [
        { label: "Platform Console", href: "/console" },
        { label: "Audit Trail", href: "/console" },
        { label: "Marketplace", href: "/console" },
      ],
    },
  };

  const dashboard = dashboards[persona] ?? dashboards.participant;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">{dashboard.title}</h2>
        <p className="text-sm text-muted-foreground">{dashboard.desc}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {dashboard.items.map((item) => (
          <div key={item.label} className="rounded-xl border border-border/60 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-lg">{item.icon}</span>
            </div>
            <p className="text-2xl font-bold">{item.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="rounded-xl border border-border/60 p-5">
        <h3 className="font-semibold text-sm mb-3">Quick Actions</h3>
        <div className="flex flex-wrap gap-2">
          {dashboard.cta.map((cta) => (
            <Button key={cta.label} variant="outline" size="sm" onClick={() => window.location.href = cta.href}>
              {cta.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Platform Console Link */}
      <div className="rounded-xl border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-5">
        <h3 className="font-semibold text-sm mb-2 text-[var(--brand)]">Full Platform Console</h3>
        <p className="text-xs text-muted-foreground mb-3">Access the complete platform console with all 35 sections — services, architecture, health data, competitions, missions, AI, developer tools, marketplace, research, orchestrator, and population platform.</p>
        <Button size="sm" onClick={() => window.location.href = "/console"} className="bg-[var(--brand)] text-[var(--brand-foreground)]">
          Open Console <RefreshCw className="h-3.5 w-3.5 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}
