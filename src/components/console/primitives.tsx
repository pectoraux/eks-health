"use client";

import { type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function SectionHeader({
  title,
  subtitle,
  icon,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div className="flex items-start gap-3">
        {icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--brand-muted)] text-[var(--brand)] shrink-0">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <Card className={cn(accent && "border-[var(--brand)]/40 bg-[var(--brand-muted)]/30")}>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={cn("text-2xl font-semibold mt-1", accent && "text-[var(--brand)]")}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function Panel({
  title,
  children,
  className,
  action,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <Card className={className}>
      {title && (
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          {action}
        </CardHeader>
      )}
      <CardContent className={cn(!title && "pt-6")}>{children}</CardContent>
    </Card>
  );
}

export function StateBadge({ state, map }: { state: string; map: Record<string, "default" | "secondary" | "destructive" | "outline"> }) {
  const variant = map[state] ?? "default";
  const labels: Record<string, string> = {
    active: "Active", unverified: "Unverified", suspended: "Suspended", locked: "Locked", deleted: "Deleted",
    revoked: "Revoked", expired: "Expired", open: "Open", investigating: "Investigating", contained: "Contained",
    resolved: "Resolved", false_positive: "False Positive", pending: "Pending", reviewing: "Reviewing",
    completed: "Completed", denied: "Denied", provisioning: "Provisioning", degraded: "Degraded",
    maintenance: "Maintenance", draining: "Draining", terminated: "Terminated", reauth_required: "Re-auth",
    withdrawn: "Withdrawn", superseded: "Superseded",
  };
  return <Badge variant={variant}>{labels[state] ?? state}</Badge>;
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">{message}</div>
  );
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre className={cn("text-xs font-mono bg-muted/50 rounded-md p-3 overflow-x-auto eks-scroll", className)}>
      {children}
    </pre>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("font-mono text-xs", className)}>{children}</code>;
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{k}</span>
      <span className="text-xs text-right break-all">{v}</span>
    </div>
  );
}
