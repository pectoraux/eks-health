"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Building2, Users, Trophy, Activity, Plus, Mail, TrendingUp, DollarSign,
  RefreshCw, ChevronRight, ChevronDown, ShieldCheck, UserPlus, Globe,
  MapPin, Layers, Target, AlertTriangle,
  Crown, Network, Hash, Building, Mailbox, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types
//
// Mirror the shapes returned by:
//   - /api/dashboard            (org_admin role) — data prop
//   - /api/population/organizations → { organizations, stats }
//   - /api/population/memberships   → { stats }
//   - /api/population/funding       → { stats }
//   - /api/population/campaigns     → { campaigns, stats }
//   - /api/identity/orgs            → Organization[]
//   - /api/identity/orgs/[id]       → { org, members, teams }
//   - /api/identity/accounts        → Account[]
//
// All API responses are wrapped by `withPlatform` as `{ ok, data, meta }`.
// Fields are kept optional so the dashboard degrades gracefully when the
// platform has no seeded data or a subsystem is unavailable.
// ---------------------------------------------------------------------------

interface PopulationStats {
  total?: number;
  byType?: Record<string, number>;
  byTier?: Record<string, number>;
  active?: number;
  totalMembers?: number;
}

interface PopulationOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  tier: string;
  country: string;
  memberCount: number;
  activeMemberCount: number;
  status: "active" | "suspended" | "dissolved";
}

interface MembershipStats {
  total?: number;
  active?: number;
  invited?: number;
  left?: number;
  removed?: number;
}

interface FundingStats {
  totalPolicies?: number;
  activePolicies?: number;
  totalRequests?: number;
  requestsByStatus?: Record<string, number>;
  totalFunded?: number;
  currency?: string;
}

type CampaignStatus = "draft" | "scheduled" | "active" | "paused" | "completed" | "cancelled";
type CampaignScope = "global" | "national" | "regional" | "organizational";

interface CampaignListItem {
  id: string;
  name: string;
  status: CampaignStatus;
  scope: CampaignScope;
  participationGoal: number;
  actualParticipation: number;
}

interface CampaignStats {
  total?: number;
  byStatus?: Record<string, number>;
  byScope?: Record<string, number>;
  avgParticipationRate?: number;
  totalActualParticipation?: number;
  totalParticipationGoal?: number;
}

interface IdentityOrg {
  id: string;
  type: string;
  name: string;
  slug: string;
  description?: string;
  parentId?: string;
  dataClassification?: string;
  status: "active" | "suspended" | "terminated";
  website?: string;
  address?: string;
  locale?: string;
  createdAt?: string;
  updatedAt?: string;
}

type OrgRole = "owner" | "admin" | "member" | "billing" | "auditor" | "delegate";

interface OrgMembership {
  orgId: string;
  accountId: string;
  role: OrgRole | string;
  title?: string;
  departmentId?: string;
  addedAt: string;
  addedBy?: string;
  active: boolean;
  removedAt?: string;
}

interface Team {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  departmentId?: string;
  memberAccountIds: string[];
  createdAt: string;
  createdBy?: string;
}

interface OrgDetail {
  org: IdentityOrg;
  members: OrgMembership[];
  teams: Team[];
}

interface Account {
  id: string;
  email: string;
  displayName: string;
  state: string;
  personas: string[];
  activePersona: string;
}

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  population?: {
    stats: {
      // Brief-declared fields:
      totalContexts?: number;
      avgGoals?: number;
      // Real backend fields (PopulationAnalytics.getStats()):
      totalQueries?: number;
      byMethod?: Record<string, number>;
    };
  };
}

/** Identity org enriched with population-engine stats (joined by slug). */
interface MergedOrg {
  org: IdentityOrg;
  memberCount: number;
  activeMemberCount: number;
  tier: string;
  country: string;
  popStatus?: "active" | "suspended" | "dissolved";
  depth: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_ORG_TYPES: { value: string; label: string }[] = [
  { value: "hospital", label: "Hospital" },
  { value: "clinic", label: "Clinic" },
  { value: "company", label: "Company" },
  { value: "government", label: "Government" },
  { value: "university", label: "University" },
  { value: "ngo", label: "NGO" },
  { value: "insurance", label: "Insurance Provider" },
  { value: "research_institution", label: "Research Institution" },
];

const ROLE_OPTIONS: { value: OrgRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
  { value: "billing", label: "Billing" },
  { value: "auditor", label: "Auditor" },
  { value: "delegate", label: "Delegate" },
];

const CAMPAIGN_STATUS_VARIANT: Record<CampaignStatus, "default" | "secondary" | "destructive"> = {
  active: "default",
  scheduled: "secondary",
  draft: "secondary",
  paused: "secondary",
  completed: "default",
  cancelled: "destructive",
};

const CAMPAIGN_STATUS_DOT: Record<CampaignStatus, string> = {
  active: "bg-emerald-500",
  scheduled: "bg-blue-500",
  draft: "bg-muted-foreground",
  paused: "bg-amber-500",
  completed: "bg-[var(--brand)]",
  cancelled: "bg-rose-500",
};

const ORG_STATUS_VARIANT: Record<IdentityOrg["status"], "default" | "secondary" | "destructive"> = {
  active: "default",
  suspended: "secondary",
  terminated: "destructive",
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OrgAdminDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void }) {
  // Sub-API state — loaded client-side; the dashboard route only ships
  // population.stats (analytics queries), everything else is fetched here.
  const [identityOrgs, setIdentityOrgs] = useState<IdentityOrg[]>([]);
  const [popOrgs, setPopOrgs] = useState<PopulationOrg[]>([]);
  const [popStats, setPopStats] = useState<PopulationStats>({});
  const [membershipStats, setMembershipStats] = useState<MembershipStats>({});
  const [fundingStats, setFundingStats] = useState<FundingStats>({});
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [campaignStats, setCampaignStats] = useState<CampaignStats>({});
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [loadingSub, setLoadingSub] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);

  // Per-org expand + detail cache.
  const [openOrgs, setOpenOrgs] = useState<Set<string>>(new Set());
  const [orgDetail, setOrgDetail] = useState<Record<string, OrgDetail | null>>({});
  const [orgDetailLoading, setOrgDetailLoading] = useState<Record<string, boolean>>({});

  // Dialogs.
  const [createOpen, setCreateOpen] = useState(false);
  const [addMemberOrg, setAddMemberOrg] = useState<IdentityOrg | null>(null);
  const [inviteMemberOrg, setInviteMemberOrg] = useState<IdentityOrg | null>(null);

  // --- Sub-data load -----------------------------------------------------

  const loadSubData = useCallback(async () => {
    setLoadingSub(true);
    setSubError(null);
    try {
      const results = await Promise.allSettled([
        fetch("/api/identity/orgs", { cache: "no-store" }),
        fetch("/api/population/organizations", { cache: "no-store" }),
        fetch("/api/population/memberships", { cache: "no-store" }),
        fetch("/api/population/funding", { cache: "no-store" }),
        fetch("/api/population/campaigns", { cache: "no-store" }),
        fetch("/api/identity/accounts", { cache: "no-store" }),
      ]);

      const readJson = async <T,>(r: PromiseSettledResult<Response>, fallback: T, label: string): Promise<T> => {
        if (r.status !== "fulfilled") {
          console.warn(`[org-admin-dashboard] ${label} request rejected`);
          return fallback;
        }
        try {
          const j = (await r.value.json()) as { ok?: boolean; data?: T; error?: { message?: string } };
          if (!j?.ok) {
            console.warn(`[org-admin-dashboard] ${label} returned ok=false`, j?.error?.message);
            return fallback;
          }
          return (j.data as T) ?? fallback;
        } catch {
          return fallback;
        }
      };

      const [orgs, pop, mem, fund, camps, accts] = await Promise.all([
        readJson<IdentityOrg[]>(results[0], [], "identity/orgs"),
        readJson<{ organizations: PopulationOrg[]; stats: PopulationStats }>(results[1], { organizations: [], stats: {} }, "population/organizations"),
        readJson<{ stats: MembershipStats }>(results[2], { stats: {} }, "population/memberships"),
        readJson<{ stats: FundingStats }>(results[3], { stats: {} }, "population/funding"),
        readJson<{ campaigns: CampaignListItem[]; stats: CampaignStats }>(results[4], { campaigns: [], stats: {} }, "population/campaigns"),
        readJson<Account[]>(results[5], [], "identity/accounts"),
      ]);

      setIdentityOrgs(orgs);
      setPopOrgs(pop.organizations ?? []);
      setPopStats(pop.stats ?? {});
      setMembershipStats(mem.stats ?? {});
      setFundingStats(fund.stats ?? {});
      setCampaigns(camps.campaigns ?? []);
      setCampaignStats(camps.stats ?? {});
      setAccounts(accts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load org admin data";
      setSubError(msg);
      toast({ title: "Load failed", description: msg, variant: "destructive" });
    } finally {
      setLoadingSub(false);
    }
  }, []);

  useEffect(() => {
    void loadSubData();
  }, [loadSubData]);

  // --- Per-org detail fetch (lazy on expand) -----------------------------

  const fetchOrgDetail = useCallback(async (orgId: string) => {
    if (orgDetail[orgId] !== undefined || orgDetailLoading[orgId]) return;
    setOrgDetailLoading((s) => ({ ...s, [orgId]: true }));
    try {
      const res = await fetch(`/api/identity/orgs/${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; data?: OrgDetail; error?: { message?: string } };
      if (j.ok && j.data) {
        setOrgDetail((s) => ({ ...s, [orgId]: j.data as OrgDetail }));
      } else {
        setOrgDetail((s) => ({ ...s, [orgId]: null }));
        console.warn(`[org-admin-dashboard] org detail ${orgId} returned ok=false`, j.error?.message);
      }
    } catch (err) {
      setOrgDetail((s) => ({ ...s, [orgId]: null }));
      console.warn(`[org-admin-dashboard] org detail ${orgId} fetch failed`, err);
    } finally {
      setOrgDetailLoading((s) => ({ ...s, [orgId]: false }));
    }
  }, [orgDetail, orgDetailLoading]);

  const toggleOrg = useCallback((orgId: string) => {
    setOpenOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) {
        next.delete(orgId);
      } else {
        next.add(orgId);
        void fetchOrgDetail(orgId);
      }
      return next;
    });
  }, [fetchOrgDetail]);

  // --- Actions -----------------------------------------------------------

  const refreshOrgDetail = useCallback(async (orgId: string) => {
    setOrgDetail((s) => ({ ...s, [orgId]: undefined }));
    setOrgDetailLoading((s) => ({ ...s, [orgId]: true }));
    try {
      const res = await fetch(`/api/identity/orgs/${encodeURIComponent(orgId)}`, { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; data?: OrgDetail; error?: { message?: string } };
      if (j.ok && j.data) {
        setOrgDetail((s) => ({ ...s, [orgId]: j.data as OrgDetail }));
      } else {
        setOrgDetail((s) => ({ ...s, [orgId]: null }));
      }
    } catch {
      setOrgDetail((s) => ({ ...s, [orgId]: null }));
    } finally {
      setOrgDetailLoading((s) => ({ ...s, [orgId]: false }));
    }
  }, []);

  const handleOrgCreated = useCallback(() => {
    onRefresh();
    void loadSubData();
  }, [onRefresh, loadSubData]);

  const handleMemberAdded = useCallback((orgId: string) => {
    void refreshOrgDetail(orgId);
    onRefresh();
    void loadSubData();
  }, [refreshOrgDetail, onRefresh, loadSubData]);

  const handleManualRefresh = useCallback(() => {
    onRefresh();
    // Invalidate cached org details so re-expand refetches.
    setOrgDetail({});
    void loadSubData();
  }, [onRefresh, loadSubData]);

  // --- Derived -----------------------------------------------------------

  // Build a slug → population org lookup so identity orgs can pick up
  // memberCount / tier / country from the population subsystem.
  const popBySlug = useMemo(() => {
    const m = new Map<string, PopulationOrg>();
    for (const p of popOrgs) m.set(p.slug, p);
    return m;
  }, [popOrgs]);

  // Compute hierarchy depth for each identity org by walking parentId.
  const depthMap = useMemo(() => {
    const byId = new Map<string, IdentityOrg>();
    for (const o of identityOrgs) byId.set(o.id, o);
    const cache = new Map<string, number>();
    const depthOf = (id: string): number => {
      if (cache.has(id)) return cache.get(id) as number;
      const o = byId.get(id);
      if (!o || !o.parentId || !byId.has(o.parentId)) {
        cache.set(id, 0);
        return 0;
      }
      const d = 1 + depthOf(o.parentId);
      cache.set(id, d);
      return d;
    };
    const m = new Map<string, number>();
    for (const o of identityOrgs) m.set(o.id, depthOf(o.id));
    return m;
  }, [identityOrgs]);

  const mergedOrgs: MergedOrg[] = useMemo(() => {
    return identityOrgs.map((org) => {
      const pop = popBySlug.get(org.slug);
      return {
        org,
        memberCount: pop?.memberCount ?? 0,
        activeMemberCount: pop?.activeMemberCount ?? 0,
        tier: pop?.tier ?? "free",
        country: pop?.country ?? "",
        popStatus: pop?.status,
        depth: depthMap.get(org.id) ?? 0,
      };
    });
  }, [identityOrgs, popBySlug, depthMap]);

  const totalOrgs = popStats.total ?? identityOrgs.length;
  const totalMembers = membershipStats.total ?? popStats.totalMembers ?? 0;
  const activeCampaigns = campaignStats.byStatus?.active ?? campaigns.filter((c) => c.status === "active").length;
  const populationReach = data.population?.stats?.totalQueries ?? data.population?.stats?.totalContexts ?? 0;

  return (
    <div className="space-y-6">
      {/* Top stat row + Refresh */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
          <StatCard
            icon={<Building2 className="h-4 w-4" />}
            label="Organizations"
            value={totalOrgs}
            hint={`${popStats.active ?? identityOrgs.filter((o) => o.status === "active").length} active`}
            loading={loadingSub && !identityOrgs.length}
            accent
          />
          <StatCard
            icon={<Users className="h-4 w-4" />}
            label="Total Members"
            value={totalMembers}
            hint={`${membershipStats.active ?? 0} active · ${membershipStats.invited ?? 0} invited`}
            loading={loadingSub}
          />
          <StatCard
            icon={<Trophy className="h-4 w-4" />}
            label="Active Campaigns"
            value={activeCampaigns}
            hint={`${campaignStats.total ?? campaigns.length} total`}
            loading={loadingSub}
          />
          <StatCard
            icon={<Activity className="h-4 w-4" />}
            label="Population Reach"
            value={populationReach}
            hint={data.population?.stats?.avgGoals ? `${data.population.stats.avgGoals} avg goals` : "analytics queries"}
            loading={loadingSub}
          />
        </div>
        <div className="flex sm:flex-col gap-2 sm:justify-end">
          <Button variant="outline" onClick={handleManualRefresh} className="h-9" disabled={loadingSub}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loadingSub ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {subError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          Could not load some org admin data: {subError}. Showing partial view.
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Organization Management</h2>
          <p className="text-sm text-muted-foreground">
            Create, expand, and administer your organizations, members, and teams.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="h-9">
          <Plus className="h-4 w-4 mr-1" />
          Create Organization
        </Button>
      </div>

      {/* Organizations card (full width, expandable) */}
      <OrganizationsCard
        orgs={mergedOrgs}
        openOrgs={openOrgs}
        onToggle={toggleOrg}
        orgDetail={orgDetail}
        orgDetailLoading={orgDetailLoading}
        loading={loadingSub}
        accounts={accounts}
        onAddMember={(org) => setAddMemberOrg(org)}
        onInviteMember={(org) => setInviteMemberOrg(org)}
        onMemberAdded={handleMemberAdded}
      />

      {/* Active Campaigns + Funding Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CampaignsCard campaigns={campaigns} stats={campaignStats} loading={loadingSub} />
        <FundingOverviewCard stats={fundingStats} loading={loadingSub} />
      </div>

      {/* Population Analytics (full width) */}
      <PopulationAnalyticsCard
        stats={data.population?.stats ?? {}}
        membershipStats={membershipStats}
        campaignStats={campaignStats}
        popStats={popStats}
        loading={loadingSub}
      />

      {/* Dialogs */}
      <CreateOrgDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleOrgCreated}
      />
      <AddMemberDialog
        org={addMemberOrg}
        accounts={accounts}
        onOpenChange={(o) => !o && setAddMemberOrg(null)}
        onAdded={handleMemberAdded}
      />
      <InviteMemberDialog
        org={inviteMemberOrg}
        onOpenChange={(o) => !o && setInviteMemberOrg(null)}
        onInvited={() => { onRefresh(); void loadSubData(); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Organizations card — expandable list with members, teams, add/invite
// ---------------------------------------------------------------------------

function OrganizationsCard({
  orgs,
  openOrgs,
  onToggle,
  orgDetail,
  orgDetailLoading,
  loading,
  accounts,
  onAddMember,
  onInviteMember,
  onMemberAdded,
}: {
  orgs: MergedOrg[];
  openOrgs: Set<string>;
  onToggle: (orgId: string) => void;
  orgDetail: Record<string, OrgDetail | null | undefined>;
  orgDetailLoading: Record<string, boolean>;
  loading: boolean;
  accounts: Account[];
  onAddMember: (org: IdentityOrg) => void;
  onInviteMember: (org: IdentityOrg) => void;
  onMemberAdded: (orgId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          Organizations
          <Badge variant="outline" className="text-[10px] ml-1">{orgs.length}</Badge>
        </CardTitle>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          <span>Expand any org to view members &amp; teams</span>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : orgs.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            message={`No organizations registered yet. Click "Create Organization" to add your first org.`}
          />
        ) : (
          <div className="space-y-2 max-h-[40rem] overflow-y-auto eks-scroll pr-1">
            {orgs.map((m) => (
              <OrgRow
                key={m.org.id}
                merged={m}
                open={openOrgs.has(m.org.id)}
                onToggle={() => onToggle(m.org.id)}
                detail={orgDetail[m.org.id]}
                loading={!!orgDetailLoading[m.org.id]}
                accounts={accounts}
                onAddMember={() => onAddMember(m.org)}
                onInviteMember={() => onInviteMember(m.org)}
                onMemberAdded={() => onMemberAdded(m.org.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OrgRow({
  merged,
  open,
  onToggle,
  detail,
  loading,
  accounts,
  onAddMember,
  onInviteMember,
  onMemberAdded,
}: {
  merged: MergedOrg;
  open: boolean;
  onToggle: () => void;
  detail: OrgDetail | null | undefined;
  loading: boolean;
  accounts: Account[];
  onAddMember: () => void;
  onInviteMember: () => void;
  onMemberAdded: () => void;
}) {
  const { org, memberCount, activeMemberCount, tier, country, depth } = merged;
  const typeLabel = IDENTITY_ORG_TYPES.find((t) => t.value === org.type)?.label ?? org.type;

  const members = detail?.members ?? [];
  const teams = detail?.teams ?? [];

  // Resolve member account display info from the accounts list.
  const accountById = useMemo(() => {
    const m = new Map<string, Account>();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  return (
    <Collapsible open={open} onOpenChange={(o) => o ? onToggle() : onToggle()}>
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/40 transition-colors"
            aria-expanded={open}
          >
            <div className={`flex h-9 w-9 items-center justify-center rounded-md ${open ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "bg-muted text-muted-foreground"}`}>
              <Building className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium truncate">{org.name}</p>
                <Badge variant="outline" className="text-[10px]">{typeLabel}</Badge>
                {depth > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    <Layers className="h-3 w-3 mr-0.5" />
                    L{depth}
                  </Badge>
                )}
                <Badge variant={ORG_STATUS_VARIANT[org.status]} className="text-[10px]">
                  {org.status}
                </Badge>
              </div>
              <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-0.5">
                  <Hash className="h-3 w-3" />
                  <span className="font-mono truncate max-w-[10rem]" title={org.slug}>{org.slug}</span>
                </span>
                {country && (
                  <span className="flex items-center gap-0.5">
                    <MapPin className="h-3 w-3" />
                    {country}
                  </span>
                )}
                <span className="flex items-center gap-0.5">
                  <Crown className="h-3 w-3" />
                  {tier}
                </span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold">{memberCount}</p>
              <p className="text-[10px] text-muted-foreground">{activeMemberCount} active</p>
            </div>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border/60 bg-muted/20 p-3 space-y-4">
            {loading ? (
              <div className="space-y-2">
                <div className="h-4 w-1/3 rounded bg-muted animate-pulse" />
                <div className="h-8 w-full rounded bg-muted animate-pulse" />
                <div className="h-8 w-full rounded bg-muted animate-pulse" />
              </div>
            ) : detail === null ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Member roster unavailable for this org.</p>
                  <p className="text-muted-foreground mt-0.5">
                    The identity-org detail endpoint returned no data. Population-only metrics are still shown above.
                    Add Member and Invite Member are disabled until the org is provisioned in the identity subsystem.
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Members */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      Members
                      <Badge variant="secondary" className="text-[10px] ml-1">{members.length}</Badge>
                    </p>
                  </div>
                  {members.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">No members in this org yet.</p>
                  ) : (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll">
                      {members.map((m, idx) => {
                        const acct = accountById.get(m.accountId);
                        const roleLabel = ROLE_OPTIONS.find((r) => r.value === m.role)?.label ?? m.role;
                        return (
                          <div key={`${m.accountId}-${idx}`} className="flex items-center gap-2 rounded-md border border-border/60 bg-background p-2 text-xs">
                            <div className={`flex h-6 w-6 items-center justify-center rounded-full ${m.active ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground"}`}>
                              {m.role === "owner" || m.role === "admin" ? <Crown className="h-3 w-3" /> : <Users className="h-3 w-3" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">
                                {acct?.displayName ?? m.accountId}
                                {!m.active && <span className="text-muted-foreground ml-1">(inactive)</span>}
                              </p>
                              <p className="text-[10px] text-muted-foreground font-mono truncate" title={m.accountId}>
                                {acct?.email ?? m.accountId}
                              </p>
                            </div>
                            <Badge
                              variant={m.role === "owner" || m.role === "admin" ? "default" : "secondary"}
                              className="text-[10px]"
                            >
                              {roleLabel}
                            </Badge>
                            {m.title && (
                              <span className="text-[10px] text-muted-foreground hidden sm:inline">{m.title}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <Separator />

                {/* Teams */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5 mb-2">
                    <Network className="h-3.5 w-3.5" />
                    Teams
                    <Badge variant="secondary" className="text-[10px] ml-1">{teams.length}</Badge>
                  </p>
                  {teams.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2">No teams defined for this org.</p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                      {teams.map((t) => (
                        <div key={t.id} className="rounded-md border border-border/60 bg-background p-2 text-xs">
                          <p className="font-medium truncate">{t.name}</p>
                          {t.description && (
                            <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{t.description}</p>
                          )}
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                            <Users className="h-3 w-3" />
                            {t.memberAccountIds.length} member{t.memberAccountIds.length === 1 ? "" : "s"}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Separator />

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="default" onClick={onAddMember}>
                    <UserPlus className="h-3.5 w-3.5 mr-1" />
                    Add Member
                  </Button>
                  <Button size="sm" variant="outline" onClick={onInviteMember}>
                    <Mail className="h-3.5 w-3.5 mr-1" />
                    Invite Member
                  </Button>
                  {org.website && (
                    <a
                      href={org.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                    >
                      <Globe className="h-3 w-3" />
                      {org.website.replace(/^https?:\/\//, "")}
                    </a>
                  )}
                </div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Active Campaigns card
// ---------------------------------------------------------------------------

function CampaignsCard({
  campaigns,
  stats,
  loading,
}: {
  campaigns: CampaignListItem[];
  stats: CampaignStats;
  loading: boolean;
}) {
  const sorted = useMemo(() => {
    const order: Record<CampaignStatus, number> = {
      active: 0, scheduled: 1, paused: 2, draft: 3, completed: 4, cancelled: 5,
    };
    return [...campaigns].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  }, [campaigns]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Trophy className="h-4 w-4 text-muted-foreground" />
          Active Campaigns
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{stats.total ?? campaigns.length} total</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<Trophy className="h-8 w-8" />}
            message="No public health campaigns registered."
          />
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto eks-scroll pr-1">
            {sorted.map((c) => {
              const pct = c.participationGoal > 0
                ? Math.min(100, Math.round((c.actualParticipation / c.participationGoal) * 100))
                : 0;
              return (
                <div key={c.id} className="rounded-lg border border-border/60 p-3">
                  <div className="flex items-start gap-2 mb-2">
                    <div className={`mt-1 h-2 w-2 rounded-full shrink-0 ${CAMPAIGN_STATUS_DOT[c.status]}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{c.name}</p>
                      <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate" title={c.id}>{c.id}</p>
                    </div>
                    <Badge variant={CAMPAIGN_STATUS_VARIANT[c.status]} className="text-[10px]">
                      {c.status}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-2 mb-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      <Target className="h-3 w-3 mr-0.5" />
                      {c.scope}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {c.actualParticipation.toLocaleString()} / {c.participationGoal.toLocaleString()} participants
                    </span>
                    <span className="text-[11px] font-semibold ml-auto">{pct}%</span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>
              );
            })}
          </div>
        )}

        {/* Mini-stats footer */}
        {!loading && sorted.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-border/60">
            <MiniStat
              label="Avg Participation"
              value={typeof stats.avgParticipationRate === "number"
                ? `${Math.round(stats.avgParticipationRate * 100)}%`
                : "—"}
            />
            <MiniStat
              label="Total Reach"
              value={(stats.totalActualParticipation ?? 0).toLocaleString()}
            />
            <MiniStat
              label="Goal Sum"
              value={(stats.totalParticipationGoal ?? 0).toLocaleString()}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Funding Overview card
// ---------------------------------------------------------------------------

function FundingOverviewCard({
  stats,
  loading,
}: {
  stats: FundingStats;
  loading: boolean;
}) {
  const currency = stats.currency ?? "USD";
  const byStatus = stats.requestsByStatus ?? {};
  const totalRequests = stats.totalRequests ?? 0;
  const statusEntries = Object.entries(byStatus).filter(([, n]) => (n as number) > 0);

  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-muted-foreground" />
          Funding Overview
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{currency}</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : (
          <div className="space-y-4">
            {/* Tiles */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <ShieldCheck className="h-3 w-3" />
                  Active Policies
                </div>
                <p className="text-xl font-bold mt-0.5">
                  {stats.activePolicies ?? 0}
                  <span className="text-xs font-normal text-muted-foreground ml-1">/ {stats.totalPolicies ?? 0}</span>
                </p>
              </div>
              <div className="rounded-md border border-[var(--brand)]/30 bg-[var(--brand-muted)]/30 p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <TrendingUp className="h-3 w-3" />
                  Total Funded
                </div>
                <p className="text-xl font-bold mt-0.5 text-[var(--brand)]">
                  {fmt(stats.totalFunded ?? 0)}
                  <span className="text-xs font-normal text-muted-foreground ml-1">{currency}</span>
                </p>
              </div>
            </div>

            {/* Requests by status — visual bars */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Funding Requests by Status
                </p>
                <span className="text-[10px] text-muted-foreground">{totalRequests} total</span>
              </div>
              {statusEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No funding requests recorded.</p>
              ) : (
                <div className="space-y-1.5">
                  {statusEntries.map(([status, count]) => {
                    const pct = totalRequests > 0 ? Math.round(((count as number) / totalRequests) * 100) : 0;
                    const color =
                      status === "executed" ? "bg-emerald-500" :
                      status === "approved" ? "bg-[var(--brand)]" :
                      status === "pending" ? "bg-amber-500" :
                      status === "rejected" ? "bg-rose-500" :
                      status === "cancelled" ? "bg-muted-foreground" :
                      "bg-muted-foreground";
                    return (
                      <div key={status}>
                        <div className="flex items-center justify-between text-[11px] mb-0.5">
                          <span className="capitalize">{status}</span>
                          <span className="text-muted-foreground">{count as number} · {pct}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Population Analytics card
// ---------------------------------------------------------------------------

function PopulationAnalyticsCard({
  stats,
  membershipStats,
  campaignStats,
  popStats,
  loading,
}: {
  stats: NonNullable<DashboardData["population"]>["stats"];
  membershipStats: MembershipStats;
  campaignStats: CampaignStats;
  popStats: PopulationStats;
  loading: boolean;
}) {
  // Real backend returns { totalQueries, byMethod }. The brief also mentions
  // { totalContexts, avgGoals }. Surface whichever is present.
  const totalContexts = stats.totalContexts ?? stats.totalQueries ?? 0;
  const avgGoals = stats.avgGoals;
  const byMethod = stats.byMethod ?? {};
  const methodEntries = Object.entries(byMethod)
    .sort((a, b) => (b[1] as number) - (a[1] as number))
    .slice(0, 8);
  const totalMethodCount = methodEntries.reduce((a, [, n]) => a + (n as number), 0);

  const totalMembers = membershipStats.total ?? 0;
  const activeMembers = membershipStats.active ?? 0;
  const participationRate = totalMembers > 0 ? activeMembers / totalMembers : 0;

  const totalCampaigns = campaignStats.total ?? 0;
  const avgCampaignParticipation = campaignStats.avgParticipationRate ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Population Analytics
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">aggregate only · k-anonymity enforced</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : (
          <div className="space-y-4">
            {/* Top tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MetricTile
                icon={<Hash className="h-3 w-3" />}
                label="Analytics Queries"
                value={totalContexts.toLocaleString()}
                hint="total contexts"
              />
              <MetricTile
                icon={<Target className="h-3 w-3" />}
                label="Avg Goals"
                value={typeof avgGoals === "number" ? avgGoals.toLocaleString() : "—"}
                hint={typeof avgGoals === "number" ? "across population" : "not yet computed"}
              />
              <MetricTile
                icon={<Users className="h-3 w-3" />}
                label="Participation Rate"
                value={`${Math.round(participationRate * 100)}%`}
                hint={`${activeMembers.toLocaleString()} / ${totalMembers.toLocaleString()} members`}
              />
              <MetricTile
                icon={<Trophy className="h-3 w-3" />}
                label="Campaign Reach"
                value={`${Math.round(avgCampaignParticipation * 100)}%`}
                hint={`${totalCampaigns} campaigns`}
              />
            </div>

            <Separator />

            {/* By-method bars (analytics query breakdown) */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Analytics Queries by Method
              </p>
              {methodEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  No analytics queries recorded yet. Querying an org dashboard will populate this breakdown.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {methodEntries.map(([method, count]) => {
                    const pct = totalMethodCount > 0 ? Math.round(((count as number) / totalMethodCount) * 100) : 0;
                    return (
                      <div key={method}>
                        <div className="flex items-center justify-between text-[11px] mb-0.5">
                          <span className="font-mono">{method}</span>
                          <span className="text-muted-foreground">{count as number} · {pct}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div className="h-full bg-[var(--brand)] transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            {/* Org breakdown by type */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Organizations by Type
              </p>
              <ByTypeBars byType={popStats.byType ?? {}} total={popStats.total ?? 0} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ByTypeBars({ byType, total }: { byType: Record<string, number>; total: number }) {
  const entries = Object.entries(byType)
    .filter(([, n]) => (n as number) > 0)
    .sort((a, b) => (b[1] as number) - (a[1] as number));

  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">No organization type data available.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
      {entries.map(([type, count]) => {
        const pct = total > 0 ? Math.round(((count as number) / total) * 100) : 0;
        const label = IDENTITY_ORG_TYPES.find((t) => t.value === type)?.label ?? type;
        return (
          <div key={type}>
            <div className="flex items-center justify-between text-[11px] mb-0.5">
              <span className="capitalize truncate">{label}</span>
              <span className="text-muted-foreground">{count as number} · {pct}%</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-[var(--brand)]/70 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Organization dialog
// ---------------------------------------------------------------------------

function CreateOrgDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("company");
  const [submitting, setSubmitting] = useState(false);

  // Reset form when dialog closes.
  const handleOpenChange = useCallback((o: boolean) => {
    if (!o) {
      setName("");
      setType("company");
    }
    onOpenChange(o);
  }, [onOpenChange]);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      toast({ title: "Name required", description: "Please enter an organization name.", variant: "destructive" });
      return;
    }
    if (!type) {
      toast({ title: "Type required", description: "Please select an organization type.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/identity/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), type }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: { orgId?: string; name?: string; type?: string }; error?: { message?: string; userMessage?: string } };
      if (j.ok) {
        toast({
          title: "Organization created",
          description: `${j.data?.name ?? name} is now registered as ${j.data?.type ?? type}.`,
        });
        handleOpenChange(false);
        onCreated();
      } else {
        toast({
          title: "Create failed",
          description: j.error?.userMessage ?? j.error?.message ?? "Server rejected the organization.",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Network error",
        description: err instanceof Error ? err.message : "Could not reach server",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }, [name, type, handleOpenChange, onCreated]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Create Organization
          </DialogTitle>
          <DialogDescription>
            Register a new organization in the identity subsystem. After creation, you can add members and teams.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ministry of Health Ghana"
              disabled={submitting}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-type">Type</Label>
            <Select value={type} onValueChange={setType} disabled={submitting}>
              <SelectTrigger id="org-type" className="w-full">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {IDENTITY_ORG_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1" />
                Create
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add Member dialog
// ---------------------------------------------------------------------------

function AddMemberDialog({
  org,
  accounts,
  onOpenChange,
  onAdded,
}: {
  org: IdentityOrg | null;
  accounts: Account[];
  onOpenChange: (o: boolean) => void;
  onAdded: (orgId: string) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [submitting, setSubmitting] = useState(false);

  const open = !!org;

  // Reset state when target org changes or dialog closes.
  useEffect(() => {
    if (open) {
      setAccountId("");
      setRole("member");
    }
  }, [open, org?.id]);

  const submit = useCallback(async () => {
    if (!org) return;
    if (!accountId) {
      toast({ title: "Account required", description: "Please select an account to add.", variant: "destructive" });
      return;
    }
    if (!role) {
      toast({ title: "Role required", description: "Please select a role for this member.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/identity/orgs/${encodeURIComponent(org.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, role }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: { added?: boolean; accountId?: string; role?: string }; error?: { message?: string; userMessage?: string } };
      if (j.ok) {
        const acct = accounts.find((a) => a.id === accountId);
        toast({
          title: "Member added",
          description: `${acct?.displayName ?? accountId} added to ${org.name} as ${role}.`,
        });
        onOpenChange(false);
        onAdded(org.id);
      } else {
        toast({
          title: "Add member failed",
          description: j.error?.userMessage ?? j.error?.message ?? "Server rejected the request.",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Network error",
        description: err instanceof Error ? err.message : "Could not reach server",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }, [org, accountId, role, accounts, onOpenChange, onAdded]);

  // Exclude accounts already in the org (if detail is cached) — best-effort.
  const candidateAccounts = accounts;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Add Member to {org?.name ?? ""}
          </DialogTitle>
          <DialogDescription>
            Select an existing account and assign a role. The member will be added immediately (no invite token required).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="add-account">Account</Label>
            <Select value={accountId} onValueChange={setAccountId} disabled={submitting || candidateAccounts.length === 0}>
              <SelectTrigger id="add-account" className="w-full">
                <SelectValue placeholder={candidateAccounts.length === 0 ? "No accounts available" : "Select account"} />
              </SelectTrigger>
              <SelectContent>
                {candidateAccounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.displayName} <span className="text-muted-foreground ml-1">({a.email})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {candidateAccounts.length === 0 && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                No accounts are registered on the platform yet. Invite by email instead.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)} disabled={submitting}>
              <SelectTrigger id="add-role" className="w-full">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !accountId || !role}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Adding...
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4 mr-1" />
                Add Member
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Invite Member dialog
// ---------------------------------------------------------------------------

function InviteMemberDialog({
  org,
  onOpenChange,
  onInvited,
}: {
  org: IdentityOrg | null;
  onOpenChange: (o: boolean) => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [submitting, setSubmitting] = useState(false);

  const open = !!org;

  useEffect(() => {
    if (open) {
      setEmail("");
      setRole("member");
    }
  }, [open, org?.id]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const submit = useCallback(async () => {
    if (!org) return;
    if (!email.trim()) {
      toast({ title: "Email required", description: "Please enter an email address.", variant: "destructive" });
      return;
    }
    if (!emailValid) {
      toast({ title: "Invalid email", description: "Please enter a valid email address.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/identity/orgs/${encodeURIComponent(org.id)}/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: { invited?: boolean; email?: string; token?: string }; error?: { message?: string; userMessage?: string } };
      if (j.ok) {
        toast({
          title: "Invitation sent",
          description: `${j.data?.email ?? email} has been invited to ${org.name} as ${role}.`,
        });
        onOpenChange(false);
        onInvited();
      } else {
        toast({
          title: "Invite failed",
          description: j.error?.userMessage ?? j.error?.message ?? "Server rejected the invitation.",
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({
        title: "Network error",
        description: err instanceof Error ? err.message : "Could not reach server",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }, [org, email, emailValid, role, onOpenChange, onInvited]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mailbox className="h-4 w-4" />
            Invite Member to {org?.name ?? ""}
          </DialogTitle>
          <DialogDescription>
            Send an email invitation. The recipient will receive a single-use token to accept and join the organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email Address</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              disabled={submitting}
              autoFocus
            />
            {email.length > 0 && !emailValid && (
              <p className="text-[11px] text-destructive">Please enter a valid email address.</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)} disabled={submitting}>
              <SelectTrigger id="invite-role" className="w-full">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !emailValid}>
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Mail className="h-4 w-4 mr-1" />
                Send Invite
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function StatCard({
  icon,
  label,
  value,
  hint,
  loading,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
  loading?: boolean;
  accent?: boolean;
}) {
  return (
    <Card className={accent ? "border-[var(--brand)]/40 bg-[var(--brand-muted)]/20" : ""}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <div
            className={`flex h-7 w-7 items-center justify-center rounded-md ${
              accent ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : "bg-muted text-muted-foreground"
            }`}
          >
            {icon}
          </div>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <p className={`text-2xl font-bold ${accent ? "text-[var(--brand)]" : ""}`}>
          {loading ? <span className="inline-block h-6 w-10 rounded bg-muted animate-pulse align-middle" /> : value}
        </p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border/60 p-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-md bg-muted animate-pulse" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-2/3 rounded bg-muted animate-pulse" />
              <div className="h-2.5 w-1/2 rounded bg-muted animate-pulse" />
            </div>
            <div className="h-5 w-12 rounded bg-muted animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="text-muted-foreground/60 mb-2">{icon}</div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
    </div>
  );
}

function MetricTile({
  icon, label, value, hint,
}: {
  icon: React.ReactNode; label: string; value: React.ReactNode; hint?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="text-lg font-bold mt-1">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}
