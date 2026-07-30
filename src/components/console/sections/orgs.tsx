"use client";

import { useState } from "react";
import { Building2, RefreshCw, UserPlus, Mail } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function OrgsSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const identity = data.identity as Record<string, unknown>;
  const orgs = (identity.organizations as Array<{
    id: string; name: string; type: string; status: string; dataClassification: string;
    createdAt: string; parentId?: string;
  }>) ?? [];
  const accounts = (identity.accounts as Array<{ id: string; email: string; displayName: string }>) ?? [];

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", type: "clinic" });
  const [busy, setBusy] = useState(false);

  const orgTypes = ["hospital", "clinic", "company", "government", "university", "ngo", "insurance", "research_institution"];

  async function create() {
    if (!accounts[0]) { toast.error("Create an account first"); return; }
    setBusy(true);
    const res = await apiPost("/api/identity/orgs", { ...form, createdBy: accounts[0].id });
    setBusy(false);
    if (res.ok) {
      toast.success("Organization created");
      setForm({ name: "", type: "clinic" });
      setShowCreate(false);
      onRefresh();
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Organizations"
        subtitle="Hospitals, clinics, companies, governments, universities, NGOs, insurance, research. Membership, invitations, teams, departments, hierarchical orgs, and delegated administration."
        icon={<Building2 className="h-5 w-5" />}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>
            <Button size="sm" onClick={() => setShowCreate(!showCreate)}><Building2 className="h-3.5 w-3.5 mr-1.5" />New org</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Organizations" value={orgs.length} />
        <StatCard label="Types Supported" value={orgTypes.length} />
        <StatCard label="Hierarchical" value="yes" hint="parent/child with cycle detection" />
        <StatCard label="Invitations" value="7-day TTL" hint="single-use, hashed" />
      </div>

      {showCreate && (
        <Panel title="Create organization">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Accra Health Clinic" /></div>
            <div>
              <Label>Type</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                {orgTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create"}</Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
          </div>
        </Panel>
      )}

      <Panel title="Organization Types">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {orgTypes.map((t) => (
            <div key={t} className="rounded-md border border-border/60 p-2.5">
              <p className="text-xs font-mono capitalize">{t}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {["hospital", "clinic", "government", "insurance"].includes(t) ? "restricted" : ["company", "university", "research_institution"].includes(t) ? "confidential" : "internal"}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Organizations">
        {orgs.length === 0 ? <EmptyState message="No organizations yet." /> : (
          <div className="space-y-2">
            {orgs.map((o) => (
              <div key={o.id} className="flex items-center justify-between rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--brand-muted)] text-[var(--brand)]">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{o.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Mono className="text-muted-foreground">{o.id.slice(0, 16)}…</Mono>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="text-xs font-mono capitalize">{o.type}</span>
                      {o.parentId && <span className="text-xs text-muted-foreground">· child of {o.parentId.slice(0, 12)}…</span>}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{o.dataClassification}</span>
                  <Button variant="outline" size="sm"><UserPlus className="h-3.5 w-3.5 mr-1" />Member</Button>
                  <Button variant="ghost" size="sm"><Mail className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
