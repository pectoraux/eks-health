"use client";

import { HeartPulse, Database, Ruler, Activity, ShieldCheck, GitBranch, FileLock2, Stethoscope } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function HealthOverviewSection({ data }: { data: PlatformSnapshot }) {
  const health = (data.health as Record<string, unknown>) ?? {};
  const schemas = (health.schemas as Array<{ id: string; slug: string; name: string; category: string; valueType: string }>) ?? [];
  const units = (health.units as { total?: number; categories?: string[]; systems?: string[]; sample?: Array<{ id: string; symbol: string; name: string; category: string; system: string }> }) ?? {};
  const sources = (health.sources as Array<{ id: string; type: string; label: string; trustLevel: string; verified: boolean }>) ?? [];
  const measurements = (health.measurements as { stats?: { total?: number; bySchema?: Record<string, number>; byVerification?: Record<string, number> }; recent?: unknown[] }) ?? {};
  const verification = (health.verification as { pending?: number; verified?: number; rejected?: number }) ?? {};
  const profiles = (health.profiles as Array<{ id: string; accountId: string; programCount: number; deviceCount: number }>) ?? [];
  const composite = (health.composite as { metrics?: Array<{ id: string; name: string; componentCount: number }> }) ?? {};
  const derived = (health.derived as { metrics?: Array<{ id: string; slug: string; name: string; inputs: string[] }> }) ?? {};
  const interop = (health.analytics as { interopProviders?: Array<{ id: string; label: string; direction: string }> }) ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Universal Health Data Platform"
        subtitle="The world's most secure measurement & health record infrastructure. NOT an EMR. NOT disease-specific. Programs define schemas; the platform validates and stores them generically. Users own an immutable, versioned, consent-controlled health timeline."
        icon={<HeartPulse className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Measurement Schemas" value={schemas.length} accent hint="program-defined" />
        <StatCard label="Total Measurements" value={measurements.stats?.total ?? 0} />
        <StatCard label="Units" value={units.total ?? 0} hint={`${units.categories?.length ?? 0} categories`} />
        <StatCard label="Sources" value={sources.length} hint="trusted data origins" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Verified" value={verification.verified ?? 0} />
        <StatCard label="Pending" value={verification.pending ?? 0} />
        <StatCard label="Profiles" value={profiles.length} />
        <StatCard label="Interop Providers" value={interop.interopProviders?.length ?? 0} hint="FHIR, Apple, Google" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Core Principle">
          <div className="space-y-3">
            <div className="rounded-md border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-3">
              <p className="text-sm font-medium text-[var(--brand)]">The platform knows ONLY generic concepts</p>
              <div className="flex flex-wrap gap-1 mt-2">
                {["Measurement", "Metric", "Observation", "Evidence", "Verification", "Timeline", "Unit", "Schema", "Validation", "Source", "Consent"].map((c) => (
                  <span key={c} className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-mono">{c}</span>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-3">
              <p className="text-sm font-medium">Everything else is defined by Programs</p>
              <p className="text-xs text-muted-foreground mt-1">Weight, blood pressure, HbA1c, VO₂ Max, mood, sleep, steps — all introduced by Programs through schemas. The platform never hardcodes them.</p>
            </div>
          </div>
        </Panel>

        <Panel title="Platform Capabilities">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <CapRow icon={<Database className="h-4 w-4" />} name="Schema Framework" desc="Programs define measurement types" />
            <CapRow icon={<Ruler className="h-4 w-4" />} name="Unit System" desc="Metric, imperial, medical, custom" />
            <CapRow icon={<Activity className="h-4 w-4" />} name="Immutable Timeline" desc="Version history, corrections, time-travel" />
            <CapRow icon={<ShieldCheck className="h-4 w-4" />} name="Verification" desc="Pending → verified → rejected state machine" />
            <CapRow icon={<FileLock2 className="h-4 w-4" />} name="Evidence" desc="SHA-256 hashed, integrity-verified" />
            <CapRow icon={<GitBranch className="h-4 w-4" />} name="Provenance" desc="Full traceability: who/what/when/where" />
            <CapRow icon={<Stethoscope className="h-4 w-4" />} name="Composite & Derived" desc="BMI, risk scores, trends, formulas" />
            <CapRow icon={<HeartPulse className="h-4 w-4" />} name="Interop" desc="FHIR R4, HL7, CSV, Apple Health, Google" />
          </div>
        </Panel>
      </div>

      <Panel title="Demo Measurement Schemas">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {schemas.map((s) => (
            <div key={s.id} className="rounded-md border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{s.name}</p>
                <Mono className="text-[10px] text-muted-foreground">{s.valueType}</Mono>
              </div>
              <Mono className="text-[10px] text-[var(--brand)]">{s.slug}</Mono>
              <p className="text-[11px] text-muted-foreground mt-1 capitalize">{s.category}</p>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Measurement Sources">
          <div className="space-y-1.5">
            {sources.map((src) => (
              <div key={src.id} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{src.label}</span>
                  <Mono className="text-muted-foreground">{src.type}</Mono>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-mono ${src.trustLevel === "clinical" || src.trustLevel === "authoritative" ? "text-[var(--brand)]" : "text-muted-foreground"}`}>{src.trustLevel}</span>
                  {src.verified && <span className="text-[var(--brand)]">✓</span>}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Derived & Composite Metrics">
          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Derived (auto-computed)</p>
              <div className="flex flex-wrap gap-1">
                {(derived.metrics ?? []).map((m) => (
                  <span key={m.id} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">{m.slug}</span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Composite (program-defined)</p>
              <div className="flex flex-wrap gap-1">
                {(composite.metrics ?? []).map((m) => (
                  <span key={m.id} className="rounded bg-[var(--brand-muted)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--brand)]">{m.name}</span>
                ))}
                {(composite.metrics ?? []).length === 0 && <span className="text-xs text-muted-foreground">No composites registered yet</span>}
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function CapRow({ icon, name, desc }: { icon: React.ReactNode; name: string; desc: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-border/40 p-2.5">
      <div className="text-[var(--brand)] mt-0.5">{icon}</div>
      <div>
        <p className="text-xs font-medium">{name}</p>
        <p className="text-[11px] text-muted-foreground">{desc}</p>
      </div>
    </div>
  );
}
