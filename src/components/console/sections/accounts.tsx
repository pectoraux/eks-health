"use client";

import { useState } from "react";
import { Users, UserPlus, ShieldCheck, BadgeCheck, RefreshCw } from "lucide-react";
import { SectionHeader, Panel, Mono, StateBadge, StatCard } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";
import { PERSONAS } from "./personas";

export function AccountsSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const identity = data.identity as Record<string, unknown>;
  const accounts = (identity.accounts as Array<{
    id: string; email: string; displayName: string; state: string;
    personas: string[]; activePersona: string; mfaEnabled: boolean;
    verified: boolean; createdAt: string;
  }>) ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: "", displayName: "", password: "", persona: "participant" });
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    const res = await apiPost<{ message?: string; accountId?: string; state?: string }>("/api/identity/accounts", form);
    setBusy(false);
    if (res.ok) {
      toast.success("Account created", { description: res.data?.message });
      setForm({ email: "", displayName: "", password: "", persona: "participant" });
      setShowCreate(false);
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.userMessage ?? res.error?.message });
    }
  }

  async function verify(accountId: string) {
    const res = await apiPost<{ code?: string }>(`/api/identity/accounts/${accountId}/verify`, {});
    if (res.ok && res.data?.code) {
      toast.success("Verification code issued", { description: `Code: ${res.data.code} (demo shows it inline)` });
      const verifyRes = await apiPost<{ verified?: boolean }>(`/api/identity/accounts/${accountId}/verify`, { code: res.data.code }, "PUT");
      if (verifyRes.ok) {
        toast.success("Account verified");
        onRefresh();
      }
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  async function switchPersona(accountId: string, persona: string) {
    const res = await apiPost<{ accountId?: string; previousPersona?: string; activePersona?: string }>(`/api/identity/accounts/${accountId}/persona`, { persona });
    if (res.ok) {
      toast.success(`Switched to ${persona}`, { description: `was ${res.data?.previousPersona}` });
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.userMessage ?? res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Accounts & Personas"
        subtitle="One identity, many roles. Accounts hold multiple personas and switch between them without creating duplicate identities. Passwords are PBKDF2-hashed; lockout after 5 failed attempts."
        icon={<Users className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}><UserPlus className="h-3.5 w-3.5 mr-1.5" />New account</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Accounts" value={accounts.length} />
        <StatCard label="Verified" value={accounts.filter((a) => a.verified).length} accent />
        <StatCard label="MFA Enabled" value={accounts.filter((a) => a.mfaEnabled).length} />
        <StatCard label="Active" value={accounts.filter((a) => a.state === "active").length} />
      </div>

      {showCreate && (
        <Panel title="Register new account">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Email</Label><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="user@eks.health" /></div>
            <div><Label>Display name</Label><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Jane Doe" /></div>
            <div><Label>Password</Label><Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 8 chars" /></div>
            <div>
              <Label>Persona</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })}>
                {PERSONAS.map((p) => <option key={p.persona} value={p.persona}>{p.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </Panel>
      )}

      <Panel title="Persona Catalog">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {PERSONAS.map((p) => (
            <div key={p.persona} className={`rounded-md border p-3 ${p.sensitive ? "border-amber-500/30 bg-amber-500/5" : "border-border/60"}`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{p.label}</p>
                {p.sensitive && <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">{p.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.defaultPermissions.slice(0, 2).map((perm) => (
                  <Mono key={perm} className="text-[10px] text-muted-foreground">{perm}</Mono>
                ))}
                {p.defaultPermissions.length > 2 && <Mono className="text-[10px] text-muted-foreground">+{p.defaultPermissions.length - 2}</Mono>}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Accounts">
        <div className="max-h-[32rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Account</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Personas</TableHead>
                <TableHead>MFA</TableHead>
                <TableHead className="pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm flex items-center gap-1.5">
                      {a.displayName}
                      {a.verified && <BadgeCheck className="h-3.5 w-3.5 text-[var(--brand)]" />}
                    </div>
                    <Mono className="text-muted-foreground">{a.email}</Mono>
                  </TableCell>
                  <TableCell><StateBadge state={a.state} map={{ active: "default", unverified: "secondary", suspended: "destructive", locked: "destructive", deleted: "destructive" }} /></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {a.personas.map((p) => (
                        <button
                          key={p}
                          onClick={() => switchPersona(a.id, p)}
                          className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${p === a.activePersona ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "bg-muted hover:bg-accent"}`}
                          title={p === a.activePersona ? "active — click to switch" : "click to switch"}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>{a.mfaEnabled ? <span className="text-[var(--brand)] text-xs">on</span> : <span className="text-muted-foreground text-xs">off</span>}</TableCell>
                  <TableCell className="pr-4">
                    {!a.verified && <Button variant="ghost" size="sm" onClick={() => verify(a.id)}>Verify</Button>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
