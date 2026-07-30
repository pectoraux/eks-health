"use client";

import { MonitorSmartphone, RefreshCw, LogOut } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard, EmptyState } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function SessionsSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const identity = data.identity as Record<string, unknown>;
  const sessionsData = (identity.sessions as { stats?: { total: number; active: number; revoked: number; expired: number }; recent?: Array<{ id: string; accountId: string; persona: string; state: string; createdAt: string; expiresAt: string; lastActiveAt: string; riskScore: number; ipAddress?: string; device?: { label: string } }> }) ?? { stats: {}, recent: [] };
  const stats = sessionsData.stats ?? { total: 0, active: 0, revoked: 0, expired: 0 };
  const sessions = sessionsData.recent ?? [];

  async function revoke(sessionId: string) {
    const res = await apiPost(`/api/identity/sessions/${sessionId}`, {}, "DELETE");
    if (res.ok) {
      toast.success("Session revoked");
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Sessions"
        subtitle="Short-lived access tokens, refresh-token rotation, idle & absolute timeouts, concurrent-session limits, risk-based re-auth. Tokens are opaque (store is source of truth) for instant revocation."
        icon={<MonitorSmartphone className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Sessions" value={stats.total} />
        <StatCard label="Active" value={stats.active} accent />
        <StatCard label="Expired" value={stats.expired} />
        <StatCard label="Revoked" value={stats.revoked} />
      </div>

      <Panel title="Session Policy (default)">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-sm">
          <div><p className="text-xs text-muted-foreground">Access token</p><Mono>15 min</Mono></div>
          <div><p className="text-xs text-muted-foreground">Refresh token</p><Mono>7 days</Mono></div>
          <div><p className="text-xs text-muted-foreground">Absolute cap</p><Mono>30 days</Mono></div>
          <div><p className="text-xs text-muted-foreground">Idle timeout</p><Mono>1 hour</Mono></div>
          <div><p className="text-xs text-muted-foreground">Max concurrent</p><Mono>10</Mono></div>
        </div>
      </Panel>

      <Panel title="Recent Sessions">
        {sessions.length === 0 ? <EmptyState message="No sessions yet. Sign in to create one." /> : (
          <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Session</TableHead>
                  <TableHead>Persona</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="pr-4"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="pl-4">
                      <Mono className="text-xs">{s.id}</Mono>
                      <Mono className="text-[10px] text-muted-foreground">acc: {s.accountId.slice(0, 16)}…</Mono>
                    </TableCell>
                    <TableCell><span className="text-xs font-mono">{s.persona}</span></TableCell>
                    <TableCell><StateBadge state={s.state} map={{ active: "default", expired: "secondary", revoked: "destructive", reauth_required: "destructive" }} /></TableCell>
                    <TableCell>
                      <span className={`text-xs font-mono ${s.riskScore >= 50 ? "text-amber-500" : s.riskScore >= 25 ? "text-muted-foreground" : "text-[var(--brand)]"}`}>{s.riskScore}</span>
                    </TableCell>
                    <TableCell className="text-xs">{s.device?.label ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(s.createdAt).toLocaleString()}</TableCell>
                    <TableCell className="pr-4">
                      {s.state === "active" && <Button variant="ghost" size="sm" onClick={() => revoke(s.id)}><LogOut className="h-3.5 w-3.5" /></Button>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Panel>
    </div>
  );
}
