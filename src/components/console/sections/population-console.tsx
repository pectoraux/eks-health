"use client";

import { Building2, ShieldCheck, Coins, Megaphone, BarChart3, Brain, Users, Zap } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function PopulationSection({ data }: { data: PlatformSnapshot }) {
  const p = (data.population as Record<string, unknown>) ?? {};
  const organizations = (p.organizations as Array<{ id: string; name: string; slug: string; type: string; tier: string; country: string; memberCount: number; activeMemberCount: number; status: string; parentId?: string }>) ?? [];
  const orgStats = (p.orgStats as { total?: number; byType?: Record<string, number>; active?: number; totalMembers?: number }) ?? {};
  const membership = (p.membership as { total?: number; active?: number; invited?: number }) ?? {};
  const privacy = (p.privacy as { total?: number; active?: number; byType?: Record<string, number> }) ?? {};
  const funding = (p.funding as { totalPolicies?: number; totalRequests?: number; totalFunded?: number }) ?? {};
  const campaigns = (p.campaigns as { list?: Array<{ id: string; name: string; status: string; scope: string; participationGoal: number; actualParticipation: number }>; stats?: { total?: number; active?: number; completed?: number } }) ?? {};
  const policies = (p.policies as { total?: number; active?: number }) ?? {};
  const orgAI = (p.orgAI as { total?: number; avgConfidence?: number }) ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Population Platform"
        subtitle="Infrastructure for managing the health of entire populations. Organizations sponsor Programs, fund competitions, analyze aggregate outcomes — but never own participant health data. Individual privacy always takes precedence over organizational interests. The Privacy Firewall is the defining capability."
        icon={<Building2 className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Organizations" value={orgStats.total ?? 0} hint={`${orgStats.active ?? 0} active`} accent />
        <StatCard label="Members" value={membership.active ?? 0} hint={`${membership.total ?? 0} total`} />
        <StatCard label="Privacy Grants" value={privacy.active ?? 0} hint="participant-controlled" />
        <StatCard label="Campaigns" value={campaigns.stats?.active ?? 0} hint={`${campaigns.stats?.total ?? 0} total`} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Funding Policies" value={funding.totalPolicies ?? 0} />
        <StatCard label="Funding Requests" value={funding.totalRequests ?? 0} />
        <StatCard label="Org Policies" value={policies.active ?? 0} />
        <StatCard label="AI Insights" value={orgAI.total ?? 0} hint={`avg confidence: ${orgAI.avgConfidence?.toFixed(2) ?? "—"}`} />
      </div>

      <Panel title="Organizations">
        <div className="max-h-[24rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Organization</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Members</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {organizations.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm">{o.name}</div>
                    <Mono className="text-muted-foreground">{o.slug}</Mono>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px] font-mono">{o.type}</Badge></TableCell>
                  <TableCell><span className="text-xs">{o.tier}</span></TableCell>
                  <TableCell><span className="text-xs">{o.country}</span></TableCell>
                  <TableCell><Mono className="text-xs">{o.activeMemberCount}/{o.memberCount}</Mono></TableCell>
                  <TableCell className="pr-4"><Badge variant={o.status === "active" ? "default" : "destructive"} className="text-[10px]">{o.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Privacy Firewall">
          <div className="rounded-md border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-3 mb-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--brand)] mt-0.5 shrink-0" />
              <div>
                <p className="text-xs font-medium text-[var(--brand)]">Organizations see aggregates only</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Employer funds Weight Program → can see 85% participation, average improvement, retention, engagement.
                  Cannot see John's weight, Mary's blood pressure, individual AI recommendations, private measurements.
                  Unless participant explicitly grants permission — purpose-bound, revocable, auditable, time-limited.
                </p>
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            {[
              { type: "attendance_only", desc: "Only attendance/participation status" },
              { type: "competition_status", desc: "Competition rank + score" },
              { type: "aggregate_performance", desc: "Aggregate improvement + completion" },
              { type: "specific_measurement", desc: "Specific measurements (field-level consent)" },
              { type: "wellness_certificate", desc: "Wellness certificates + badges" },
              { type: "achievements", desc: "Achievements + streaks + milestones" },
              { type: "program_progress", desc: "Program completion percentage" },
            ].map((g) => (
              <div key={g.type} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                <div>
                  <span className="font-medium">{g.type.replace(/_/g, " ")}</span>
                  <p className="text-[10px] text-muted-foreground">{g.desc}</p>
                </div>
                <span className="text-[var(--brand)] text-xs">{privacy.byType?.[g.type] ?? 0}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Campaigns">
          <div className="space-y-2">
            {(campaigns.list ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-2.5">
                  <Megaphone className="h-4 w-4 text-[var(--brand)]" />
                  <div>
                    <p className="text-sm font-medium">{c.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className="text-[10px]">{c.scope}</Badge>
                      <span className="text-[10px] text-muted-foreground">{c.actualParticipation}/{c.participationGoal} participants</span>
                    </div>
                  </div>
                </div>
                <Badge variant={c.status === "active" ? "default" : "secondary"} className="text-[10px]">{c.status}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Population Platform Capabilities">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            { icon: <Building2 className="h-4 w-4" />, name: "Organization Hierarchy", desc: "Unlimited depth — Government → Ministry → Region → District → Community" },
            { icon: <Users className="h-4 w-4" />, name: "Membership Engine", desc: "Invitations, roles, departments, teams, delegated admin, temporary, multi-org" },
            { icon: <ShieldCheck className="h-4 w-4" />, name: "Privacy Firewall", desc: "Organizations see aggregates only. Individual data requires explicit grant." },
            { icon: <Coins className="h-4 w-4" />, name: "Funding Engine", desc: "Sponsor programs, measurements, technicians, prizes, AI coaching — NO payment processing" },
            { icon: <Megaphone className="h-4 w-4" />, name: "Public Health Campaigns", desc: "Hypertension Awareness, Diabetes Prevention, Maternal Health, Youth Fitness" },
            { icon: <BarChart3 className="h-4 w-4" />, name: "Population Analytics", desc: "Participation, adoption, improvement, retention, engagement — aggregate only" },
            { icon: <Brain className="h-4 w-4" />, name: "Organization AI", desc: "Forecasting, recommendations, budget optimization — never exposes individual data" },
            { icon: <Building2 className="h-4 w-4" />, name: "Org Digital Twin", desc: "Population health, adoption, engagement, risks, budgets, evidence — aggregated" },
            { icon: <Zap className="h-4 w-4" />, name: "Multi-Org Coordination", desc: "Resolves funding conflicts, program duplication, competition overlap, permission conflicts" },
          ].map((c) => (
            <div key={c.name} className="flex items-start gap-2.5 rounded-md border border-border/40 p-2.5">
              <div className="text-[var(--brand)] mt-0.5">{c.icon}</div>
              <div>
                <p className="text-xs font-medium">{c.name}</p>
                <p className="text-[11px] text-muted-foreground">{c.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
