"use client";

import { Package, RefreshCw, Boxes, ShieldCheck, Cpu, HardDrive } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface ProgramRow {
  id: string; slug: string; name: string; kind: string; category: string;
  state: string; versionCount: number; installedCount: number; activeInstallCount: number;
  rating?: number; reviewCount: number; createdAt: string; publishedAt?: string;
}

export function ProgramsSection({
  data,
  onRefresh,
  onSelectProgram,
}: {
  data: PlatformSnapshot;
  onRefresh: () => void;
  onSelectProgram: (id: string) => void;
}) {
  const programs = (data.programs as { programs?: ProgramRow[] }).programs ?? [];
  const capabilities = (data.programs as { capabilities?: { catalog?: unknown[]; grants?: unknown[] } }).capabilities ?? {};
  const sandbox = (data.programs as { sandbox?: { sandboxes?: unknown[]; violations?: unknown[] } }).sandbox ?? {};
  const execution = (data.programs as { execution?: { stats?: { total?: number; completed?: number; failed?: number; deadLettered?: number }; recentJobs?: unknown[] } }).execution ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Programs"
        subtitle="The Program Operating System hosts third-party health programs in secure, isolated, capability-bounded sandboxes. The platform knows only generic concepts — never disease-specific logic. Cardio, sleep, nutrition programs all run identically."
        icon={<Package className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Programs" value={programs.length} accent />
        <StatCard label="Published" value={programs.filter((p) => p.state === "published").length} />
        <StatCard label="Capabilities" value={(capabilities.catalog?.length ?? 0)} hint={`${capabilities.grants?.length ?? 0} grants`} />
        <StatCard label="Sandboxes" value={sandbox.sandboxes?.length ?? 0} hint={`${sandbox.violations?.length ?? 0} violations`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <StatCard label="Jobs Total" value={execution.stats?.total ?? 0} />
        <StatCard label="Jobs Completed" value={execution.stats?.completed ?? 0} />
        <StatCard label="Jobs Failed" value={execution.stats?.failed ?? 0} />
      </div>

      <Panel title="Program Registry">
        <div className="max-h-[32rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Program</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Versions</TableHead>
                <TableHead>Installs</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead className="pr-4"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {programs.map((p) => (
                <TableRow key={p.id} className="cursor-pointer hover:bg-accent/50" onClick={() => onSelectProgram(p.id)}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm flex items-center gap-1.5">
                      {p.kind === "extension" ? <Boxes className="h-3.5 w-3.5 text-muted-foreground" /> : <Package className="h-3.5 w-3.5 text-[var(--brand)]" />}
                      {p.name}
                    </div>
                    <Mono className="text-muted-foreground">{p.slug}</Mono>
                  </TableCell>
                  <TableCell><span className="text-xs font-mono text-muted-foreground">{p.category}</span></TableCell>
                  <TableCell><StateBadge state={p.state} map={{ draft: "secondary", published: "default", certified: "default", installed: "default", active: "default", deprecated: "secondary", archived: "secondary", rejected: "destructive", in_review: "secondary" }} /></TableCell>
                  <TableCell><Mono>{p.versionCount}</Mono></TableCell>
                  <TableCell><Mono>{p.activeInstallCount}/{p.installedCount}</Mono></TableCell>
                  <TableCell>{p.rating ? <span className="text-xs font-medium text-[var(--brand)]">{p.rating.toFixed(1)}★</span> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="pr-4"><Button variant="ghost" size="sm">View</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Capability System">
          <p className="text-xs text-muted-foreground mb-3">Programs request capabilities; every capability is independently granted, consent-checked, and quota-bounded.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-64 overflow-y-auto eks-scroll">
            {(capabilities.catalog as { id: string; label: string; sensitive: boolean; requiresConsent: boolean }[] | undefined)?.map((c) => (
              <div key={c.id} className={`rounded-md border p-2 ${c.sensitive ? "border-amber-500/30 bg-amber-500/5" : "border-border/60"}`}>
                <div className="flex items-center gap-1">
                  {c.sensitive && <ShieldCheck className="h-3 w-3 text-amber-500" />}
                  <span className="text-xs font-mono">{c.id}</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">{c.label}</p>
                {c.requiresConsent && <p className="text-[10px] text-[var(--brand)]">consent</p>}
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Runtime Isolation">
          <div className="space-y-2">
            {[
              { icon: <Cpu className="h-4 w-4" />, name: "Memory", desc: "Per-program memory ceiling enforced" },
              { icon: <HardDrive className="h-4 w-4" />, name: "Storage", desc: "Namespaced: program:<id>:storage: — cross-program access blocked" },
              { icon: <ShieldCheck className="h-4 w-4" />, name: "Secrets", desc: "Platform secrets never accessible; per-program encryption keys" },
              { icon: <Boxes className="h-4 w-4" />, name: "Failures", desc: "Programs never interfere with each other" },
            ].map((b) => (
              <div key={b.name} className="flex items-start gap-2.5 rounded-md border border-border/40 p-2.5">
                <div className="text-[var(--brand)] mt-0.5">{b.icon}</div>
                <div>
                  <p className="text-xs font-medium">{b.name}</p>
                  <p className="text-[11px] text-muted-foreground">{b.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
