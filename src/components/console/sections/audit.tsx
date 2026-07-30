"use client";

import { ClipboardCheck, ShieldCheck, Link2 } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function AuditSection({ data }: { data: PlatformSnapshot }) {
  const identity = data.identity as Record<string, unknown>;
  const auditData = (identity.audit as {
    count?: Record<string, number>;
    chainValid?: boolean;
    recent?: Array<{ id: string; category: string; action: string; actor?: string; outcome: string; timestamp: string; hash?: string; prevHash?: string }>;
  }) ?? { count: {}, chainValid: false, recent: [] };
  const counts = auditData.count ?? {};
  const total = Object.values(counts).reduce((a, b) => a + (b as number), 0);
  const chainValid = auditData.chainValid ?? true;
  const entries = auditData.recent ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Audit Trail"
        subtitle="Every security-sensitive action is immutable and hash-chained (SHA-256). Append-only — entries can never be deleted or mutated. Tamper-evident: any modification invalidates every subsequent hash."
        icon={<ClipboardCheck className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Events" value={total} accent />
        <StatCard label="Chain Status" value={chainValid ? "VALID" : "BROKEN"} hint={chainValid ? "tamper-evident" : "investigate!"} />
        <StatCard label="Storage" value="append-only" />
        <StatCard label="Hash" value="SHA-256" hint="prevHash linked" />
      </div>

      <Panel title="Events by Category">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {Object.entries(counts).map(([cat, n]) => (
            <div key={cat} className="rounded-md border border-border/60 p-2.5 text-center">
              <p className="text-lg font-semibold">{n as number}</p>
              <Mono className="text-[10px] text-muted-foreground">{cat}</Mono>
            </div>
          ))}
          {total === 0 && <EmptyState message="No audit events yet — interact with the platform to generate them." />}
        </div>
      </Panel>

      <Panel title="Recent Audit Entries" action={<div className="flex items-center gap-1.5 text-xs text-[var(--brand)]"><Link2 className="h-3.5 w-3.5" />hash-chained</div>}>
        {entries.length === 0 ? <EmptyState message="No entries yet. Sign in, switch personas, or grant consent to populate the trail." /> : (
          <div className="max-h-[28rem] overflow-y-auto eks-scroll space-y-1.5">
            {entries.slice().reverse().map((e) => (
              <div key={e.id} className="rounded-md border border-border/40 p-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={e.outcome === "success" ? "default" : e.outcome === "denied" ? "destructive" : "secondary"} className="text-[10px]">{e.outcome}</Badge>
                    <span className="font-mono text-muted-foreground">{e.category}</span>
                    <span className="font-medium">{e.action}</span>
                  </div>
                  <span className="text-muted-foreground text-[10px]">{new Date(e.timestamp).toLocaleTimeString()}</span>
                </div>
                {e.actor && <div className="mt-1 text-muted-foreground">actor: <Mono>{e.actor}</Mono></div>}
                {e.hash && <div className="mt-0.5 text-muted-foreground text-[10px]">hash: <Mono>{e.hash.slice(0, 24)}…</Mono></div>}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="What Gets Audited">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {["Authentication", "Permission grants", "Permission denial", "Consent creation", "Consent revocation", "Data access", "Policy changes", "Role assignments", "Session creation", "Session termination", "Program installs", "Security alerts"].map((a) => (
            <div key={a} className="flex items-center gap-1.5 text-xs"><ShieldCheck className="h-3 w-3 text-[var(--brand)]" />{a}</div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
