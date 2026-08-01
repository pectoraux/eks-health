"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Users, Clock, Store, ShieldCheck, AlertTriangle, CheckCircle2, FileText,
  Activity, UserCheck, UserX, RefreshCw, ChevronRight, ChevronDown,
  Loader2, Globe, Hash, ShieldAlert, ShieldX, Eye, CheckCircle,
  Server, Cpu, Layers, Boxes, Network, Ban, Play, Trophy, Target,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types
//
// Mirror the shapes returned by:
//   - /api/dashboard            (platform_admin role) — data prop
//   - /api/auth/waitlist        → WaitlistEntry[]
//   - /api/identity/accounts    → AccountListItem[]
//   - /api/identity/accounts/[id] → AccountDetail
//   - /api/identity/audit       → { counts, chainValid, entries }
//   - /api/identity/monitoring  → { incidents, openCount }
//   - /api/identity/compliance  → ComplianceFramework[] | ComplianceReport
//   - /api/platform/snapshot    → PlatformSnapshot (subsystem map)
//   - /api/marketplace/listings → { listings, stats }
//
// All API responses are wrapped by `withPlatform` as `{ ok, data, meta }`.
// Fields are kept optional so the dashboard degrades gracefully when the
// platform has no seeded data or a subsystem is unavailable.
// ---------------------------------------------------------------------------

interface WaitlistEntry {
  id: string;
  name: string;
  email: string;
  country: string;
  interestedRoles: string[];
  reason?: string;
  referral?: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  accountId?: string;
}

interface AccountListItem {
  id: string;
  email: string;
  displayName: string;
  state: string;
  personas: string[];
  activePersona: string;
  mfaEnabled?: boolean;
  verified?: boolean;
  createdAt?: string;
  lastSignInAt?: string;
}

interface AccountContact {
  type: string;
  value: string;
  verified: boolean;
}

interface AccountDetail extends AccountListItem {
  contacts?: AccountContact[];
}

type IncidentSeverity = "low" | "medium" | "high" | "critical";
type IncidentStatus = "open" | "investigating" | "contained" | "resolved" | "false_positive";

interface SecurityIncident {
  id: string;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  type: string;
  openedAt: string;
  updatedAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  resolution?: string;
  relatedAnomalies?: string[];
  affectedAccounts?: string[];
  affectedPrograms?: string[];
  metadata?: Record<string, unknown>;
}

interface MonitoringResponse {
  incidents: SecurityIncident[];
  openCount: number;
}

interface AuditEntry {
  id: string;
  sequence: number;
  timestamp: string;
  category: string;
  action: string;
  outcome: "success" | "failure" | "denied";
  actor: { id: string; accountId?: string; type?: string; label?: string };
  target?: { kind: string; id: string; label?: string };
  source: string;
  prevHash: string;
  hash: string;
  metadata?: Record<string, unknown>;
}

interface AuditResponse {
  counts: Record<string, number>;
  chainValid: boolean;
  entries: AuditEntry[];
}

type ControlStatus = "implemented" | "partial" | "planned" | "not_applicable";

interface ComplianceControl {
  id: string;
  frameworkId: string;
  code: string;
  title: string;
  description?: string;
  status: ControlStatus;
  mapsTo?: string;
  evidence?: string;
  assessedAt?: string;
  assessedBy?: string;
}

interface ComplianceFramework {
  id: string;
  kind: string;
  name: string;
  description?: string;
  region?: string;
  regulator?: string;
  controls: ComplianceControl[];
  notificationWindowHours?: number;
}

interface ComplianceReport {
  frameworkId: string;
  frameworkName: string;
  generatedAt: string;
  totalControls: number;
  byStatus: Record<ControlStatus, number>;
  readinessPercent: number;
  gaps: Array<{ controlId: string; code: string; title: string; status: ControlStatus }>;
  controls: Array<{
    id: string;
    code: string;
    title: string;
    status: ControlStatus;
    mapsTo?: string;
    evidence?: string;
    assessedAt?: string;
  }>;
}

interface MarketplaceListing {
  id: string;
  name: string;
  tagline?: string;
  category?: string;
  developerName?: string;
  pricing?: { model?: string; amount?: number; currency?: string };
  installCount: number;
  activeInstallCount: number;
  version?: string;
  publishedAt?: string;
}

interface MarketplaceStats {
  total?: number;
  published?: number;
  totalInstalls?: number;
  activeInstalls?: number;
}

interface MarketplaceResponse {
  listings: MarketplaceListing[];
  stats: MarketplaceStats;
}

/**
 * Platform snapshot — the backend returns an object keyed by subsystem name
 * (kernel, identity, programs, health, technicians, competitions, missions,
 * developer, marketplace, research, orchestrator, population). Each value is
 * a subsystem-specific snapshot object. We treat the snapshot as a record of
 * unknown shape and just verify presence; the dashboard renders a status
 * tile per subsystem.
 */
type PlatformSnapshot = Record<string, unknown>;

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  platform?: {
    accounts: AccountListItem[];
    waitlist: WaitlistEntry[];
  };
  marketplace?: {
    stats: MarketplaceStats;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WAITLIST_STATUS_VARIANT: Record<WaitlistEntry["status"], "default" | "secondary" | "destructive"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
};

const ACCOUNT_STATE_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  unverified: "secondary",
  suspended: "destructive",
  locked: "destructive",
  deleted: "outline",
};

const INCIDENT_SEVERITY_VARIANT: Record<IncidentSeverity, "default" | "secondary" | "destructive"> = {
  low: "secondary",
  medium: "default",
  high: "destructive",
  critical: "destructive",
};

const INCIDENT_SEVERITY_DOT: Record<IncidentSeverity, string> = {
  low: "bg-sky-500",
  medium: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-rose-500",
};

const INCIDENT_STATUS_VARIANT: Record<IncidentStatus, "default" | "secondary" | "destructive" | "outline"> = {
  open: "destructive",
  investigating: "default",
  contained: "secondary",
  resolved: "default",
  false_positive: "outline",
};

const CONTROL_STATUS_VARIANT: Record<ControlStatus, "default" | "secondary" | "destructive" | "outline"> = {
  implemented: "default",
  partial: "secondary",
  planned: "destructive",
  not_applicable: "outline",
};

const CONTROL_STATUS_DOT: Record<ControlStatus, string> = {
  implemented: "bg-emerald-500",
  partial: "bg-amber-500",
  planned: "bg-rose-500",
  not_applicable: "bg-muted-foreground",
};

const AUDIT_OUTCOME_VARIANT: Record<AuditEntry["outcome"], "default" | "secondary" | "destructive"> = {
  success: "default",
  failure: "secondary",
  denied: "destructive",
};

const PERSONA_LABEL: Record<string, string> = {
  participant: "Participant",
  health_technician: "Health Technician",
  developer: "Developer",
  researcher: "Researcher",
  org_admin: "Org Admin",
  platform_admin: "Platform Admin",
  marketplace_reviewer: "Reviewer",
  support_agent: "Support",
};

const SUBSYSTEM_META: Record<string, { label: string; icon: typeof Server }> = {
  kernel: { label: "Kernel", icon: Cpu },
  identity: { label: "Identity", icon: ShieldCheck },
  programs: { label: "Programs", icon: Boxes },
  health: { label: "Health", icon: Activity },
  technicians: { label: "Technicians", icon: Users },
  competitions: { label: "Competitions", icon: Trophy },
  missions: { label: "Missions", icon: Target },
  developer: { label: "Developer", icon: FileText },
  marketplace: { label: "Marketplace", icon: Store },
  research: { label: "Research", icon: FileText },
  orchestrator: { label: "Orchestrator", icon: Network },
  population: { label: "Population", icon: Globe },
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PlatformAdminDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void }) {
  const seedAccounts = data.platform?.accounts ?? [];
  const seedWaitlist = data.platform?.waitlist ?? [];
  const seedMpStats = data.marketplace?.stats ?? {};

  // Sub-API state — loaded client-side; the dashboard route only ships
  // platform.accounts + platform.waitlist + marketplace.stats aggregates.
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>(seedWaitlist);
  const [accounts, setAccounts] = useState<AccountListItem[]>(seedAccounts);
  const [incidents, setIncidents] = useState<SecurityIncident[]>([]);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [frameworks, setFrameworks] = useState<ComplianceFramework[]>([]);
  const [snapshot, setSnapshot] = useState<PlatformSnapshot | null>(null);
  const [marketplace, setMarketplace] = useState<MarketplaceResponse | null>(null);

  const [loadingSub, setLoadingSub] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);

  // Per-row action state.
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [accountAction, setAccountAction] = useState<{ account: AccountListItem; action: "suspend" | "activate" } | null>(null);

  // Per-account expand + detail cache.
  const [openAccounts, setOpenAccounts] = useState<Set<string>>(new Set());
  const [accountDetail, setAccountDetail] = useState<Record<string, AccountDetail | null>>({});
  const [accountDetailLoading, setAccountDetailLoading] = useState<Record<string, boolean>>({});

  // Waitlist filter.
  const [waitlistFilter, setWaitlistFilter] = useState<"all" | "pending" | "approved" | "rejected">("all");

  // Incident status filter (Tabs).
  const [incidentTab, setIncidentTab] = useState<"open" | "investigating" | "resolved" | "all">("open");

  // Account search query.
  const [accountSearch, setAccountSearch] = useState("");

  // Compliance report dialog.
  const [reportFramework, setReportFramework] = useState<ComplianceFramework | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [report, setReport] = useState<ComplianceReport | null>(null);

  // Snapshot refresh indicator.
  const [refreshing, setRefreshing] = useState(false);

  // --- Sub-data load -----------------------------------------------------

  const loadSubData = useCallback(async () => {
    setLoadingSub(true);
    setSubError(null);
    try {
      const results = await Promise.allSettled([
        fetch("/api/auth/waitlist", { cache: "no-store" }),
        fetch("/api/identity/accounts", { cache: "no-store" }),
        fetch("/api/identity/monitoring", { cache: "no-store" }),
        fetch("/api/identity/audit?limit=50", { cache: "no-store" }),
        fetch("/api/identity/compliance", { cache: "no-store" }),
        fetch("/api/platform/snapshot", { cache: "no-store" }),
        fetch("/api/marketplace/listings", { cache: "no-store" }),
      ]);

      const readJson = async <T,>(r: PromiseSettledResult<Response>, fallback: T, label: string): Promise<T> => {
        if (r.status !== "fulfilled") {
          console.warn(`[platform-admin-dashboard] ${label} request rejected`);
          return fallback;
        }
        try {
          const j = (await r.value.json()) as { ok?: boolean; data?: T; error?: { message?: string } };
          if (!j?.ok) {
            console.warn(`[platform-admin-dashboard] ${label} returned ok=false`, j?.error?.message);
            return fallback;
          }
          return (j.data as T) ?? fallback;
        } catch {
          return fallback;
        }
      };

      const [wl, acct, mon, aud, comp, snap, mp] = await Promise.all([
        readJson<WaitlistEntry[]>(results[0], [], "auth/waitlist"),
        readJson<AccountListItem[]>(results[1], [], "identity/accounts"),
        readJson<MonitoringResponse>(results[2], { incidents: [], openCount: 0 }, "identity/monitoring"),
        readJson<AuditResponse>(results[3], { counts: {}, chainValid: true, entries: [] }, "identity/audit"),
        readJson<ComplianceFramework[]>(results[4], [], "identity/compliance"),
        readJson<PlatformSnapshot>(results[5], {}, "platform/snapshot"),
        readJson<MarketplaceResponse>(results[6], { listings: [], stats: {} }, "marketplace/listings"),
      ]);

      setWaitlist(wl);
      setAccounts(acct);
      setIncidents(mon.incidents ?? []);
      setAudit(aud);
      setFrameworks(comp);
      setSnapshot(snap);
      setMarketplace(mp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load platform admin data";
      setSubError(msg);
      toast({ title: "Load failed", description: msg, variant: "destructive" });
    } finally {
      setLoadingSub(false);
    }
  }, []);

  useEffect(() => {
    void loadSubData();
  }, [loadSubData]);

  // Re-seed from data prop when parent refreshes.
  useEffect(() => {
    if (seedAccounts.length > 0) setAccounts((prev) => prev.length > 0 ? prev : seedAccounts);
    if (seedWaitlist.length > 0) setWaitlist((prev) => prev.length > 0 ? prev : seedWaitlist);
  }, [data]);

  // --- Per-account detail fetch (lazy on expand) -------------------------

  const fetchAccountDetail = useCallback(async (accountId: string) => {
    if (accountDetail[accountId] !== undefined || accountDetailLoading[accountId]) return;
    setAccountDetailLoading((s) => ({ ...s, [accountId]: true }));
    try {
      const res = await fetch(`/api/identity/accounts/${encodeURIComponent(accountId)}`, { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; data?: AccountDetail; error?: { message?: string } };
      if (j.ok && j.data) {
        setAccountDetail((s) => ({ ...s, [accountId]: j.data as AccountDetail }));
      } else {
        setAccountDetail((s) => ({ ...s, [accountId]: null }));
        console.warn(`[platform-admin-dashboard] account detail ${accountId} returned ok=false`, j.error?.message);
      }
    } catch (err) {
      setAccountDetail((s) => ({ ...s, [accountId]: null }));
      console.warn(`[platform-admin-dashboard] account detail ${accountId} fetch failed`, err);
    } finally {
      setAccountDetailLoading((s) => ({ ...s, [accountId]: false }));
    }
  }, [accountDetail, accountDetailLoading]);

  const toggleAccount = useCallback((accountId: string) => {
    setOpenAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
        void fetchAccountDetail(accountId);
      }
      return next;
    });
  }, [fetchAccountDetail]);

  // --- Waitlist actions --------------------------------------------------

  const approveEntry = useCallback(async (entry: WaitlistEntry) => {
    setApprovingId(entry.id);
    try {
      const res = await fetch(`/api/auth/waitlist/${encodeURIComponent(entry.id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const j = (await res.json()) as { ok?: boolean; data?: { id: string; status: string; accountId?: string; email?: string }; error?: { message?: string; userMessage?: string } };
      if (!j.ok) {
        const msg = j.error?.userMessage ?? j.error?.message ?? "Failed to approve waitlist entry";
        toast({ title: "Approval failed", description: msg, variant: "destructive" });
        return;
      }
      // Update local state.
      setWaitlist((prev) => prev.map((w) => w.id === entry.id ? { ...w, status: "approved", accountId: j.data?.accountId } : w));
      toast({ title: "Waitlist entry approved", description: `${entry.name} (${entry.email}) can now sign in.` });
      // Refresh parent so dashboard stats reflect new account.
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      toast({ title: "Approval failed", description: msg, variant: "destructive" });
    } finally {
      setApprovingId(null);
    }
  }, [onRefresh]);

  const rejectEntry = useCallback(async (entry: WaitlistEntry) => {
    setRejectingId(entry.id);
    try {
      // The backend has no DELETE endpoint yet — attempt a real fetch and
      // surface a clear toast if it is not implemented. We hit the entry
      // detail route with DELETE; the route currently only defines GET, so
      // Next.js will respond with 405 Method Not Allowed.
      const res = await fetch(`/api/auth/waitlist/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
      });
      if (res.status === 405 || res.status === 404) {
        // Endpoint not implemented yet — update local state optimistically
        // so the admin sees the rejection, and warn that the server-side
        // DELETE handler must be added before this is durable.
        setWaitlist((prev) => prev.map((w) => w.id === entry.id ? { ...w, status: "rejected" } : w));
        toast({
          title: "Marked as rejected (local only)",
          description: "Server-side DELETE /api/auth/waitlist/[id] is not yet implemented. The rejection will not persist across reloads until that route is added.",
          variant: "destructive",
        });
        return;
      }
      const j = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!j.ok) {
        toast({ title: "Rejection failed", description: j.error?.message ?? "Unknown error", variant: "destructive" });
        return;
      }
      setWaitlist((prev) => prev.map((w) => w.id === entry.id ? { ...w, status: "rejected" } : w));
      toast({ title: "Waitlist entry rejected", description: `${entry.name} has been removed from the queue.` });
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      toast({ title: "Rejection failed", description: msg, variant: "destructive" });
    } finally {
      setRejectingId(null);
    }
  }, [onRefresh]);

  // --- Account suspend / activate ---------------------------------------

  const performAccountAction = useCallback(async (account: AccountListItem, action: "suspend" | "activate") => {
    try {
      // The backend has no state-change endpoint yet — attempt a real POST
      // to the account detail route. The route currently only defines GET,
      // so Next.js will respond with 405 Method Not Allowed. We surface a
      // clear toast in that case.
      const res = await fetch(`/api/identity/accounts/${encodeURIComponent(account.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.status === 405 || res.status === 404) {
        toast({
          title: "Account state API not yet implemented",
          description: `POST /api/identity/accounts/[id] with action="${action}" is not yet defined on the server. Add a route handler to enable ${action === "suspend" ? "suspension" : "activation"} of accounts.`,
          variant: "destructive",
        });
        return;
      }
      const j = (await res.json()) as { ok?: boolean; error?: { message?: string } };
      if (!j.ok) {
        toast({ title: `${action === "suspend" ? "Suspend" : "Activate"} failed`, description: j.error?.message ?? "Unknown error", variant: "destructive" });
        return;
      }
      const newState = action === "suspend" ? "suspended" : "active";
      setAccounts((prev) => prev.map((a) => a.id === account.id ? { ...a, state: newState } : a));
      setAccountDetail((prev) => {
        const cur = prev[account.id];
        if (!cur) return prev;
        return { ...prev, [account.id]: { ...cur, state: newState } };
      });
      toast({
        title: action === "suspend" ? "Account suspended" : "Account activated",
        description: `${account.displayName} is now ${newState}.`,
      });
      onRefresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      toast({ title: "Action failed", description: msg, variant: "destructive" });
    }
  }, [onRefresh]);

  // --- Incident acknowledge / resolve -----------------------------------

  const performIncidentAction = useCallback(async (incidentId: string, action: "acknowledge" | "resolve") => {
    try {
      const res = await fetch("/api/identity/monitoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incidentId,
          action,
          by: data.email,
          resolution: action === "resolve" ? "Resolved by platform admin" : undefined,
        }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: { incidentId: string; action: string }; error?: { message?: string; userMessage?: string } };
      if (!j.ok) {
        const msg = j.error?.userMessage ?? j.error?.message ?? "Failed to update incident";
        toast({ title: "Incident update failed", description: msg, variant: "destructive" });
        return;
      }
      setIncidents((prev) => prev.map((i) => {
        if (i.id !== incidentId) return i;
        const now = new Date().toISOString();
        if (action === "acknowledge") {
          return { ...i, status: "investigating", acknowledgedBy: data.email, acknowledgedAt: now, updatedAt: now };
        }
        return { ...i, status: "resolved", resolvedBy: data.email, resolvedAt: now, resolution: "Resolved by platform admin", updatedAt: now };
      }));
      toast({
        title: action === "acknowledge" ? "Incident acknowledged" : "Incident resolved",
        description: `Incident ${incidentId.slice(0, 12)}… marked as ${action === "acknowledge" ? "investigating" : "resolved"}.`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      toast({ title: "Incident update failed", description: msg, variant: "destructive" });
    }
  }, [data.email]);

  // --- Compliance report -------------------------------------------------

  const openReport = useCallback(async (fw: ComplianceFramework) => {
    setReportFramework(fw);
    setReport(null);
    setReportLoading(true);
    try {
      const res = await fetch(`/api/identity/compliance?framework=${encodeURIComponent(fw.id)}`, { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; data?: ComplianceReport; error?: { message?: string } };
      if (j.ok && j.data) {
        setReport(j.data);
      } else {
        toast({ title: "Report failed", description: j.error?.message ?? "Unknown error", variant: "destructive" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      toast({ title: "Report failed", description: msg, variant: "destructive" });
    } finally {
      setReportLoading(false);
    }
  }, []);

  // --- Refresh handler ---------------------------------------------------

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadSubData();
    onRefresh();
    setRefreshing(false);
    toast({ title: "Refreshed", description: "Platform data reloaded." });
  }, [loadSubData, onRefresh]);

  // --- Derived stats -----------------------------------------------------

  const pendingCount = useMemo(() => waitlist.filter((w) => w.status === "pending").length, [waitlist]);
  const openIncidentCount = useMemo(
    () => incidents.filter((i) => i.status === "open" || i.status === "investigating").length,
    [incidents],
  );
  const criticalIncidentCount = useMemo(
    () => incidents.filter((i) => i.severity === "critical" && (i.status === "open" || i.status === "investigating")).length,
    [incidents],
  );
  const mpStats = marketplace?.stats ?? seedMpStats;
  const filteredWaitlist = useMemo(() => {
    if (waitlistFilter === "all") return waitlist;
    return waitlist.filter((w) => w.status === waitlistFilter);
  }, [waitlist, waitlistFilter]);

  const filteredIncidents = useMemo(() => {
    if (incidentTab === "all") return incidents;
    if (incidentTab === "resolved") {
      return incidents.filter((i) => i.status === "resolved" || i.status === "false_positive");
    }
    return incidents.filter((i) => i.status === incidentTab);
  }, [incidents, incidentTab]);

  const filteredAccounts = useMemo(() => {
    const q = accountSearch.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) =>
        a.displayName.toLowerCase().includes(q) ||
        a.email.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q),
    );
  }, [accounts, accountSearch]);

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[var(--brand)]" />
            Platform Administration
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Manage waitlist, accounts, security incidents, compliance, and platform health.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing || loadingSub}>
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {/* Sub-load error banner */}
      {subError && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />
          Some subsystems could not be loaded: {subError}. Showing partial data.
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={<Users className="h-4 w-4" />}
          label="Total Accounts"
          value={loadingSub && accounts.length === 0 ? undefined : accounts.length}
          hint={`${accounts.filter((a) => a.state === "active").length} active`}
          accent
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
          label="Waitlist Pending"
          value={loadingSub && waitlist.length === 0 ? undefined : pendingCount}
          hint={`${waitlist.length} total`}
        />
        <StatCard
          icon={<Store className="h-4 w-4" />}
          label="Marketplace Listings"
          value={loadingSub && !marketplace ? undefined : (mpStats.total ?? 0)}
          hint={`${mpStats.published ?? 0} published`}
        />
        <StatCard
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Security Alerts"
          value={loadingSub && incidents.length === 0 ? undefined : openIncidentCount}
          hint={criticalIncidentCount > 0 ? `${criticalIncidentCount} critical` : "no critical open"}
          danger={openIncidentCount > 0}
        />
      </div>

      {/* Waitlist Management */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-[var(--brand)]" />
              Waitlist Management
              <Badge variant="secondary" className="text-[10px]">{waitlist.length}</Badge>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Label htmlFor="waitlist-filter" className="sr-only">Filter</Label>
              <Select value={waitlistFilter} onValueChange={(v) => setWaitlistFilter(v as typeof waitlistFilter)}>
                <SelectTrigger id="waitlist-filter" className="h-8 w-[140px] text-xs">
                  <SelectValue placeholder="Filter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ({waitlist.length})</SelectItem>
                  <SelectItem value="pending">Pending ({pendingCount})</SelectItem>
                  <SelectItem value="approved">Approved ({waitlist.filter((w) => w.status === "approved").length})</SelectItem>
                  <SelectItem value="rejected">Rejected ({waitlist.filter((w) => w.status === "rejected").length})</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingSub && waitlist.length === 0 ? (
            <ListSkeleton rows={4} />
          ) : filteredWaitlist.length === 0 ? (
            <EmptyState icon={<Clock className="h-8 w-8" />} message={waitlistFilter === "all" ? "No waitlist entries yet." : `No ${waitlistFilter} entries.`} />
          ) : (
            <div className="space-y-2 max-h-[28rem] overflow-y-auto eks-scroll pr-1">
              {filteredWaitlist.map((entry) => (
                <div key={entry.id} className="rounded-lg border border-border/60 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{entry.name}</span>
                        <Badge variant={WAITLIST_STATUS_VARIANT[entry.status]} className="text-[10px]">{entry.status}</Badge>
                        {entry.country && (
                          <Badge variant="outline" className="text-[10px] gap-1">
                            <Globe className="h-3 w-3" />
                            {entry.country}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate" title={entry.email}>{entry.email}</p>
                      {entry.interestedRoles.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {entry.interestedRoles.map((r) => (
                            <Badge key={r} variant="outline" className="text-[9px] py-0">
                              {PERSONA_LABEL[r] ?? r}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {entry.reason && (
                        <p className="text-[11px] text-muted-foreground mt-1.5 line-clamp-2">{entry.reason}</p>
                      )}
                      <p className="text-[10px] text-muted-foreground/70 mt-1">
                        Submitted {formatDate(entry.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {entry.status === "pending" && (
                        <>
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => approveEntry(entry)}
                            disabled={approvingId === entry.id}
                          >
                            {approvingId === entry.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserCheck className="h-3 w-3" />}
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                            onClick={() => setRejectingId(entry.id)}
                            disabled={rejectingId === entry.id}
                          >
                            {rejectingId === entry.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />}
                            Reject
                          </Button>
                        </>
                      )}
                      {entry.status === "approved" && entry.accountId && (
                        <Badge variant="outline" className="text-[10px] gap-1 font-mono" title={entry.accountId}>
                          <Hash className="h-3 w-3" />
                          {entry.accountId.slice(0, 10)}…
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Account Management */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-[var(--brand)]" />
              Account Management
              <Badge variant="secondary" className="text-[10px]">{accounts.length}</Badge>
              {accountSearch.trim() && filteredAccounts.length !== accounts.length && (
                <Badge variant="outline" className="text-[10px]">{filteredAccounts.length} match{filteredAccounts.length === 1 ? "" : "es"}</Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Label htmlFor="account-search" className="sr-only">Search accounts</Label>
              <Input
                id="account-search"
                type="search"
                placeholder="Search name, email, ID…"
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                className="h-8 text-xs sm:w-[260px]"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingSub && accounts.length === 0 ? (
            <ListSkeleton rows={4} />
          ) : accounts.length === 0 ? (
            <EmptyState icon={<Users className="h-8 w-8" />} message="No accounts registered yet." />
          ) : filteredAccounts.length === 0 ? (
            <EmptyState icon={<Users className="h-8 w-8" />} message={`No accounts match "${accountSearch}".`} />
          ) : (
            <div className="space-y-2 max-h-[32rem] overflow-y-auto eks-scroll pr-1">
              {filteredAccounts.map((account) => {
                const expanded = openAccounts.has(account.id);
                const detail = accountDetail[account.id];
                const detailLoading = accountDetailLoading[account.id];
                return (
                  <Collapsible key={account.id} open={expanded} onOpenChange={() => toggleAccount(account.id)}>
                    <div className="rounded-lg border border-border/60">
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
                          aria-expanded={expanded}
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                            <span className="text-xs font-semibold uppercase">{account.displayName.slice(0, 2)}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium truncate">{account.displayName}</span>
                              <Badge variant={ACCOUNT_STATE_VARIANT[account.state] ?? "secondary"} className="text-[10px]">{account.state}</Badge>
                              {account.verified && (
                                <Badge variant="outline" className="text-[9px] gap-0.5 text-emerald-600">
                                  <CheckCircle2 className="h-3 w-3" /> verified
                                </Badge>
                              )}
                              {account.mfaEnabled && (
                                <Badge variant="outline" className="text-[9px] gap-0.5">
                                  <ShieldCheck className="h-3 w-3" /> MFA
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate" title={account.email}>{account.email}</p>
                            {account.createdAt && (
                              <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                                Created {formatDate(account.createdAt)}
                                {account.lastSignInAt ? ` · last sign-in ${formatDate(account.lastSignInAt)}` : ""}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="hidden sm:flex flex-wrap gap-0.5 justify-end max-w-[200px]">
                              {account.personas.slice(0, 3).map((p) => (
                                <Badge key={p} variant="outline" className="text-[9px] py-0">
                                  {PERSONA_LABEL[p] ?? p}
                                </Badge>
                              ))}
                              {account.personas.length > 3 && (
                                <Badge variant="outline" className="text-[9px] py-0">+{account.personas.length - 3}</Badge>
                              )}
                            </div>
                            {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                          </div>
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="border-t border-border/60 p-3 space-y-3 bg-muted/20">
                          {detailLoading ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading account details…
                            </div>
                          ) : detail === null ? (
                            <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 py-2">
                              <AlertTriangle className="h-3.5 w-3.5" /> Could not load account detail.
                            </div>
                          ) : detail ? (
                            <div className="space-y-2 text-xs">
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <DetailRow label="Account ID" value={<span className="font-mono">{detail.id}</span>} />
                                <DetailRow label="Active Persona" value={PERSONA_LABEL[detail.activePersona] ?? detail.activePersona} />
                                <DetailRow label="Personas" value={detail.personas.map((p) => PERSONA_LABEL[p] ?? p).join(", ")} />
                                <DetailRow label="State" value={<Badge variant={ACCOUNT_STATE_VARIANT[detail.state] ?? "secondary"} className="text-[10px]">{detail.state}</Badge>} />
                              </div>
                              {detail.contacts && detail.contacts.length > 0 && (
                                <div>
                                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Contacts</p>
                                  <div className="space-y-1">
                                    {detail.contacts.map((c, i) => (
                                      <div key={i} className="flex items-center justify-between rounded border border-border/40 bg-background px-2 py-1">
                                        <span className="font-mono text-[11px]">{c.value}</span>
                                        <div className="flex items-center gap-2">
                                          <Badge variant="outline" className="text-[9px]">{c.type}</Badge>
                                          {c.verified ? (
                                            <Badge variant="outline" className="text-[9px] gap-0.5 text-emerald-600"><CheckCircle2 className="h-3 w-3" /> verified</Badge>
                                          ) : (
                                            <Badge variant="outline" className="text-[9px] gap-0.5 text-amber-600"><AlertTriangle className="h-3 w-3" /> unverified</Badge>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : null}

                          <Separator />

                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-[10px] text-muted-foreground">
                              Account state management actions:
                            </p>
                            <div className="flex items-center gap-1.5">
                              {account.state === "active" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                                  onClick={() => setAccountAction({ account, action: "suspend" })}
                                >
                                  <Ban className="h-3 w-3" />
                                  Suspend
                                </Button>
                              )}
                              {(account.state === "suspended" || account.state === "locked") && (
                                <Button
                                  size="sm"
                                  className="h-7 text-xs"
                                  onClick={() => setAccountAction({ account, action: "activate" })}
                                >
                                  <Play className="h-3 w-3" />
                                  Activate
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security Monitoring + Audit Trail (side-by-side on large screens) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Security Monitoring */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-rose-500" />
                Security Monitoring
                {openIncidentCount > 0 && (
                  <Badge variant="destructive" className="text-[10px]">{openIncidentCount} open</Badge>
                )}
              </CardTitle>
            </div>
            {incidents.length > 0 && (
              <Tabs value={incidentTab} onValueChange={(v) => setIncidentTab(v as typeof incidentTab)}>
                <TabsList className="h-8">
                  <TabsTrigger value="open" className="text-[11px]">
                    Open ({incidents.filter((i) => i.status === "open").length})
                  </TabsTrigger>
                  <TabsTrigger value="investigating" className="text-[11px]">
                    Investigating ({incidents.filter((i) => i.status === "investigating").length})
                  </TabsTrigger>
                  <TabsTrigger value="resolved" className="text-[11px]">
                    Resolved ({incidents.filter((i) => i.status === "resolved" || i.status === "false_positive").length})
                  </TabsTrigger>
                  <TabsTrigger value="all" className="text-[11px]">
                    All ({incidents.length})
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
          </CardHeader>
          <CardContent>
            {loadingSub && incidents.length === 0 ? (
              <ListSkeleton rows={3} />
            ) : incidents.length === 0 ? (
              <EmptyState icon={<ShieldCheck className="h-8 w-8" />} message="No security incidents. All clear." success />
            ) : filteredIncidents.length === 0 ? (
              <EmptyState icon={<ShieldCheck className="h-8 w-8" />} message={`No ${incidentTab} incidents.`} />
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto eks-scroll pr-1">
                {filteredIncidents.map((incident) => (
                  <div key={incident.id} className="rounded-lg border border-border/60 p-3">
                    <div className="flex items-start gap-3">
                      <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${INCIDENT_SEVERITY_DOT[incident.severity]}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium truncate">{incident.title}</span>
                          <Badge variant={INCIDENT_SEVERITY_VARIANT[incident.severity]} className="text-[10px]">{incident.severity}</Badge>
                          <Badge variant={INCIDENT_STATUS_VARIANT[incident.status]} className="text-[10px]">{incident.status}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{incident.description}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[10px] text-muted-foreground/80">
                          <span className="font-mono">type: {incident.type}</span>
                          <span>opened {formatDate(incident.openedAt)}</span>
                          {incident.acknowledgedBy && <span>ack by {incident.acknowledgedBy}</span>}
                          {incident.resolvedBy && <span>resolved by {incident.resolvedBy}</span>}
                        </div>
                        {incident.affectedAccounts && incident.affectedAccounts.length > 0 && (
                          <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                            {incident.affectedAccounts.length} affected account(s)
                          </p>
                        )}
                      </div>
                    </div>
                    {(incident.status === "open" || incident.status === "investigating") && (
                      <div className="flex items-center justify-end gap-1.5 mt-2 pt-2 border-t border-border/40">
                        {incident.status === "open" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => performIncidentAction(incident.id, "acknowledge")}
                          >
                            <Eye className="h-3 w-3" />
                            Acknowledge
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => performIncidentAction(incident.id, "resolve")}
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          Resolve
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Audit Trail */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4 text-[var(--brand)]" />
                Audit Trail
              </CardTitle>
              {audit && (
                <Badge
                  variant={audit.chainValid ? "default" : "destructive"}
                  className="text-[10px] gap-1"
                  title={audit.chainValid ? "Hash chain verified" : "Hash chain BROKEN"}
                >
                  {audit.chainValid ? <CheckCircle2 className="h-3 w-3" /> : <ShieldX className="h-3 w-3" />}
                  {audit.chainValid ? "Chain valid" : "Chain BROKEN"}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!audit ? (
              <ListSkeleton rows={4} />
            ) : audit.entries.length === 0 ? (
              <EmptyState icon={<FileText className="h-8 w-8" />} message="No audit events recorded yet." />
            ) : (
              <>
                {audit.counts && Object.keys(audit.counts).length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {Object.entries(audit.counts)
                      .filter(([, n]) => n > 0)
                      .sort((a, b) => b[1] - a[1])
                      .map(([cat, n]) => (
                        <Badge key={cat} variant="outline" className="text-[10px] gap-1">
                          <span className="font-mono">{cat}</span>
                          <span className="text-muted-foreground">{n}</span>
                        </Badge>
                      ))}
                  </div>
                )}
                <div className="space-y-1.5 max-h-80 overflow-y-auto eks-scroll pr-1">
                  {audit.entries.slice(0, 30).map((entry) => (
                    <div key={entry.id} className="rounded border border-border/40 p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5 mb-1">
                        <Badge variant={AUDIT_OUTCOME_VARIANT[entry.outcome]} className="text-[9px]">{entry.outcome}</Badge>
                        <span className="font-mono text-[11px] text-foreground">{entry.action}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">{formatDate(entry.timestamp)}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                        <span>actor: <span className="font-mono text-foreground/80">{entry.actor.id.slice(0, 16)}{entry.actor.id.length > 16 ? "…" : ""}</span></span>
                        <span>src: <span className="font-mono text-foreground/80">{entry.source}</span></span>
                        {entry.target && (
                          <span>target: <span className="font-mono text-foreground/80">{entry.target.kind}:{entry.target.id.slice(0, 12)}</span></span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-[9px] text-muted-foreground/60" title="Hash-chain verification — sha256(prevHash + canonical entry json)">
                        <Hash className="h-2.5 w-2.5" />
                        <span className="font-mono truncate">{entry.hash.slice(0, 24)}…</span>
                        <CheckCircle className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
                      </div>
                    </div>
                  ))}
                </div>
                {audit.entries.length > 30 && (
                  <p className="text-[10px] text-muted-foreground mt-2 text-center">
                    Showing 30 of {audit.entries.length} events.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Compliance + Platform Health */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Compliance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--brand)]" />
              Compliance Frameworks
              <Badge variant="secondary" className="text-[10px]">{frameworks.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingSub && frameworks.length === 0 ? (
              <ListSkeleton rows={3} />
            ) : frameworks.length === 0 ? (
              <EmptyState icon={<ShieldCheck className="h-8 w-8" />} message="No compliance frameworks registered." />
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto eks-scroll pr-1">
                {frameworks.map((fw) => {
                  const implemented = fw.controls.filter((c) => c.status === "implemented").length;
                  const partial = fw.controls.filter((c) => c.status === "partial").length;
                  const planned = fw.controls.filter((c) => c.status === "planned").length;
                  const na = fw.controls.filter((c) => c.status === "not_applicable").length;
                  const readiness = fw.controls.length === 0
                    ? 100
                    : Math.round(((implemented + na) / fw.controls.length) * 100);
                  return (
                    <div key={fw.id} className="rounded-lg border border-border/60 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{fw.name}</span>
                            {fw.region && <Badge variant="outline" className="text-[10px]">{fw.region}</Badge>}
                            <Badge variant={readiness >= 80 ? "default" : readiness >= 50 ? "secondary" : "destructive"} className="text-[10px]">
                              {readiness}% ready
                            </Badge>
                          </div>
                          {fw.description && (
                            <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{fw.description}</p>
                          )}
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px]">
                            <span className="flex items-center gap-1">
                              <span className="h-2 w-2 rounded-full bg-emerald-500" />
                              {implemented} implemented
                            </span>
                            {partial > 0 && (
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-amber-500" />
                                {partial} partial
                              </span>
                            )}
                            {planned > 0 && (
                              <span className="flex items-center gap-1">
                                <span className="h-2 w-2 rounded-full bg-rose-500" />
                                {planned} planned
                              </span>
                            )}
                            {na > 0 && (
                              <span className="flex items-center gap-1 text-muted-foreground">
                                <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                                {na} n/a
                              </span>
                            )}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => openReport(fw)}>
                          <FileText className="h-3 w-3" />
                          Report
                        </Button>
                      </div>
                      {fw.controls.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-0.5">
                          {fw.controls.slice(0, 30).map((c) => (
                            <span
                              key={c.id}
                              title={`${c.code} — ${c.title} (${c.status})`}
                              className={`h-1.5 flex-1 min-w-[6px] rounded-sm ${CONTROL_STATUS_DOT[c.status]}`}
                            />
                          ))}
                          {fw.controls.length > 30 && (
                            <span className="text-[9px] text-muted-foreground ml-1">+{fw.controls.length - 30}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Platform Health */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Server className="h-4 w-4 text-[var(--brand)]" />
                Platform Health
              </CardTitle>
              {snapshot && Object.keys(snapshot).length > 0 && (
                <Badge variant="default" className="text-[10px] gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  All systems operational
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!snapshot ? (
              <ListSkeleton rows={4} />
            ) : Object.keys(snapshot).length === 0 ? (
              <EmptyState icon={<Server className="h-8 w-8" />} message="Platform snapshot unavailable." />
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {Object.entries(snapshot).map(([key, value]) => {
                    const meta = SUBSYSTEM_META[key];
                    const Icon = meta?.icon ?? Boxes;
                    const isObj = value !== null && typeof value === "object";
                    const summary = summarizeSnapshot(key, value);
                    return (
                      <div
                        key={key}
                        className="rounded-lg border border-border/60 p-2.5 hover:border-border transition-colors"
                        title={isObj ? `${key} subsystem snapshot` : String(value)}
                      >
                        <div className="flex items-center gap-1.5 mb-1">
                          <Icon className="h-3.5 w-3.5 text-[var(--brand)]" />
                          <span className="text-xs font-medium truncate">{meta?.label ?? key}</span>
                          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                        </div>
                        <p className="text-[10px] text-muted-foreground line-clamp-2 leading-tight">
                          {summary}
                        </p>
                      </div>
                    );
                  })}
                </div>
                <Separator className="my-3" />
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Layers className="h-3 w-3" />
                    {Object.keys(snapshot).length} subsystems
                  </span>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] text-muted-foreground" onClick={handleRefresh} disabled={refreshing}>
                    {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Re-check
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Marketplace overview (read-only summary) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Store className="h-4 w-4 text-[var(--brand)]" />
            Marketplace Overview
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!marketplace ? (
            <ListSkeleton rows={3} />
          ) : marketplace.listings.length === 0 ? (
            <EmptyState icon={<Store className="h-8 w-8" />} message="No marketplace listings published yet." />
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                <MiniStat label="Total" value={mpStats.total ?? 0} />
                <MiniStat label="Published" value={mpStats.published ?? 0} />
                <MiniStat label="Total Installs" value={mpStats.totalInstalls ?? 0} />
                <MiniStat label="Active Installs" value={mpStats.activeInstalls ?? 0} />
              </div>
              <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll pr-1">
                {marketplace.listings.slice(0, 8).map((l) => (
                  <div key={l.id} className="flex items-center justify-between rounded border border-border/40 p-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{l.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {l.developerName ?? "unknown"}{l.category ? ` · ${l.category}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-[9px]">{l.installCount} installs</Badge>
                      {l.pricing?.model && (
                        <Badge variant="secondary" className="text-[9px]">{l.pricing.model}</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* --- Confirmation dialogs --------------------------------------- */}

      {/* Reject waitlist confirmation */}
      <AlertDialog open={rejectingId !== null} onOpenChange={(o) => { if (!o) setRejectingId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject waitlist entry?</AlertDialogTitle>
            <AlertDialogDescription>
              {rejectingId && (() => {
                const e = waitlist.find((w) => w.id === rejectingId);
                return e ? `This will mark ${e.name} (${e.email}) as rejected. They will not be able to sign in.` : "This entry will be marked as rejected.";
              })()}
              {" "}The server-side DELETE handler is not yet implemented, so this change is local-only until that route is added.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white"
              onClick={() => {
                if (rejectingId) {
                  const entry = waitlist.find((w) => w.id === rejectingId);
                  if (entry) void rejectEntry(entry);
                }
              }}
            >
              <UserX className="h-3.5 w-3.5" />
              Reject entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Suspend / Activate account confirmation */}
      <AlertDialog
        open={accountAction !== null}
        onOpenChange={(o) => { if (!o) setAccountAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {accountAction?.action === "suspend" ? "Suspend account?" : "Activate account?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {accountAction && (() => {
                const a = accountAction.account;
                if (accountAction.action === "suspend") {
                  return `${a.displayName} (${a.email}) will be suspended. They will not be able to sign in until reactivated.`;
                }
                return `${a.displayName} (${a.email}) will be reactivated and able to sign in again.`;
              })()}
              {" "}The server-side state-change endpoint (POST /api/identity/accounts/[id]) is not yet implemented, so this action will return a not-implemented error until that route is added.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={accountAction?.action === "suspend"
                ? "bg-rose-600 hover:bg-rose-700 text-white"
                : "bg-emerald-600 hover:bg-emerald-700 text-white"}
              onClick={() => {
                if (accountAction) {
                  void performAccountAction(accountAction.account, accountAction.action);
                  setAccountAction(null);
                }
              }}
            >
              {accountAction?.action === "suspend" ? <Ban className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {accountAction?.action === "suspend" ? "Suspend" : "Activate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Compliance report dialog */}
      <Dialog open={reportFramework !== null} onOpenChange={(o) => { if (!o) { setReportFramework(null); setReport(null); } }}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-[var(--brand)]" />
              {reportFramework?.name ?? "Compliance Report"}
            </DialogTitle>
            <DialogDescription>
              {reportFramework?.region ? `${reportFramework.region} · ` : ""}
              {reportFramework?.regulator ?? "Regulator not specified"}
              {reportFramework?.notificationWindowHours ? ` · ${reportFramework.notificationWindowHours}h breach window` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto eks-scroll -mx-1 px-1">
            {reportLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !report ? (
              <p className="text-sm text-muted-foreground text-center py-12">No report data.</p>
            ) : (
              <div className="space-y-4">
                {/* Readiness summary */}
                <div className="rounded-lg border border-border/60 p-3 bg-muted/30">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium">Readiness</span>
                    <span className={`text-2xl font-bold ${report.readinessPercent >= 80 ? "text-emerald-600" : report.readinessPercent >= 50 ? "text-amber-600" : "text-rose-600"}`}>
                      {report.readinessPercent}%
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <ReadinessTile label="Implemented" value={report.byStatus.implemented ?? 0} dot="bg-emerald-500" />
                    <ReadinessTile label="Partial" value={report.byStatus.partial ?? 0} dot="bg-amber-500" />
                    <ReadinessTile label="Planned" value={report.byStatus.planned ?? 0} dot="bg-rose-500" />
                    <ReadinessTile label="N/A" value={report.byStatus.not_applicable ?? 0} dot="bg-muted-foreground" />
                  </div>
                </div>

                {/* Gaps */}
                {report.gaps.length > 0 && (
                  <div>
                    <p className="text-xs font-medium mb-1.5 flex items-center gap-1">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      Gaps ({report.gaps.length})
                    </p>
                    <div className="space-y-1">
                      {report.gaps.map((g) => (
                        <div key={g.controlId} className="flex items-center gap-2 rounded border border-border/40 p-2 text-xs">
                          <span className="font-mono text-[10px] text-muted-foreground">{g.code}</span>
                          <span className="flex-1 truncate">{g.title}</span>
                          <Badge variant={CONTROL_STATUS_VARIANT[g.status]} className="text-[9px]">{g.status}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* All controls */}
                <div>
                  <p className="text-xs font-medium mb-1.5">All Controls ({report.controls.length})</p>
                  <div className="space-y-1">
                    {report.controls.map((c) => (
                      <div key={c.id} className="rounded border border-border/40 p-2 text-xs">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-[10px] text-muted-foreground">{c.code}</span>
                          <span className="flex-1 font-medium truncate">{c.title}</span>
                          <Badge variant={CONTROL_STATUS_VARIANT[c.status]} className="text-[9px]">{c.status}</Badge>
                        </div>
                        {c.mapsTo && (
                          <p className="text-[10px] text-muted-foreground/70 font-mono">→ {c.mapsTo}</p>
                        )}
                        {c.evidence && (
                          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{c.evidence}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setReportFramework(null); setReport(null); }}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function StatCard({
  icon,
  label,
  value,
  hint,
  accent,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  value?: React.ReactNode;
  hint?: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <Card
      className={
        accent
          ? "border-[var(--brand)]/40 bg-[var(--brand-muted)]/20"
          : danger
          ? "border-rose-500/30 bg-rose-500/5"
          : ""
      }
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-md ${
              accent
                ? "bg-[var(--brand)] text-[var(--brand-foreground)]"
                : danger
                ? "bg-rose-500/20 text-rose-600"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {icon}
          </div>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        {value === undefined ? (
          <div className="h-7 w-16 rounded bg-muted animate-pulse" />
        ) : (
          <p className={`text-2xl font-bold ${accent ? "text-[var(--brand)]" : danger ? "text-rose-600" : ""}`}>
            {value}
          </p>
        )}
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/40 bg-muted/20 p-2 text-center">
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border/40 bg-background px-2 py-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs text-right truncate">{value}</span>
    </div>
  );
}

function ReadinessTile({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-semibold">{value}</span>
    </div>
  );
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border/40 p-3 space-y-2">
          <div className="h-3.5 w-1/3 rounded bg-muted animate-pulse" />
          <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
          <div className="h-2.5 w-1/2 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  message,
  success,
}: {
  icon: React.ReactNode;
  message: string;
  success?: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className={`mb-2 ${success ? "text-emerald-500" : "text-muted-foreground/50"}`}>{icon}</div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

/**
 * Produce a one-line human summary of a subsystem snapshot value. We don't
 * try to fully type the snapshot — we just walk the object looking for
 * recognizable count-like fields.
 */
function summarizeSnapshot(key: string, value: unknown): string {
  if (value === null || value === undefined) return "no data";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Try common summary keys per subsystem.
    if (key === "kernel" || key === "identity" || key === "programs") {
      const info = obj.info as Record<string, unknown> | undefined;
      if (info && typeof info.version === "string") return `v${info.version}`;
    }
    // Count arrays / maps at the top level.
    const counts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        if (v.length > 0) counts.push(`${k}: ${v.length}`);
      } else if (v !== null && typeof v === "object") {
        const inner = v as Record<string, unknown>;
        if ("stats" in inner && typeof inner.stats === "object" && inner.stats !== null) {
          const stats = inner.stats as Record<string, unknown>;
          const statKeys = Object.keys(stats).slice(0, 2);
          for (const sk of statKeys) {
            const sv = stats[sk];
            if (typeof sv === "number") counts.push(`${sk}: ${sv}`);
          }
        } else if ("total" in inner && typeof inner.total === "number") {
          counts.push(`${k}: ${inner.total}`);
        }
      } else if (typeof v === "number") {
        counts.push(`${k}: ${v}`);
      }
      if (counts.length >= 3) break;
    }
    if (counts.length > 0) return counts.join(" · ");
    const keys = Object.keys(obj);
    if (keys.length > 0) return `${keys.length} keys: ${keys.slice(0, 3).join(", ")}`;
    return "empty";
  }
  return String(value);
}
