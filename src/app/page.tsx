"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  HeartPulse, Activity, Trophy, Zap, ShieldCheck, Bot, Store,
  FlaskConical, Stethoscope, Code2, Building2, Target, ArrowRight,
  Check, Star, Users, TrendingUp, Lock, Sparkles, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export default function LandingPage() {
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled ? "bg-background/90 backdrop-blur-md border-b border-border" : "bg-transparent"}`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--brand)] text-[var(--brand-foreground)]">
              <HeartPulse className="h-5 w-5" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight">Eks-Health</span>
              <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider block leading-none">Preventive Health OS</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => router.push("/marketplace")} className="hidden sm:flex">Browse Programs</Button>
            <Button variant="ghost" size="sm" onClick={() => router.push("/sign-in")} className="hidden sm:flex">Sign In</Button>
            <Button size="sm" onClick={() => router.push("/sign-up")} className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90">
              Get Started <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-20 px-4 sm:px-6 lg:px-8 overflow-hidden">
        <div className="absolute inset-0 eks-grid-bg opacity-50" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-[var(--brand)]/10 rounded-full blur-[120px]" />
        <div className="relative max-w-5xl mx-auto text-center">
          <Badge variant="outline" className="mb-6 bg-[var(--brand-muted)]/50 border-[var(--brand)]/30 text-[var(--brand)]">
            <Sparkles className="h-3 w-3 mr-1" /> 163 subsystems · 12 milestones · Production-ready
          </Badge>
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-bold tracking-tight mb-6">
            Prevent disease<br />
            <span className="bg-gradient-to-r from-[var(--brand)] to-emerald-400 bg-clip-text text-transparent">before it happens.</span>
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground max-w-3xl mx-auto mb-10">
            Eks-Health is a Preventive Health Operating System where verified measurements drive
            competitions, AI coaches personalize daily missions, and every health journey contributes
            to better healthcare for everyone — while keeping your data yours.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 mb-12">
            <Button size="lg" onClick={() => router.push("/sign-up")} className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90 h-12 px-8 text-base">
              Join the Waitlist <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
            <Button size="lg" variant="outline" onClick={() => router.push("/sign-in")} className="h-12 px-8 text-base">
              Quick Demo Login
            </Button>
          </div>
          {/* Stats bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl mx-auto">
            {[
              { value: "163", label: "Platform Subsystems" },
              { value: "12", label: "Milestones Built" },
              { value: "35+", label: "Console Sections" },
              { value: "76+", label: "API Routes" },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <p className="text-3xl font-bold text-[var(--brand)]">{s.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What You Can Do */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">One platform. Every health journey.</h2>
          <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-12">From tracking your first measurement to building a global health Program — Eks-Health scales with you.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Activity, title: "Track Verified Health", desc: "Technician-verified measurements create an immutable health timeline you own.", color: "text-emerald-500" },
              { icon: Trophy, title: "Compete & Earn Rewards", desc: "Verified improvements drive competitions with real prize pools and leaderboards.", color: "text-amber-500" },
              { icon: Bot, title: "AI Personal Coach", desc: "Daily missions adapt to your progress. AI explains every recommendation.", color: "text-purple-500" },
              { icon: Store, title: "Discover Health Solutions", desc: "AI-powered marketplace matches you with Programs based on outcomes, not downloads.", color: "text-blue-500" },
              { icon: Stethoscope, title: "Become a Technician", desc: "Join the global trust network. Verify measurements, build reputation, earn.", color: "text-cyan-500" },
              { icon: Code2, title: "Build Health Programs", desc: "World-class SDK, CLI, simulator, visual builders. Ship production Programs.", color: "text-orange-500" },
              { icon: FlaskConical, title: "Contribute to Research", desc: "Your anonymized data helps society learn. K-anonymity + differential privacy.", color: "text-rose-500" },
              { icon: Building2, title: "Organizations Welcome", desc: "Employers, governments, NGOs sponsor wellness without seeing individual data.", color: "text-indigo-500" },
              { icon: ShieldCheck, title: "Privacy by Design", desc: "Zero-trust, consent-gated, auditable. Your data never leaves your control.", color: "text-green-500" },
            ].map((f) => (
              <Card key={f.title} className="border-border/60 hover:border-[var(--brand)]/40 transition-colors group">
                <CardContent className="p-5">
                  <div className={`h-10 w-10 rounded-lg bg-muted flex items-center justify-center mb-3 group-hover:scale-110 transition-transform ${f.color}`}>
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-semibold mb-1">{f.title}</h3>
                  <p className="text-sm text-muted-foreground">{f.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Role Experiences */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-muted/30">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">Built for every participant in the ecosystem</h2>
          <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-12">One identity, many roles. Switch instantly without logging out.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: "🏃", title: "Participant", desc: "Install Programs, complete daily missions, join competitions, earn rewards, track verified health improvements.", features: ["Today's Missions", "Leaderboards", "Health Timeline", "AI Coach", "Marketplace"] },
              { icon: "🩺", title: "Health Technician", desc: "Verify measurements, build reputation, manage appointments, earn from your expertise.", features: ["Today's Schedule", "Verification Workflow", "Reputation Dashboard", "Certifications", "Earnings"] },
              { icon: "💻", title: "Program Developer", desc: "Build, test, certify, and publish health Programs with world-class tooling.", features: ["SDK & CLI", "Visual Builder", "AI Workflow Designer", "Analytics", "Revenue"] },
              { icon: "🔬", title: "Researcher", desc: "Build cohorts, run studies, generate AI insights, publish findings — privacy-preserving.", features: ["Cohort Builder", "Population Analytics", "AI Insights", "Publications", "Evidence"] },
              { icon: "🏢", title: "Organization Admin", desc: "Manage population health, sponsor Programs, launch campaigns — see aggregates only.", features: ["Population Dashboard", "Funding", "Campaigns", "Approved Programs", "Analytics"] },
              { icon: "⚙️", title: "Platform Admin", desc: "Manage users, approve waitlist, moderate marketplace, monitor security.", features: ["User Management", "Waitlist Approvals", "Marketplace", "Security", "Audit Logs"] },
            ].map((r) => (
              <Card key={r.title} className="border-border/60 hover:border-[var(--brand)]/40 transition-all hover:shadow-lg">
                <CardContent className="p-5">
                  <div className="text-3xl mb-3">{r.icon}</div>
                  <h3 className="font-semibold mb-1">{r.title}</h3>
                  <p className="text-sm text-muted-foreground mb-3">{r.desc}</p>
                  <div className="flex flex-wrap gap-1">
                    {r.features.map((f) => (
                      <Badge key={f} variant="outline" className="text-[10px] py-0">{f}</Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Platform Architecture */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold text-center mb-4">A true operating system for health</h2>
          <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-12">Not an app. Not a dashboard. A platform where the whole ecosystem delivers better outcomes than any individual Program could alone.</p>
          <div className="space-y-3">
            {[
              { v: "v1.0", name: "Platform Kernel", desc: "Events, config, flags, scheduler, observability, storage, search, gateway, security, AI readiness", count: "16 subsystems" },
              { v: "v2.0", name: "Identity Platform", desc: "Zero-trust identity, RBAC+ABAC+PBAC, consent, privacy, audit, monitoring, compliance", count: "15 subsystems" },
              { v: "v3.0", name: "Program Operating System", desc: "Manifests, capabilities, sandbox, certification, SDK, testing, marketplace readiness", count: "16 subsystems" },
              { v: "v4.0", name: "Universal Health Data", desc: "Schemas, units, measurements, evidence, verification, provenance, timeline, interop", count: "17 subsystems" },
              { v: "v5.0", name: "Technician Network", desc: "Profiles, certifications, sessions, discovery, reputation, devices, chain-of-custody, fraud", count: "14 subsystems" },
              { v: "v6.0", name: "Competition Platform", desc: "Competitions, seasons, divisions, scoring, leaderboards, ranking, rewards, prize pools", count: "12 subsystems" },
              { v: "v7.0", name: "Mission Engine & AI", desc: "Missions, goals, habits, plans, personalization, knowledge, AI runtime, workflows", count: "15 subsystems" },
              { v: "v8.0", name: "Developer Platform", desc: "CLI, simulator, visual designer, workflow builder, debugger, inspector, API explorer", count: "10 subsystems" },
              { v: "v9.0", name: "Health Marketplace", desc: "Discovery, AI matching, outcomes, evidence, comparison, monetization, reviews, analytics", count: "12 subsystems" },
              { v: "v10.0", name: "Research & Intelligence", desc: "Consent, cohorts, privacy (k-anonymity), evidence, population, benchmarks, governance", count: "13 subsystems" },
              { v: "v11.0", name: "Health Orchestrator", desc: "Digital Twin, scheduler, conflict resolution, workload balancer, AI coordinator, timeline", count: "11 subsystems" },
              { v: "v12.0", name: "Population Platform", desc: "Organizations, hierarchy, membership, privacy firewall, funding, campaigns, org AI", count: "12 subsystems" },
            ].map((layer, i) => (
              <div key={layer.name} className="flex items-center gap-4 rounded-xl border border-border/60 p-4 hover:border-[var(--brand)]/30 transition-colors">
                <div className={`flex h-12 w-12 items-center justify-center rounded-lg font-mono text-xs font-bold shrink-0 ${i === 11 ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "bg-muted"}`}>
                  {layer.v}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm">{layer.name}</h3>
                    <Badge variant="outline" className="text-[10px]">{layer.count}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{layer.desc}</p>
                </div>
                {i < 11 && <ChevronRight className="h-4 w-4 text-muted-foreground rotate-90" />}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center">
          <div className="rounded-2xl border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-8 sm:p-12">
            <HeartPulse className="h-12 w-12 text-[var(--brand)] mx-auto mb-4" />
            <h2 className="text-2xl sm:text-3xl font-bold mb-3">Ready to transform preventive health?</h2>
            <p className="text-muted-foreground mb-6">Join the waitlist today. Be among the first to experience the future of preventive healthcare.</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button size="lg" onClick={() => router.push("/sign-up")} className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90 h-12 px-8">
                Join Waitlist <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
              <Button size="lg" variant="outline" onClick={() => router.push("/sign-in")} className="h-12 px-8">
                Try Demo Accounts
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-[var(--brand)]" />
            <span className="font-mono">Eks-Health — Preventive Health Operating System</span>
          </div>
          <div className="flex items-center gap-4">
            <span>region af-west-1</span>
            <span>tz Africa/Accra</span>
            <span>v12.5.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
