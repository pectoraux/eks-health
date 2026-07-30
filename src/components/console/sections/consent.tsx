"use client";

import { useState } from "react";
import { FileLock2, ShieldCheck, CheckCircle2, XCircle } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function ConsentSection({ data }: { data: PlatformSnapshot }) {
  const identity = data.identity as Record<string, unknown>;
  const accounts = (identity.accounts as Array<{ id: string; displayName: string }>) ?? [];
  const consentData = (identity.consent as { active?: Array<{ id: string; status: string; purpose?: string; programId?: string; accountId?: string }> }) ?? { active: [] };
  const consents = consentData.active ?? [];

  const [accountId, setAccountId] = useState("");
  const [programId, setProgramId] = useState("weight-mgmt-program");
  const [purpose, setPurpose] = useState("generate_nutrition_plan");
  const [requestedFields, setRequestedFields] = useState("height,weight,age,biological_sex,activity_level");
  const [checkField, setCheckField] = useState("weight");
  const [checkResult, setCheckResult] = useState<{ allowed: boolean; field: string } | null>(null);
  const [pendingConsentId, setPendingConsentId] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestConsent() {
    if (!accountId) { toast.error("Select an account"); return; }
    setBusy(true);
    const res = await apiPost<{ consentId: string; status: string }>("/api/identity/consent", {
      accountId, programId, purpose,
      requestedFields: requestedFields.split(",").map((s) => s.trim()).filter(Boolean),
      optionalFields: ["sleep_history"],
    });
    setBusy(false);
    if (res.ok && res.data) {
      setPendingConsentId(res.data.consentId);
      toast.success("Consent requested", { description: "Awaiting user approval" });
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  async function grantConsent() {
    if (!pendingConsentId) { toast.error("Request consent first"); return; }
    setBusy(true);
    const res = await apiPost<{ consentId: string; status: string; receiptId: string }>("/api/identity/consent/grant", {
      consentId: pendingConsentId,
      approvedFields: requestedFields.split(",").map((s) => s.trim()).filter(Boolean),
      deniedFields: [],
      durationDays: 90,
    });
    setBusy(false);
    if (res.ok && res.data) {
      toast.success("Consent granted", { description: `Receipt ${res.data.receiptId?.slice(0, 12)}…` });
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  async function checkAccess() {
    if (!accountId) { toast.error("Select an account"); return; }
    setBusy(true);
    const res = await apiPost<{ allowed: boolean; field: string }>("/api/identity/consent/check", {
      accountId, programId, purpose, field: checkField,
    });
    setBusy(false);
    if (res.ok && res.data) {
      setCheckResult(res.data);
    } else {
      toast.error("Failed", { description: res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Consent Engine"
        subtitle="First-class consent: granular, purpose-specific, field-level, program-specific, time-limited, renewable, versioned, with immutable receipts. Emergency override framework. Users approve every purpose independently."
        icon={<FileLock2 className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Active Consents" value={consents.length} accent />
        <StatCard label="Default Duration" value="90 days" />
        <StatCard label="Versioning" value="immutable" hint="every change snapshots" />
        <StatCard label="Receipts" value="SHA-256" hint="tamper-evident" />
      </div>

      <Panel title="Denied-By-Default Fields">
        <p className="text-xs text-muted-foreground mb-2">Programs cannot require these — users must explicitly opt in:</p>
        <div className="flex flex-wrap gap-1.5">
          {["blood_pressure", "pregnancy_history", "mental_health", "prescriptions", "genetics"].map((f) => (
            <Badge key={f} variant="destructive" className="text-xs font-mono">{f}</Badge>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="PBAC Request Flow (demo)">
          <p className="text-xs text-muted-foreground mb-3">Simulate a program requesting fields for a purpose, then the user granting it.</p>
          <div className="space-y-3">
            <div>
              <Label>Account (the user)</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">Select account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
              </select>
            </div>
            <div><Label>Program</Label><Input value={programId} onChange={(e) => setProgramId(e.target.value)} /></div>
            <div><Label>Purpose</Label><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
            <div><Label>Requested fields (comma-separated)</Label><Input value={requestedFields} onChange={(e) => setRequestedFields(e.target.value)} /></div>
            <div className="flex gap-2">
              <Button onClick={requestConsent} disabled={busy}>1. Request consent</Button>
              <Button onClick={grantConsent} disabled={busy || !pendingConsentId} variant="outline">2. Grant (approve)</Button>
            </div>
            {pendingConsentId && <Mono className="text-xs text-muted-foreground">pending: {pendingConsentId}</Mono>}
          </div>
        </Panel>

        <Panel title="Access Check (data gateway)">
          <p className="text-xs text-muted-foreground mb-3">After granting, verify the gateway enforces consent per-field:</p>
          <div className="space-y-3">
            <div>
              <Label>Field to check</Label>
              <Input value={checkField} onChange={(e) => setCheckField(e.target.value)} placeholder="weight" />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {["height", "weight", "age", "biological_sex", "activity_level", "blood_pressure"].map((f) => (
                  <button key={f} onClick={() => setCheckField(f)} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono hover:bg-accent">{f}</button>
                ))}
              </div>
            </div>
            <Button onClick={checkAccess} disabled={busy}><ShieldCheck className="h-4 w-4 mr-1.5" />Check access</Button>
            {checkResult && (
              <div className={`rounded-md border p-3 flex items-center gap-2 ${checkResult.allowed ? "border-[var(--brand)]/40 bg-[var(--brand-muted)]/20" : "border-destructive/40 bg-destructive/5"}`}>
                {checkResult.allowed ? <CheckCircle2 className="h-5 w-5 text-[var(--brand)]" /> : <XCircle className="h-5 w-5 text-destructive" />}
                <div>
                  <p className="text-sm font-medium">{checkResult.allowed ? "ALLOWED" : "DENIED"}</p>
                  <p className="text-xs text-muted-foreground">field <Mono>{checkResult.field}</Mono> for purpose <Mono>{purpose}</Mono></p>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-muted-foreground mb-1 block">{children}</label>;
}
