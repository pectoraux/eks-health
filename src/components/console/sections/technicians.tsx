"use client";

import { Stethoscope, RefreshCw, ShieldCheck, BadgeCheck, Star, MapPin, Languages } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface TechRow {
  id: string; accountId: string; category: string; displayName: string;
  languages: string[]; regionsServed: string[]; skills: string[];
  supportedPrograms: string[]; rating?: number; reviewCount: number;
  totalSessions: number; verifiedSessions: number; disputedSessions: number;
  status: string; createdAt: string;
}

export function TechniciansSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const techs = (data.technicians as { technicians?: TechRow[]; technicianStats?: { total?: number; active?: number; suspended?: number; totalSessions?: number; avgRating?: number }; certifications?: { types?: Array<{ slug: string; name: string; level: string }>; stats?: { totalTypes?: number; totalCerts?: number; activeCerts?: number } }; accreditation?: { authorities?: Array<{ name: string; type: string; jurisdiction?: string; verified: boolean; trustLevel: string }>; stats?: { totalAuthorities?: number; verifiedAuthorities?: number } }; devices?: { recent?: Array<{ serialNumber: string; model: string; type: string; trustLevel: string; status: string; certified: boolean }> }; fraud?: { stats?: { totalAlerts?: number; openAlerts?: number }; recentAlerts?: Array<{ type: string; severity: string; status: string }> } }) ?? {};
  const techList = techs.technicians ?? [];
  const stats = techs.technicianStats ?? {};
  const certTypes = techs.certifications?.types ?? [];
  const certStats = techs.certifications?.stats ?? {};
  const authorities = techs.accreditation?.authorities ?? [];
  const accredStats = techs.accreditation?.stats ?? {};
  const devices = techs.devices?.recent ?? [];
  const fraudStats = techs.fraud?.stats ?? {};
  const fraudAlerts = techs.fraud?.recentAlerts ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Health Technician Network"
        subtitle="The global trust infrastructure for health measurements. Programs define who is eligible to measure; the platform provides the programmable trust network. NOT a directory — a certification, eligibility, and verification engine."
        icon={<Stethoscope className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Technicians" value={stats.total ?? 0} hint={`${stats.active ?? 0} active`} accent />
        <StatCard label="Sessions" value={stats.totalSessions ?? 0} />
        <StatCard label="Cert Types" value={certStats.totalTypes ?? 0} hint={`${certStats.activeCerts ?? 0} active certs`} />
        <StatCard label="Authorities" value={accredStats.totalAuthorities ?? 0} hint={`${accredStats.verifiedAuthorities ?? 0} verified`} />
      </div>

      <Panel title="Technician Registry">
        <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Technician</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Skills</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {techList.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm">{t.displayName}</div>
                    <Mono className="text-muted-foreground">{t.id.slice(0, 20)}…</Mono>
                  </TableCell>
                  <TableCell><span className="text-xs font-mono">{t.category}</span></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-0.5">
                      {t.skills.slice(0, 2).map((s) => <Mono key={s} className="text-[10px] text-muted-foreground">{s}</Mono>)}
                      {t.skills.length > 2 && <Mono className="text-[10px] text-muted-foreground">+{t.skills.length - 2}</Mono>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <MapPin className="h-3 w-3 text-muted-foreground" />
                      <span className="text-xs">{t.regionsServed.join(",")}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs">
                      <span className="font-medium">{t.verifiedSessions}</span>
                      <span className="text-muted-foreground">/{t.totalSessions}</span>
                    </div>
                    {t.disputedSessions > 0 && <span className="text-[10px] text-amber-500">{t.disputedSessions} disputed</span>}
                  </TableCell>
                  <TableCell>
                    {t.rating ? (
                      <div className="flex items-center gap-0.5">
                        <Star className="h-3 w-3 fill-[var(--brand)] text-[var(--brand)]" />
                        <span className="text-xs font-medium">{t.rating.toFixed(1)}</span>
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="pr-4"><StateBadge state={t.status} map={{ active: "default", suspended: "destructive", deactivated: "secondary" }} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Certification Types">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {certTypes.map((c) => (
              <div key={c.slug} className="rounded-md border border-border/60 p-2.5">
                <div className="flex items-center gap-1.5">
                  <BadgeCheck className="h-3.5 w-3.5 text-[var(--brand)]" />
                  <span className="text-xs font-medium">{c.name}</span>
                </div>
                <Mono className="text-[10px] text-muted-foreground">{c.slug}</Mono>
                <div className="flex items-center gap-1 mt-1">
                  <span className="text-[10px] text-muted-foreground">level:</span>
                  <Mono className="text-[10px]">{c.level}</Mono>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Accreditation Authorities">
          <div className="space-y-1.5">
            {authorities.map((a) => (
              <div key={a.name} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                <div>
                  <span className="font-medium">{a.name}</span>
                  <div className="flex items-center gap-1 mt-0.5">
                    <Mono className="text-[10px] text-muted-foreground">{a.type}</Mono>
                    {a.jurisdiction && <Mono className="text-[10px] text-muted-foreground">· {a.jurisdiction}</Mono>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {a.verified && <ShieldCheck className="h-3.5 w-3.5 text-[var(--brand)]" />}
                  <span className={`text-[10px] font-mono ${a.trustLevel === "authoritative" ? "text-[var(--brand)]" : "text-muted-foreground"}`}>{a.trustLevel}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Measurement Devices">
          {devices.length === 0 ? <p className="text-xs text-muted-foreground">No devices registered.</p> : (
            <div className="space-y-1.5">
              {devices.map((d) => (
                <div key={d.serialNumber} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                  <div>
                    <span className="font-medium">{d.model}</span>
                    <Mono className="text-[10px] text-muted-foreground block">{d.serialNumber}</Mono>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {d.certified && <BadgeCheck className="h-3.5 w-3.5 text-[var(--brand)]" />}
                    <span className={`text-[10px] font-mono ${d.trustLevel === "certified" || d.trustLevel === "clinical" ? "text-[var(--brand)]" : "text-muted-foreground"}`}>{d.trustLevel}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Fraud Detection">
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="text-center rounded-md border border-border/60 p-2">
              <p className="text-lg font-semibold">{fraudStats.totalAlerts ?? 0}</p>
              <Mono className="text-[10px] text-muted-foreground">total</Mono>
            </div>
            <div className="text-center rounded-md border border-border/60 p-2">
              <p className="text-lg font-semibold text-amber-500">{fraudStats.openAlerts ?? 0}</p>
              <Mono className="text-[10px] text-muted-foreground">open</Mono>
            </div>
            <div className="text-center rounded-md border border-border/60 p-2">
              <p className="text-lg font-semibold text-[var(--brand)]">{(fraudStats.totalAlerts ?? 0) - (fraudStats.openAlerts ?? 0)}</p>
              <Mono className="text-[10px] text-muted-foreground">resolved</Mono>
            </div>
          </div>
          {fraudAlerts.length > 0 && (
            <div className="space-y-1">
              {fraudAlerts.map((a) => (
                <div key={a.type} className="flex items-center justify-between text-xs">
                  <Mono className="text-muted-foreground">{a.type}</Mono>
                  <span className={`text-[10px] ${a.severity === "critical" ? "text-red-500" : a.severity === "high" ? "text-amber-500" : "text-muted-foreground"}`}>{a.severity}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
