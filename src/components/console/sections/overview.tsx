"use client";

import { Activity, Boxes, Users, ShieldCheck, Zap, Globe2, Layers, Lock } from "lucide-react";
import { SectionHeader, StatCard, Panel, Mono } from "../primitives";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function OverviewSection({ data }: { data: PlatformSnapshot }) {
  const kernel = data.kernel as Record<string, unknown>;
  const identity = data.identity as Record<string, unknown>;
  const programs = (data.programs as Record<string, unknown>) ?? {};
  const services = (kernel.services as unknown[]) ?? [];
  const contexts = (kernel.contexts as unknown[]) ?? [];
  const accounts = (identity.accounts as unknown[]) ?? [];
  const programList = (programs.programs as unknown[]) ?? [];
  const marketplaceStats = (programs.marketplace as { stats?: { total?: number; published?: number } })?.stats ?? {};
  const auditCounts = (identity.audit as { count?: Record<string, number> })?.count ?? {};
  const totalAudit = Object.values(auditCounts).reduce((a, b) => a + (b as number), 0);
  const sessions = (identity.sessions as { stats?: { active?: number; total?: number } })?.stats ?? {};

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-xl border border-border bg-card p-6 eks-grid-bg">
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-[var(--brand-muted)] px-3 py-1 text-xs font-medium text-[var(--brand)] mb-3">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)] animate-pulse" />
            Milestone 3 — Extension Runtime &amp; Program Operating System
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight max-w-3xl">
            Eks-Health Preventive Health Operating System
          </h1>
          <p className="mt-3 text-muted-foreground max-w-2xl text-sm sm:text-base">
            A production-grade platform kernel and zero-trust identity foundation.
            Extension-first, API-first, event-driven, privacy-by-design. Built so
            every future service, program, and AI agent plugs in without restructuring the kernel.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {["Zero-Trust", "PBAC", "Privacy-by-Design", "Multi-Tenant", "Event-Driven", "AI-Native"].map((t) => (
              <span key={t} className="rounded-md border border-border bg-background/60 px-2.5 py-1 text-xs font-mono text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Kernel Services" value={services.length} hint={`${contexts.length} bounded contexts`} />
        <StatCard label="Identity Accounts" value={accounts.length} hint="across all personas" />
        <StatCard label="Programs" value={programList.length} hint={`${marketplaceStats.published ?? 0} published`} accent />
        <StatCard label="Audit Events" value={totalAudit} hint="hash-chained, immutable" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Platform Layers">
          <div className="space-y-3">
            <LayerRow icon={<Boxes className="h-4 w-4" />} name="Platform Kernel" desc="16 subsystems: events, config, flags, scheduler, observability, storage, search, gateway, security, AI readiness" version="v1.0.0-m1" />
            <LayerRow icon={<Lock className="h-4 w-4" />} name="Identity Platform" desc="15 subsystems: accounts, auth, sessions, devices, orgs, roles, authorization, consent, privacy, audit, monitoring, compliance" version="v2.0.0-m2" />
            <LayerRow icon={<Layers className="h-4 w-4" />} name="Program Operating System" desc="16 subsystems: manifests, capabilities, lifecycle, sandbox, quotas, storage, events, certification, SDK, testing, dependencies, marketplace, observability, developer, execution" version="v3.0.0-m3" active />
            <LayerRow icon={<Zap className="h-4 w-4" />} name="Health Programs" desc="Cardio, sleep, nutrition, fitness, mental wellness — built ON the runtime, not in it" version="on runtime" />
          </div>
        </Panel>

        <Panel title="Guiding Principles">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[
              ["Extension-first", "Every capability is replaceable"],
              ["API-first", "Contracts before implementations"],
              ["Event-driven", "Everything communicates via events"],
              ["Domain-driven", "Clean bounded contexts"],
              ["AI-native", "Agent runtime prepared"],
              ["Multi-tenant", "Isolation from line one"],
              ["Privacy-by-design", "Consent &amp; minimization first"],
              ["Cloud-native", "Horizontally scalable"],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-md border border-border/60 p-2.5">
                <p className="text-xs font-medium">{title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PrincipleCard icon={<ShieldCheck className="h-5 w-5" />} title="Zero Trust" desc="No program gains access by default. Every request is authenticated, authorized, consent-checked, and audited." />
        <PrincipleCard icon={<Users className="h-5 w-5" />} title="Personas, not apps" desc="One account, many roles. Switch between Participant, Technician, Developer, Researcher seamlessly." />
        <PrincipleCard icon={<Globe2 className="h-5 w-5" />} title="Global by design" desc="Timezones, locales, residency rules, and regional compliance frameworks built into the foundation." />
      </div>
    </div>
  );
}

function LayerRow({ icon, name, desc, version, active }: { icon: React.ReactNode; name: string; desc: string; version: string; active?: boolean }) {
  return (
    <div className={`flex items-start gap-3 rounded-md border p-3 ${active ? "border-[var(--brand)]/40 bg-[var(--brand-muted)]/20" : "border-border/60"}`}>
      <div className={`mt-0.5 ${active ? "text-[var(--brand)]" : "text-muted-foreground"}`}>{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{name}</p>
          <Mono className="text-muted-foreground">{version}</Mono>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5" dangerouslySetInnerHTML={{ __html: desc }} />
      </div>
    </div>
  );
}

function PrincipleCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-muted)] text-[var(--brand)] mb-3">
        {icon}
      </div>
      <p className="font-medium text-sm">{title}</p>
      <p className="text-xs text-muted-foreground mt-1">{desc}</p>
    </div>
  );
}
