"use client";

import { Boxes } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function KernelSection({ data }: { data: PlatformSnapshot }) {
  const kernel = data.kernel as Record<string, unknown>;
  const info = (kernel.info as { name: string; version: string; subsystems: string[] }) ?? { name: "", version: "", subsystems: [] };
  const services = (kernel.services as Array<{ id: string; name: string; category: string; state: string; sla: string; dataClassification: string; extensibility: string }>) ?? [];
  const eventBus = (kernel.eventBus as { published: number; delivered: number; failed: number; deadLettered: number; activeSubscriptions: number }) ?? {};
  const topology = (kernel.topology as Array<{ category: string; count: number; services: string[] }>) ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Platform Kernel"
        subtitle="The operating-system core. 16 subsystems providing events, configuration, feature flags, scheduling, observability, storage, search, gateway, security, and AI readiness."
        icon={<Boxes className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Panel><div className="text-center"><p className="text-2xl font-semibold text-[var(--brand)]">{info.subsystems?.length ?? 0}</p><p className="text-xs text-muted-foreground mt-1">subsystems</p></div></Panel>
        <Panel><div className="text-center"><p className="text-2xl font-semibold">{services.length}</p><p className="text-xs text-muted-foreground mt-1">services</p></div></Panel>
        <Panel><div className="text-center"><p className="text-2xl font-semibold">{eventBus.published ?? 0}</p><p className="text-xs text-muted-foreground mt-1">events published</p></div></Panel>
        <Panel><div className="text-center"><p className="text-2xl font-semibold">{eventBus.activeSubscriptions ?? 0}</p><p className="text-xs text-muted-foreground mt-1">subscriptions</p></div></Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Kernel Subsystems">
          <div className="flex flex-wrap gap-1.5 max-h-64 overflow-y-auto eks-scroll">
            {info.subsystems?.map((s) => (
              <span key={s} className="rounded-md bg-muted px-2 py-1 text-xs font-mono">{s}</span>
            ))}
          </div>
        </Panel>
        <Panel title="Service Topology">
          <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll">
            {topology.map((t) => (
              <div key={t.category} className="flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground">{t.category}</span>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{t.count}</span>
                  {t.count > 0 && <span className="text-muted-foreground">· {t.services.join(", ")}</span>}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Service Registry">
        <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Service</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>State</TableHead>
                <TableHead>SLA</TableHead>
                <TableHead>Classification</TableHead>
                <TableHead className="pr-4">Extensibility</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm">{s.name}</div>
                    <Mono className="text-muted-foreground">{s.id}</Mono>
                  </TableCell>
                  <TableCell><span className="text-xs font-mono text-muted-foreground">{s.category}</span></TableCell>
                  <TableCell><StateBadge state={s.state} map={{ active: "default", provisioning: "secondary", degraded: "destructive", maintenance: "secondary" }} /></TableCell>
                  <TableCell><Mono>{s.sla}</Mono></TableCell>
                  <TableCell><span className="text-xs">{s.dataClassification}</span></TableCell>
                  <TableCell className="pr-4"><span className="text-xs">{s.extensibility}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
