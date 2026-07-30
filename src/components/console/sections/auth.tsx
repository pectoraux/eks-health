"use client";

import { useState } from "react";
import { KeyRound, LogIn, Fingerprint, ShieldCheck, RefreshCw } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard } from "../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function AuthSection({ data, onRefresh }: { data: PlatformSnapshot; onRefresh: () => void }) {
  const identity = data.identity as Record<string, unknown>;
  const providers = (identity.authProviders as Array<{ id: string; type: string; label: string; configured: boolean }>) ?? [];
  const accounts = (identity.accounts as Array<{ id: string; email: string; displayName: string; state: string }>) ?? [];

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  async function signIn() {
    setBusy(true);
    setResult(null);
    const res = await apiPost<{ status?: string; riskScore?: number; sessionId?: string; mfaChallengeId?: string; accessToken?: string; principal?: unknown }>("/api/identity/auth", { providerId: "password", email, password });
    setBusy(false);
    if (res.ok) {
      setResult(res.data as Record<string, unknown> | null);
      if (res.data?.status === "mfa_required") {
        toast.info("MFA required", { description: "This account has MFA enabled." });
      } else {
        toast.success("Signed in", { description: `Risk score: ${res.data?.riskScore}` });
      }
      onRefresh();
    } else {
      toast.error("Sign-in failed", { description: res.error?.userMessage ?? res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Authentication"
        subtitle="Modular auth providers (password, OAuth/OIDC, passkeys/WebAuthn, SSO). Risk-based MFA, device trust, and step-up authentication. Providers are pluggable without changing application logic."
        icon={<KeyRound className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" /></Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Auth Providers" value={providers.length} />
        <StatCard label="Configured" value={providers.filter((p) => p.configured).length} accent />
        <StatCard label="Passkeys" value="ready" hint="WebAuthn" />
        <StatCard label="MFA" value="TOTP/SMS" hint="RFC 6238" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Auth Providers">
          <div className="space-y-2">
            {providers.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--brand-muted)] text-[var(--brand)]">
                    {p.type === "passkey" ? <Fingerprint className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{p.label}</p>
                    <Mono className="text-muted-foreground">{p.id} · {p.type}</Mono>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {p.configured ? (
                    <span className="inline-flex items-center gap-1 text-xs text-[var(--brand)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />ready</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">not configured</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Sign in (demo)">
          <div className="space-y-3">
            <div>
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ama@eks.health" />
            </div>
            <div>
              <Label>Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="DemoPass123!" />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Credentials verified via PBKDF2; risk-assessed on each sign-in</span>
            </div>
            <Button onClick={signIn} disabled={busy} className="w-full">
              <LogIn className="h-4 w-4 mr-1.5" />{busy ? "Signing in…" : "Sign in"}
            </Button>
            <div className="text-xs text-muted-foreground">
              Try: <button className="text-[var(--brand)] hover:underline" onClick={() => { setEmail("ama@eks.health"); setPassword("DemoPass123!"); }}>ama@eks.health</button> / DemoPass123!
            </div>
            {result && (
              <div className="rounded-md bg-muted/50 p-2 text-xs font-mono break-all max-h-40 overflow-y-auto eks-scroll">
                {JSON.stringify(result, null, 2)}
              </div>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Quick sign-in (demo accounts)">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {accounts.map((a) => (
            <button
              key={a.id}
              onClick={() => { setEmail(a.email); setPassword("DemoPass123!"); }}
              className="rounded-md border border-border/60 p-3 text-left hover:border-[var(--brand)]/40 hover:bg-[var(--brand-muted)]/20 transition-colors"
            >
              <p className="text-sm font-medium">{a.displayName}</p>
              <Mono className="text-muted-foreground">{a.email}</Mono>
            </button>
          ))}
        </div>
      </Panel>
    </div>
  );
}
