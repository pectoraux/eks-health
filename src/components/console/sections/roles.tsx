"use client";

import { useState } from "react";
import { ShieldCheck, RefreshCw, Sparkles } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function RolesSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const identity = data.identity as Record<string, unknown>;
  const rolesData = (identity.roles as { roles: Array<{ id: string; name: string; label: string; description: string; scope: string; permissions: string[]; sensitive: boolean; systemRole: boolean }>; assignments: Array<{ id: string; accountId: string; roleId: string; scope: string; scopeId?: string; active: boolean }> }) ?? { roles: [], assignments: [] };
  const roles = rolesData.roles ?? [];
  const assignments = rolesData.assignments ?? [];
  const accounts = (identity.accounts as Array<{ id: string; email: string; displayName: string; personas: string[] }>) ?? [];

  const [simAccount, setSimAccount] = useState("");
  const [simRole, setSimRole] = useState("");
  const [simResult, setSimResult] = useState<{ added: string[]; currentPermissions: string[]; simulatedPermissions: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  async function simulate() {
    if (!simAccount || !simRole) return;
    setBusy(true);
    const res = await apiPost<{ currentPermissions: string[]; simulatedPermissions: string[]; added: string[] }>("/api/identity/roles", { accountId: simAccount, roleName: simRole }, "PUT");
    setBusy(false);
    if (res.ok && res.data) {
      setSimResult(res.data);
      toast.success(`Simulation: +${res.data.added.length} permissions`);
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  async function assign(accountId: string, roleName: string) {
    const res = await apiPost("/api/identity/roles", { accountId, roleName, scope: "account" });
    if (res.ok) {
      toast.success(`Assigned ${roleName}`);
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  const roleByName = new Map(roles.map((r) => [r.name, r]));

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Roles & Permissions"
        subtitle="RBAC catalog: 35 permissions across 10 categories, 10 system roles. Real wildcard expansion (platform:*), org→team inheritance, and permission simulation for what-if planning."
        icon={<ShieldCheck className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Roles Defined" value={roles.length} accent />
        <StatCard label="Permissions" value={35} />
        <StatCard label="Active Assignments" value={assignments.length} />
        <StatCard label="Categories" value={10} />
      </div>

      <Panel title="Role Catalog">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-[28rem] overflow-y-auto eks-scroll">
          {roles.map((r) => (
            <div key={r.id} className={`rounded-md border p-3 ${r.sensitive ? "border-amber-500/30 bg-amber-500/5" : "border-border/60"}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{r.label}</p>
                  <Mono className="text-muted-foreground">{r.name} · {r.scope}</Mono>
                </div>
                <div className="flex items-center gap-1">
                  {r.systemRole && <Badge variant="outline" className="text-[10px]">system</Badge>}
                  {r.sensitive && <Badge variant="destructive" className="text-[10px]">sensitive</Badge>}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{r.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {r.permissions.slice(0, 4).map((p) => <Mono key={p} className="text-[10px] text-muted-foreground">{p}</Mono>)}
                {r.permissions.length > 4 && <Mono className="text-[10px] text-muted-foreground">+{r.permissions.length - 4}</Mono>}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Permission Simulation">
          <p className="text-xs text-muted-foreground mb-3">What-if: see which permissions an account would gain if a role were added.</p>
          <div className="space-y-3">
            <div>
              <Label>Account</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={simAccount} onChange={(e) => setSimAccount(e.target.value)}>
                <option value="">Select account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
              </select>
            </div>
            <div>
              <Label>Hypothetical role</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={simRole} onChange={(e) => setSimRole(e.target.value)}>
                <option value="">Select role…</option>
                {roles.map((r) => <option key={r.id} value={r.name}>{r.label}</option>)}
              </select>
            </div>
            <Button onClick={simulate} disabled={busy || !simAccount || !simRole}>
              <Sparkles className="h-4 w-4 mr-1.5" />Simulate
            </Button>
            {simResult && (
              <div className="rounded-md bg-muted/50 p-3 space-y-2">
                <div>
                  <p className="text-xs font-medium text-[var(--brand)]">+{simResult.added.length} new permissions</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {simResult.added.length === 0 ? <span className="text-xs text-muted-foreground">no change</span> : simResult.added.map((p) => <Mono key={p} className="text-[10px] text-[var(--brand)]">{p}</Mono>)}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">current: {simResult.currentPermissions.length} perms</p>
                  <p className="text-xs text-muted-foreground">after: {simResult.simulatedPermissions.length} perms</p>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Assignments">
          {assignments.length === 0 ? <EmptyState message="No active assignments." /> : (
            <div className="max-h-80 overflow-y-auto eks-scroll space-y-1.5">
              {assignments.map((a) => {
                const role = roleByName.get(a.roleId);
                const account = accounts.find((x) => x.id === a.accountId);
                return (
                  <div key={a.id} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                    <div>
                      <span className="font-medium">{account?.displayName ?? a.accountId.slice(0, 12)}</span>
                      <span className="text-muted-foreground"> → </span>
                      <span className="font-mono">{role?.name ?? a.roleId.slice(0, 12)}</span>
                    </div>
                    <Badge variant="outline" className="text-[10px]">{a.scope}</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-muted-foreground mb-1 block">{children}</label>;
}
