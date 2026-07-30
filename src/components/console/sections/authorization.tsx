"use client";

import { useState } from "react";
import { Scale, Gavel } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function AuthorizationSection({ data }: { data: PlatformSnapshot }) {
  const identity = data.identity as Record<string, unknown>;
  const accounts = (identity.accounts as Array<{ id: string; email: string; displayName: string; personas: string[]; activePersona: string }>) ?? [];

  const [accountId, setAccountId] = useState("");
  const [persona, setPersona] = useState("participant");
  const [permission, setPermission] = useState("measurement:self:read");
  const [purpose, setPurpose] = useState("");
  const [result, setResult] = useState<{ decision: string; reasons: string[]; permission: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function evaluate() {
    if (!accountId || !permission) return;
    setBusy(true);
    const res = await apiPost<{ decision: string; reasons: string[]; permission: string }>("/api/identity/authorize/evaluate", {
      accountId, persona, permission, purpose: purpose || undefined, mfaVerified: true,
    });
    setBusy(false);
    if (res.ok && res.data) {
      setResult(res.data);
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  const samplePerms = [
    "measurement:self:read",
    "measurement:collect",
    "marketplace:publish",
    "platform:config:manage",
    "org:members:manage",
    "research:dataset:read",
  ];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Authorization Engine"
        subtitle="Unified policy evaluation: RBAC + ABAC + PBAC + policy-based. Default-deny. Deny policies override allow. Hierarchical, conditional, temporary, and delegated permissions — all audited."
        icon={<Scale className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Model" value="RBAC+ABAC+PBAC" accent />
        <StatCard label="Default" value="Deny" hint="nothing granted implicitly" />
        <StatCard label="Built-in Policies" value={6} />
        <StatCard label="Sensitive Perms" value={8} hint="require MFA / verified email" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Policy Evaluation Playground">
          <div className="space-y-3">
            <div>
              <Label>Account</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Select account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName} ({a.activePersona})</option>)}
              </select>
            </div>
            <div>
              <Label>Persona (context)</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={persona} onChange={(e) => setPersona(e.target.value)}>
                {["participant", "developer", "health_technician", "researcher", "org_admin", "platform_admin", "marketplace_reviewer", "support_agent"].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <Label>Permission to check</Label>
              <Input value={permission} onChange={(e) => setPermission(e.target.value)} placeholder="measurement:self:read" />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {samplePerms.map((p) => (
                  <button key={p} onClick={() => setPermission(p)} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono hover:bg-accent">{p}</button>
                ))}
              </div>
            </div>
            <div>
              <Label>Purpose (PBAC, optional)</Label>
              <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="generate_nutrition_plan" />
            </div>
            <Button onClick={evaluate} disabled={busy || !accountId}><Gavel className="h-4 w-4 mr-1.5" />Evaluate</Button>
            {result && (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Decision:</span>
                  <Badge variant={result.decision === "allow" ? "default" : result.decision === "deny" ? "destructive" : "secondary"} className={result.decision === "allow" ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : ""}>
                    {result.decision.toUpperCase()}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Reasons:</p>
                  <div className="space-y-0.5">
                    {result.reasons.map((r, i) => <Mono key={i} className="text-[10px] block text-muted-foreground">• {r}</Mono>)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Authorization Models">
          <div className="space-y-3">
            <ModelCard name="RBAC" desc="Role-Based Access Control" detail="Roles bundle permissions; assigned at account/org/team/program/global scope with wildcard expansion." />
            <ModelCard name="ABAC" desc="Attribute-Based Access Control" detail="11 condition operators (eq, ne, in, gt, lt, regex, purpose_in, has_consent, attr_eq…) evaluated against context attributes." />
            <ModelCard name="PBAC" desc="Purpose-Based Access Control" detail="Programs request fields for a purpose; users grant purpose-bound, field-level, time-limited consent. Denied by default." />
            <ModelCard name="Policy-Based" desc="Declarative rules" detail="Allow/deny policies with priority; deny overrides allow; challenge (step-up) short-circuits before eval." />
            <ModelCard name="Delegated" desc="Delegated authority" detail="A principal may delegate a subset of its own permissions, time-bound; delegator authority is verified at eval time." />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ModelCard({ name, desc, detail }: { name: string; desc: string; detail: string }) {
  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-[var(--brand)]">{name}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-1">{detail}</p>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-muted-foreground mb-1 block">{children}</label>;
}
