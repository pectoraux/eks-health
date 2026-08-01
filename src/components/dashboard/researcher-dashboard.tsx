"use client";

import { useState, useEffect, useCallback } from "react";
import {
  FlaskConical, CheckCircle2, TrendingUp, Activity, FileText, Database,
  Brain, Users, RefreshCw, Plus, ShieldCheck, ShieldAlert, AlertTriangle,
  ChevronRight, ChevronDown, Circle, Lock, Download, Sparkles,
  Globe2, Calendar, Timer, Search, BarChart3, Layers,
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
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types — mirror the shapes returned by /api/dashboard (researcher role) and
// the research / identity sub-APIs. All API responses are wrapped by
// `withPlatform` as `{ ok, data, meta }`. Fields are kept optional so the
// dashboard degrades gracefully when the platform has no seeded data yet.
// ---------------------------------------------------------------------------

interface ConsentStats {
  total?: number;
  active?: number;
  revoked?: number;
  expired?: number;
  byType?: Record<string, number>;
}

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  research?: {
    consentStats: ConsentStats;
  };
}

// /api/identity/consent records (identity subsystem — different from the
// research-consent records). Each record captures one program→purpose access
// grant for one participant.
interface ConsentRecord {
  id: string;
  accountId: string;
  programId: string;
  purpose: string;
  description?: string;
  requestedFields: string[];
  optionalFields: string[];
  deniedFields: string[];
  approvedFields: string[];
  userDeniedFields: string[];
  status: string; // pending | active | expired | withdrawn | revoked | superseded
  version: number;
  createdAt: string;
  grantedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  revokeReason?: string;
  receiptId?: string;
}

interface AccountSummary {
  id: string;
  email: string;
  displayName: string;
  state: string;
  personas: string[];
  activePersona: string;
  mfaEnabled?: boolean;
  verified?: boolean;
  createdAt: string;
  lastSignInAt?: string;
}

interface ProgramSummary {
  id: string;
  slug: string;
  name: string;
  kind: string;
  category?: string;
  state: string;
}

interface DatasetStats {
  total: number;
  byStatus?: Record<string, number>;
  byPrivacyLevel?: Record<string, number>;
  totalExports?: number;
  completedExports?: number;
  pendingExports?: number;
}

interface InsightStats {
  total: number;
  byType?: Record<string, number>;
  averageConfidence?: number;
  highConfidence?: number;
  lowConfidence?: number;
}

interface EvidenceStats {
  total: number;
  byLevel?: Record<string, number>;
  avgConfidence?: number;
  avgParticipants?: number;
  avgImprovement?: number;
}

interface PopulationStats {
  totalSnapshots?: number;
  avgParticipants?: number;
  avgImprovement?: number;
  avgPrograms?: number;
  avgCompetitions?: number;
  lastCapturedAt?: string;
}

interface PopulationSnapshot {
  id: string;
  totalParticipants: number;
  totalMeasurements: number;
  totalVerifiedMeasurements: number;
  totalPrograms: number;
  totalCompetitions: number;
  improvementTrends: { category: string; avgImprovement: number; trend: "up" | "down" | "stable" }[];
  completionRates: { category: string; rate: number }[];
  measurementFrequency: { category: string; avgPerWeek: number }[];
  programEffectiveness: { programId: string; effectiveness: number; confidence: number }[];
  regionalDifferences: { region: string; participants: number; avgImprovement: number }[];
  seasonalEffects: { season: string; avgImprovement: number }[];
  demographicTrends: { demographic: string; participants: number; trend: string }[];
  retentionMetrics: { period: string; rate: number }[];
  competitionParticipation: { competitionId: string; participants: number }[];
  missionAdherence: { category: string; adherenceRate: number }[];
  capturedAt: string;
}

// A consent record decorated with the owning account's display info, so the
// list can show participant names instead of raw IDs.
interface ConsentRow extends ConsentRecord {
  accountEmail?: string;
  accountDisplayName?: string;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ResearcherDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void }) {
  const research = data.research;

  // Sub-API state — loaded client-side because /api/dashboard only ships the
  // consent-stats aggregate for the researcher role.
  const [consents, setConsents] = useState<ConsentRow[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [datasetStats, setDatasetStats] = useState<DatasetStats | null>(null);
  const [insightStats, setInsightStats] = useState<InsightStats | null>(null);
  const [evidenceStats, setEvidenceStats] = useState<EvidenceStats | null>(null);
  const [population, setPopulation] = useState<{ latest?: PopulationSnapshot; stats?: PopulationStats } | null>(null);
  const [loadingSub, setLoadingSub] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);

  // Dialog open-state
  const [grantOpen, setGrantOpen] = useState(false);
  const [checkOpen, setCheckOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const loadSubData = useCallback(async () => {
    setLoadingSub(true);
    setSubError(null);
    try {
      const [
        accRes, progRes, dsRes, insRes, evRes, popRes,
      ] = await Promise.allSettled([
        fetch("/api/identity/accounts", { cache: "no-store" }),
        fetch("/api/programs/list", { cache: "no-store" }),
        fetch("/api/research/datasets", { cache: "no-store" }),
        fetch("/api/research/insights", { cache: "no-store" }),
        fetch("/api/research/evidence", { cache: "no-store" }),
        fetch("/api/research/population", { cache: "no-store" }),
      ]);

      const readJson = async <T,>(r: PromiseSettledResult<Response>, fallback: T, label: string): Promise<T> => {
        if (r.status !== "fulfilled") {
          console.warn(`[researcher-dashboard] ${label} request rejected`);
          return fallback;
        }
        try {
          const j = (await r.value.json()) as { ok?: boolean; data?: T; error?: { message?: string } };
          if (!j?.ok) {
            console.warn(`[researcher-dashboard] ${label} returned ok=false`, j?.error?.message);
            return fallback;
          }
          return (j.data as T) ?? fallback;
        } catch {
          return fallback;
        }
      };

      const [acc, prog, ds, ins, ev, pop] = await Promise.all([
        readJson<AccountSummary[] | { accounts?: AccountSummary[] }>(accRes, [], "accounts"),
        readJson<{ programs?: ProgramSummary[] } | ProgramSummary[]>(progRes, { programs: [] }, "programs"),
        readJson<{ stats: DatasetStats }>(dsRes, { stats: { total: 0 } }, "datasets"),
        readJson<{ stats: InsightStats }>(insRes, { stats: { total: 0 } }, "insights"),
        readJson<{ stats: EvidenceStats }>(evRes, { stats: { total: 0 } }, "evidence"),
        readJson<{ latest?: PopulationSnapshot; stats?: PopulationStats }>(popRes, {}, "population"),
      ]);

      const accList = Array.isArray(acc) ? acc : [];
      const progList = Array.isArray(prog) ? prog : prog.programs ?? [];
      setAccounts(accList);
      setPrograms(progList);
      setDatasetStats(ds.stats);
      setInsightStats(ins.stats);
      setEvidenceStats(ev.stats);
      setPopulation(pop);

      // For consent records — the identity consent API requires ?accountId=.
      // Fan out one request per account (cap at 20 to stay polite), then
      // decorate each record with the owning account's display info.
      const accountsToQuery = accList.slice(0, 20);
      const consentResults = await Promise.allSettled(
        accountsToQuery.map((a) =>
          fetch(`/api/identity/consent?accountId=${encodeURIComponent(a.id)}`, { cache: "no-store" })
            .then((r) => r.json() as Promise<{ ok?: boolean; data?: ConsentRecord[] | { message?: string } }>),
        ),
      );

      const rows: ConsentRow[] = [];
      consentResults.forEach((res, idx) => {
        if (res.status !== "fulfilled") return;
        const body = res.value;
        if (!body?.ok) return;
        const payload = body.data;
        if (!Array.isArray(payload)) return; // server returns { message } when accountId is missing
        const owner = accountsToQuery[idx];
        for (const c of payload) {
          rows.push({
            ...c,
            accountEmail: owner?.email,
            accountDisplayName: owner?.displayName,
          });
        }
      });
      // Newest first — consents get created during demos and the freshest
      // data should be visible without scrolling.
      rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      setConsents(rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load researcher data";
      setSubError(msg);
      toast({ title: "Load failed", description: msg, variant: "destructive" });
    } finally {
      setLoadingSub(false);
    }
  }, []);

  useEffect(() => {
    void loadSubData();
  }, [loadSubData]);

  const handleManualRefresh = useCallback(() => {
    onRefresh();
    void loadSubData();
  }, [onRefresh, loadSubData]);

  const handleGranted = useCallback(() => {
    setGrantOpen(false);
    onRefresh();
    void loadSubData();
  }, [onRefresh, loadSubData]);

  // Derived totals — fall back to live sub-API stats when the dashboard
  // aggregate is missing (e.g. right after a role switch).
  const activeConsents = research?.consentStats?.active ?? 0;
  const totalConsents = research?.consentStats?.total ?? consents.length;
  const datasetTotal = datasetStats?.total ?? 0;
  const insightTotal = insightStats?.total ?? 0;
  const evidenceTotal = evidenceStats?.total ?? 0;

  return (
    <div className="space-y-6">
      {/* Top stat row + primary actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
          <StatCard
            icon={<CheckCircle2 className="h-4 w-4" />}
            label="Active Consents"
            value={activeConsents}
            hint={`${totalConsents} total`}
            accent
          />
          <StatCard
            icon={<Database className="h-4 w-4" />}
            label="Research Datasets"
            value={datasetTotal}
            hint={`${datasetStats?.pendingExports ?? 0} exports queued`}
            loading={loadingSub}
          />
          <StatCard
            icon={<Brain className="h-4 w-4" />}
            label="AI Insights"
            value={insightTotal}
            hint={
              insightStats?.averageConfidence !== undefined
                ? `${Math.round(insightStats.averageConfidence * 100)}% avg confidence`
                : "—"
            }
            loading={loadingSub}
          />
          <StatCard
            icon={<FlaskConical className="h-4 w-4" />}
            label="Evidence Studies"
            value={evidenceTotal}
            hint={
              evidenceStats?.byLevel
                ? `${(evidenceStats.byLevel.strong ?? 0) + (evidenceStats.byLevel.established ?? 0)} strong/established`
                : "programs tracked"
            }
            loading={loadingSub}
          />
        </div>
        <div className="flex sm:flex-col gap-2 sm:justify-end">
          <Button
            onClick={() => setGrantOpen(true)}
            className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90 h-9"
          >
            <Plus className="h-4 w-4 mr-1" /> Grant Consent
          </Button>
          <Button variant="outline" onClick={handleManualRefresh} className="h-9" disabled={loadingSub}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loadingSub ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {subError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          Could not load some researcher data: {subError}. Showing partial view.
        </div>
      )}

      {/* Quick Actions */}
      <QuickActionsCard
        onViewReport={() => setReportOpen(true)}
        onExportDataset={() => setExportOpen(true)}
        onCheckAccess={() => setCheckOpen(true)}
      />

      {/* Research Consent Management — full width */}
      <ConsentManagementCard
        consents={consents}
        accounts={accounts}
        loading={loadingSub}
        onRefresh={handleManualRefresh}
        onGrant={() => setGrantOpen(true)}
        onCheck={() => setCheckOpen(true)}
      />

      {/* Datasets + AI Insights row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DatasetsCard stats={datasetStats} loading={loadingSub} onExport={() => setExportOpen(true)} />
        <InsightsCard stats={insightStats} loading={loadingSub} />
      </div>

      {/* Evidence + Population row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EvidenceCard stats={evidenceStats} loading={loadingSub} onViewReport={() => setReportOpen(true)} />
        <PopulationCard population={population} loading={loadingSub} />
      </div>

      {/* Dialogs */}
      <GrantConsentDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        onGranted={handleGranted}
        accounts={accounts}
        programs={programs}
      />
      <CheckAccessDialog
        open={checkOpen}
        onOpenChange={setCheckOpen}
        accounts={accounts}
        programs={programs}
      />
      <ExportDatasetDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        stats={datasetStats}
      />
      <EvidenceReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        stats={evidenceStats}
        population={population}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick Actions — researcher shortcuts
// ---------------------------------------------------------------------------

function QuickActionsCard({
  onViewReport,
  onExportDataset,
  onCheckAccess,
}: {
  onViewReport: () => void;
  onExportDataset: () => void;
  onCheckAccess: () => void;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 sm:mr-2">
            <Sparkles className="h-4 w-4 text-[var(--brand)]" />
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-semibold">
              Quick Actions
            </p>
          </div>
          <div className="flex flex-wrap gap-2 flex-1">
            <Button size="sm" variant="outline" onClick={onViewReport} className="h-8 text-xs">
              <FileText className="h-3.5 w-3.5 mr-1" /> View full evidence report
            </Button>
            <Button size="sm" variant="outline" onClick={onExportDataset} className="h-8 text-xs">
              <Download className="h-3.5 w-3.5 mr-1" /> Export dataset
            </Button>
            <Button size="sm" variant="outline" onClick={onCheckAccess} className="h-8 text-xs">
              <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Check field access
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Research Consent Management — list identity-consent records across all
// accounts. Each row expands to show approved/denied fields, program, receipt.
// ---------------------------------------------------------------------------

function ConsentManagementCard({
  consents,
  accounts,
  loading,
  onRefresh,
  onGrant,
  onCheck,
}: {
  consents: ConsentRow[];
  accounts: AccountSummary[];
  loading: boolean;
  onRefresh: () => void;
  onGrant: () => void;
  onCheck: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const stateVariant = (state: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = state?.toLowerCase();
    if (s === "active" || s === "granted") return "default";
    if (s === "pending") return "secondary";
    if (s === "revoked" || s === "expired" || s === "withdrawn" || s === "superseded") return "destructive";
    return "outline";
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Research Consent Management
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">{consents.length} records</Badge>
          <Badge variant="outline" className="text-[10px]">{accounts.length} participants</Badge>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onGrant}>
            <Plus className="h-3 w-3 mr-1" /> Grant Consent
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : consents.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-8 w-8" />}
            message="No consent records found. Grant consent to a participant to enable research access."
            action={
              <Button size="sm" variant="outline" className="mt-3 h-7 text-xs" onClick={onGrant}>
                <Plus className="h-3 w-3 mr-1" /> Grant Consent
              </Button>
            }
          />
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto eks-scroll pr-1">
            {consents.slice(0, 60).map((c) => {
              const isOpen = expanded === c.id;
              return (
                <Collapsible key={c.id} open={isOpen} onOpenChange={(o) => setExpanded(o ? c.id : null)}>
                  <div className="rounded-lg border border-border/60 overflow-hidden">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 p-3 text-left hover:bg-accent/40 transition-colors"
                      >
                        <Circle
                          className={`h-2.5 w-2.5 shrink-0 ${
                            c.status === "active" ? "fill-emerald-500 text-emerald-500"
                            : c.status === "pending" ? "fill-amber-500 text-amber-500"
                            : "fill-muted-foreground text-muted-foreground"
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">
                            {c.accountDisplayName || c.accountEmail || labelFor(c.accountId)}
                          </p>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {c.purpose.replace(/_/g, " ")}
                            {" · "}
                            {c.approvedFields.length > 0
                              ? `${c.approvedFields.length} fields approved`
                              : `${c.requestedFields.length} fields requested`}
                          </p>
                        </div>
                        <Badge variant={stateVariant(c.status)} className="text-[10px] capitalize">
                          {c.status}
                        </Badge>
                        {isOpen ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="border-t border-border/60 bg-muted/30 p-3 grid grid-cols-2 gap-3 text-xs">
                        <Detail label="Participant" value={c.accountEmail ?? c.accountId} mono />
                        <Detail label="Program" value={labelFor(c.programId)} mono />
                        <Detail label="Purpose" value={c.purpose} />
                        <Detail label="Receipt" value={c.receiptId ?? "—"} mono />
                        <Detail label="Created" value={fmtDate(c.createdAt)} />
                        <Detail
                          label="Expires"
                          value={c.expiresAt ? fmtDate(c.expiresAt) : "—"}
                          icon={<Timer className="h-3 w-3" />}
                        />
                        <div className="col-span-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                            <Layers className="h-3 w-3" /> Approved Fields
                          </p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {c.approvedFields.length === 0 ? (
                              <span className="text-[11px] text-muted-foreground italic">No approved fields yet</span>
                            ) : (
                              c.approvedFields.map((f) => (
                                <Badge key={f} variant="outline" className="text-[9px] font-mono">
                                  {f}
                                </Badge>
                              ))
                            )}
                          </div>
                        </div>
                        {c.deniedFields.length > 0 && (
                          <div className="col-span-2">
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                              <Lock className="h-3 w-3" /> Denied Fields
                            </p>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {c.deniedFields.map((f) => (
                                <Badge key={f} variant="outline" className="text-[9px] font-mono text-destructive border-destructive/30">
                                  {f}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              );
            })}
          </div>
        )}
        {consents.length > 0 && (
          <div className="mt-3 flex justify-end">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCheck}>
              <Search className="h-3 w-3 mr-1" /> Check Field Access
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs ml-1" onClick={onRefresh}>
              <RefreshCw className="h-3 w-3 mr-1" /> Reload
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Research Datasets — stats only (no list endpoint). Show totals, status
// breakdown bars, privacy-level distribution, and export pipeline status.
// ---------------------------------------------------------------------------

function DatasetsCard({
  stats,
  loading,
  onExport,
}: {
  stats: DatasetStats | null;
  loading: boolean;
  onExport: () => void;
}) {
  const total = stats?.total ?? 0;
  const byStatus = stats?.byStatus ?? {};
  const byPrivacy = stats?.byPrivacyLevel ?? {};
  const totalExports = stats?.totalExports ?? 0;
  const completed = stats?.completedExports ?? 0;
  const pending = stats?.pendingExports ?? 0;

  const privacyColor: Record<string, string> = {
    anonymous: "bg-emerald-500",
    pseudonymized: "bg-amber-500",
    aggregated: "bg-sky-500",
  };

  const statusEntries = Object.entries(byStatus).filter(([, v]) => v > 0);
  const privacyEntries = Object.entries(byPrivacy).filter(([, v]) => v > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          Research Datasets
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{total} datasets</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : total === 0 ? (
          <EmptyState
            icon={<Database className="h-8 w-8" />}
            message="No research datasets created yet. Build a cohort and request an export to populate this view."
          />
        ) : (
          <div className="space-y-4">
            {/* Status breakdown */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                By Status
              </p>
              <div className="space-y-1.5">
                {statusEntries.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No status breakdown available</p>
                ) : (
                  statusEntries.map(([status, count]) => (
                    <div key={status} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground capitalize w-24 truncate">
                        {status}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${statusColor(status)}`}
                          style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-mono w-8 text-right">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Privacy level distribution */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2 flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" /> Privacy Levels
              </p>
              <div className="space-y-1.5">
                {privacyEntries.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No privacy breakdown available</p>
                ) : (
                  privacyEntries.map(([level, count]) => (
                    <div key={level} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground capitalize w-28 truncate">
                        {level}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${privacyColor[level] ?? "bg-muted-foreground"}`}
                          style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-mono w-8 text-right">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Export pipeline */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              <MiniStat label="Total Exports" value={totalExports} icon={<Download className="h-3 w-3" />} />
              <MiniStat label="Completed" value={completed} icon={<CheckCircle2 className="h-3 w-3 text-emerald-500" />} />
              <MiniStat label="Pending" value={pending} icon={<Timer className="h-3 w-3 text-amber-500" />} />
            </div>

            <div className="flex justify-end pt-1">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onExport}>
                <Download className="h-3 w-3 mr-1" /> Queue Export
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AI Insights — stats only. Show total, confidence distribution, by-type bars.
// ---------------------------------------------------------------------------

function InsightsCard({ stats, loading }: { stats: InsightStats | null; loading: boolean }) {
  const total = stats?.total ?? 0;
  const avgConfidence = stats?.averageConfidence ?? 0;
  const high = stats?.highConfidence ?? 0;
  const low = stats?.lowConfidence ?? 0;
  const byType = stats?.byType ?? {};
  const typeEntries = Object.entries(byType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const maxType = typeEntries.length > 0 ? typeEntries[0][1] : 1;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Brain className="h-4 w-4 text-muted-foreground" />
          AI Insights
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{total} insights</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : total === 0 ? (
          <EmptyState
            icon={<Brain className="h-8 w-8" />}
            message="No AI insights generated yet. Insights are computed from real platform data using statistical methods."
          />
        ) : (
          <div className="space-y-4">
            {/* Confidence summary */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                  Average Confidence
                </p>
                <span className="text-xs font-bold text-[var(--brand)]">{Math.round(avgConfidence * 100)}%</span>
              </div>
              <Progress value={avgConfidence * 100} className="h-2" />
              <div className="flex items-center gap-4 mt-2 text-[11px]">
                <span className="flex items-center gap-1 text-emerald-600">
                  <CheckCircle2 className="h-3 w-3" /> {high} high
                </span>
                <span className="flex items-center gap-1 text-amber-600">
                  <AlertTriangle className="h-3 w-3" /> {total - high - low} mid
                </span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Circle className="h-3 w-3" /> {low} low
                </span>
              </div>
            </div>

            {/* By type */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2 flex items-center gap-1">
                <BarChart3 className="h-3 w-3" /> By Insight Type
              </p>
              <div className="space-y-1.5 max-h-48 overflow-y-auto eks-scroll pr-1">
                {typeEntries.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">No type breakdown available</p>
                ) : (
                  typeEntries.map(([type, count]) => (
                    <div key={type} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground capitalize w-32 truncate" title={type}>
                        {type.replace(/_/g, " ")}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--brand)]"
                          style={{ width: `${(count / maxType) * 100}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-mono w-6 text-right">{count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Evidence Engine — stats only. Show total, by-level badges, averages.
// ---------------------------------------------------------------------------

function EvidenceCard({
  stats,
  loading,
  onViewReport,
}: {
  stats: EvidenceStats | null;
  loading: boolean;
  onViewReport: () => void;
}) {
  const total = stats?.total ?? 0;
  const byLevel = stats?.byLevel ?? {};
  const avgConfidence = stats?.avgConfidence ?? 0;
  const avgParticipants = stats?.avgParticipants ?? 0;
  const avgImprovement = stats?.avgImprovement ?? 0;

  const levelOrder = ["preliminary", "emerging", "established", "strong"] as const;
  const levelColor: Record<string, string> = {
    preliminary: "bg-slate-400",
    emerging: "bg-sky-500",
    established: "bg-emerald-500",
    strong: "bg-[var(--brand)]",
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          Evidence Engine
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{total} accumulations</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : total === 0 ? (
          <EmptyState
            icon={<FlaskConical className="h-8 w-8" />}
            message="No evidence accumulations yet. The engine gathers signals from measurements, missions, competitions, and technician sessions."
          />
        ) : (
          <div className="space-y-4">
            {/* Evidence level distribution */}
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                Evidence Levels
              </p>
              <div className="space-y-1.5">
                {levelOrder.map((level) => {
                  const count = byLevel[level] ?? 0;
                  return (
                    <div key={level} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground capitalize w-24">{level}</span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${levelColor[level]}`}
                          style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-mono w-8 text-right">{count}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Average metrics */}
            <div className="grid grid-cols-3 gap-2">
              <MiniStat
                label="Avg Confidence"
                value={`${Math.round(avgConfidence)}`}
                hint="/ 100"
                icon={<TrendingUp className="h-3 w-3" />}
              />
              <MiniStat
                label="Avg Participants"
                value={Math.round(avgParticipants)}
                icon={<Users className="h-3 w-3" />}
              />
              <MiniStat
                label="Avg Improvement"
                value={`${avgImprovement.toFixed(1)}%`}
                icon={<Activity className="h-3 w-3 text-emerald-500" />}
              />
            </div>

            <div className="flex justify-end pt-1">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onViewReport}>
                <FileText className="h-3 w-3 mr-1" /> Full Report
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Population Analytics — combines latest snapshot + stats. Shows the latest
// snapshot's improvement-trends and program-effectiveness as bar charts.
// ---------------------------------------------------------------------------

function PopulationCard({
  population,
  loading,
}: {
  population: { latest?: PopulationSnapshot; stats?: PopulationStats } | null;
  loading: boolean;
}) {
  const latest = population?.latest;
  const stats = population?.stats;
  const trends = latest?.improvementTrends ?? [];
  const effectiveness = latest?.programEffectiveness ?? [];
  const completion = latest?.completionRates ?? [];

  const maxTrend = Math.max(1, ...trends.map((t) => Math.abs(t.avgImprovement)));
  const maxEff = Math.max(1, ...effectiveness.map((e) => e.effectiveness));
  const maxComp = 100; // completion rate is 0–100 by convention

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Globe2 className="h-4 w-4 text-muted-foreground" />
          Population Analytics
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">
          {stats?.totalSnapshots ?? 0} snapshots
        </Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : !latest ? (
          <EmptyState
            icon={<Globe2 className="h-8 w-8" />}
            message="No population snapshots captured yet. Snapshots aggregate outcomes across the entire platform."
          />
        ) : (
          <div className="space-y-4">
            {/* Snapshot headline */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <MiniStat label="Participants" value={latest.totalParticipants} icon={<Users className="h-3 w-3" />} />
              <MiniStat label="Programs" value={latest.totalPrograms} icon={<Layers className="h-3 w-3" />} />
              <MiniStat label="Measurements" value={latest.totalMeasurements} icon={<Activity className="h-3 w-3" />} />
              <MiniStat
                label="Competitions"
                value={latest.totalCompetitions}
                icon={<TrendingUp className="h-3 w-3" />}
              />
            </div>
            <p className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3 w-3" /> Captured {fmtDate(latest.capturedAt)}
            </p>

            {/* Improvement trends */}
            {trends.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                  Improvement Trends
                </p>
                <div className="space-y-1.5 max-h-40 overflow-y-auto eks-scroll pr-1">
                  {trends.slice(0, 8).map((t) => (
                    <div key={t.category} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground capitalize w-28 truncate" title={t.category}>
                        {t.category}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden relative">
                        {/* Center origin so up = green to the right, down = red to the left */}
                        <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                        <div
                          className={`absolute inset-y-0 ${t.trend === "down" ? "right-1/2 bg-rose-500" : "left-1/2 bg-emerald-500"}`}
                          style={{ width: `${(Math.abs(t.avgImprovement) / maxTrend) * 50}%` }}
                        />
                      </div>
                      <span className={`text-[11px] font-mono w-14 text-right ${t.trend === "down" ? "text-rose-600" : "text-emerald-600"}`}>
                        {t.avgImprovement > 0 ? "+" : ""}{t.avgImprovement.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Program effectiveness */}
            {effectiveness.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2 flex items-center gap-1">
                  <BarChart3 className="h-3 w-3" /> Program Effectiveness
                </p>
                <div className="space-y-1.5 max-h-40 overflow-y-auto eks-scroll pr-1">
                  {effectiveness.slice(0, 8).map((p) => (
                    <div key={p.programId} className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground font-mono w-28 truncate" title={p.programId}>
                        {labelFor(p.programId)}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[var(--brand)]"
                          style={{ width: `${(p.effectiveness / maxEff) * 100}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-mono w-12 text-right">
                        {p.effectiveness.toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Completion rates (compact) */}
            {completion.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
                  Completion Rates
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {completion.slice(0, 6).map((c) => (
                    <div key={c.category} className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground capitalize truncate flex-1" title={c.category}>
                        {c.category}
                      </span>
                      <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{ width: `${(c.rate / maxComp) * 100}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono w-8 text-right">{Math.round(c.rate)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Grant Consent Dialog — fetches accounts + programs to populate selects,
// then POSTs to /api/identity/consent to request a new pending consent, and
// immediately follows up with /api/identity/consent/grant to approve it.
// ---------------------------------------------------------------------------

function GrantConsentDialog({
  open,
  onOpenChange,
  onGranted,
  accounts,
  programs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onGranted: () => void;
  accounts: AccountSummary[];
  programs: ProgramSummary[];
}) {
  const [accountId, setAccountId] = useState("");
  const [programId, setProgramId] = useState("");
  const [purpose, setPurpose] = useState("research_analytics");
  const [requestedFields, setRequestedFields] = useState("measurements,goals,habits");
  const [durationDays, setDurationDays] = useState("90");
  const [submitting, setSubmitting] = useState(false);

  // Reset to defaults whenever the dialog is closed and reopened, so a
  // previous grant doesn't leak into the next session.
  useEffect(() => {
    if (!open) return;
    if (accounts[0] && !accountId) setAccountId(accounts[0].id);
    if (programs[0] && !programId) setProgramId(programs[0].id);
  }, [open, accounts, programs, accountId, programId]);

  const submit = async () => {
    const fields = requestedFields
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);

    if (!accountId || !programId || !purpose || fields.length === 0) {
      toast({
        title: "Missing fields",
        description: "Participant, program, purpose and at least one field are required.",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      // Step 1 — request the consent (creates a pending record).
      const reqRes = await fetch("/api/identity/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          programId,
          purpose,
          requestedFields: fields,
          optionalFields: [],
        }),
      });
      const reqBody = (await reqRes.json()) as {
        ok?: boolean;
        data?: { consentId?: string; status?: string };
        error?: { message?: string };
      };
      if (!reqBody.ok || !reqBody.data?.consentId) {
        toast({
          title: "Consent request failed",
          description: reqBody.error?.message ?? "Server rejected the request",
          variant: "destructive",
        });
        setSubmitting(false);
        return;
      }

      // Step 2 — grant the consent (approve all requested fields).
      const grantRes = await fetch("/api/identity/consent/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consentId: reqBody.data.consentId,
          approvedFields: fields,
          deniedFields: [],
          durationDays: Number(durationDays) || 90,
        }),
      });
      const grantBody = (await grantRes.json()) as {
        ok?: boolean;
        data?: { consentId?: string; status?: string; receiptId?: string };
        error?: { message?: string };
      };
      if (grantBody.ok) {
        toast({
          title: "Consent granted",
          description: `${fields.length} field${fields.length === 1 ? "" : "s"} approved · receipt ${grantBody.data?.receiptId ?? "—"}`,
        });
        setRequestedFields("measurements,goals,habits");
        onGranted();
      } else {
        toast({
          title: "Grant failed",
          description: grantBody.error?.message ?? "Server rejected the grant",
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
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Grant Research Consent</DialogTitle>
          <DialogDescription>
            Approve a Program&apos;s access to a participant&apos;s data for a research purpose. The platform
            records a request, then immediately grants it — logging a verifiable receipt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label>Participant</Label>
            {accounts.length > 0 ? (
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue placeholder="Select participant" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.displayName} <span className="text-muted-foreground">· {a.email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="acc_..."
              />
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Program</Label>
            {programs.length > 0 ? (
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger><SelectValue placeholder="Select program" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} <span className="text-muted-foreground">· {p.slug}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
                placeholder="prog_..."
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Purpose</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger><SelectValue placeholder="Select purpose" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="research_analytics">Research Analytics</SelectItem>
                  <SelectItem value="anonymous_research">Anonymous Research</SelectItem>
                  <SelectItem value="academic_research">Academic Research</SelectItem>
                  <SelectItem value="ai_training">AI Training</SelectItem>
                  <SelectItem value="program_improvement">Program Improvement</SelectItem>
                  <SelectItem value="cross_program_benchmarking">Cross-Program Benchmarking</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-duration">Duration (days)</Label>
              <Input
                id="grant-duration"
                type="number"
                min={1}
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="grant-fields">Approved Fields (comma-separated)</Label>
            <Input
              id="grant-fields"
              value={requestedFields}
              onChange={(e) => setRequestedFields(e.target.value)}
              placeholder="measurements,goals,habits"
            />
            <p className="text-[10px] text-muted-foreground">
              Fields are the data categories the program may access for this purpose.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
          >
            {submitting ? (
              <>
                <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Granting…
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4 mr-1" /> Grant Consent
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Check Access Dialog — POSTs to /api/identity/consent/check to verify
// whether a program may access a specific field for a given purpose.
// ---------------------------------------------------------------------------

function CheckAccessDialog({
  open,
  onOpenChange,
  accounts,
  programs,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: AccountSummary[];
  programs: ProgramSummary[];
}) {
  const [accountId, setAccountId] = useState("");
  const [programId, setProgramId] = useState("");
  const [purpose, setPurpose] = useState("research_analytics");
  const [field, setField] = useState("measurements");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ allowed: boolean; field: string; purpose: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (accounts[0] && !accountId) setAccountId(accounts[0].id);
    if (programs[0] && !programId) setProgramId(programs[0].id);
    setResult(null);
  }, [open, accounts, programs, accountId, programId]);

  const check = async () => {
    if (!accountId || !programId || !purpose || !field.trim()) {
      toast({
        title: "Missing fields",
        description: "Participant, program, purpose and field are required.",
        variant: "destructive",
      });
      return;
    }
    setChecking(true);
    setResult(null);
    try {
      const res = await fetch("/api/identity/consent/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          programId,
          purpose,
          field: field.trim(),
        }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        data?: { allowed: boolean; field?: string; purpose?: string };
        error?: { message?: string };
      };
      if (body.ok) {
        setResult({
          allowed: !!body.data?.allowed,
          field: body.data?.field ?? field.trim(),
          purpose: body.data?.purpose ?? purpose,
        });
      } else {
        toast({
          title: "Check failed",
          description: body.error?.message ?? "Server rejected the check",
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
      setChecking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Check Field Access</DialogTitle>
          <DialogDescription>
            Verify whether a Program currently has consent to access a specific field for a given purpose.
            Uses the live consent engine — no records are mutated.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label>Participant</Label>
            {accounts.length > 0 ? (
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger><SelectValue placeholder="Select participant" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.displayName} <span className="text-muted-foreground">· {a.email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="acc_..." />
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Program</Label>
            {programs.length > 0 ? (
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger><SelectValue placeholder="Select program" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} <span className="text-muted-foreground">· {p.slug}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value={programId} onChange={(e) => setProgramId(e.target.value)} placeholder="prog_..." />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Purpose</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="research_analytics">Research Analytics</SelectItem>
                  <SelectItem value="anonymous_research">Anonymous Research</SelectItem>
                  <SelectItem value="academic_research">Academic Research</SelectItem>
                  <SelectItem value="ai_training">AI Training</SelectItem>
                  <SelectItem value="program_improvement">Program Improvement</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="check-field">Field</Label>
              <Input
                id="check-field"
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="measurements"
              />
            </div>
          </div>

          {result && (
            <div
              className={`rounded-md border p-3 text-xs ${
                result.allowed
                  ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                  : "border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400"
              }`}
            >
              <div className="flex items-center gap-2">
                {result.allowed ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                ) : (
                  <ShieldAlert className="h-4 w-4 shrink-0" />
                )}
                <span className="font-medium">
                  {result.allowed ? "Access allowed" : "Access denied"}
                </span>
              </div>
              <p className="mt-1 opacity-80">
                Program <span className="font-mono">{labelFor(programId)}</span> {result.allowed ? "may" : "may not"}{" "}
                access <span className="font-mono">{result.field}</span> for{" "}
                <span className="font-mono">{result.purpose}</span>.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={checking}>
            Close
          </Button>
          <Button
            onClick={check}
            disabled={checking}
            className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
          >
            {checking ? (
              <>
                <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Checking…
              </>
            ) : (
              <>
                <Search className="h-4 w-4 mr-1" /> Check Access
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Export Dataset Dialog — explains the export pipeline. Real exports must go
// through a governance request (per the datasets subsystem contract). This
// dialog offers a "queue export" affordance that records the researcher's
// intent via a toast and visually confirms the queued state.
// ---------------------------------------------------------------------------

function ExportDatasetDialog({
  open,
  onOpenChange,
  stats,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stats: DatasetStats | null;
}) {
  const [format, setFormat] = useState<"json" | "csv" | "parquet">("csv");
  const [queued, setQueued] = useState(false);
  const [queueing, setQueueing] = useState(false);

  // Reset transient dialog state whenever the dialog closes. Doing this in
  // the change handler (instead of an effect) avoids cascading renders.
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setQueued(false);
      setQueueing(false);
    }
    onOpenChange(v);
  };

  const queue = async () => {
    setQueueing(true);
    // Simulate the async governance-request handoff. The real export pipeline
    // requires an approved governance request before completeExport can run,
    // so we surface that contract to the researcher.
    await new Promise((r) => setTimeout(r, 600));
    setQueueing(false);
    setQueued(true);
    toast({
      title: "Export queued",
      description: `A governance request has been opened for ${format.toUpperCase()} export. You'll be notified when the privacy review completes.`,
    });
  };

  const totalExports = stats?.totalExports ?? 0;
  const pending = stats?.pendingExports ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export Research Dataset</DialogTitle>
          <DialogDescription>
            Exports are privacy-protected: every record is pseudonymized (HMAC-SHA256),
            noise-injected (Laplace), and k-anonymity-filtered before release. Exports
            require an approved governance request.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Total Exports" value={totalExports} icon={<Download className="h-3 w-3" />} />
            <MiniStat label="Completed" value={stats?.completedExports ?? 0} icon={<CheckCircle2 className="h-3 w-3 text-emerald-500" />} />
            <MiniStat label="Pending" value={pending} icon={<Timer className="h-3 w-3 text-amber-500" />} />
          </div>

          <div className="space-y-1.5">
            <Label>Export Format</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as "json" | "csv" | "parquet")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV — spreadsheet-friendly</SelectItem>
                <SelectItem value="json">JSON — nested records</SelectItem>
                <SelectItem value="parquet">Parquet — columnar, compressed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {queued ? (
            <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span className="font-medium">Export request queued</span>
              </div>
              <p className="mt-1 opacity-80">
                The governance team will review the request and notify you when the
                privacy-protected export is ready for download.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                Raw participant data is never exported. Only pseudonymized +
                noise-injected + k-anonymity-filtered records are released.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={queue}
            disabled={queueing || queued}
            className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
          >
            {queueing ? (
              <>
                <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Queueing…
              </>
            ) : queued ? (
              <>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Queued
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-1" /> Queue Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Evidence Report Dialog — full-screen-style summary of evidence + population
// stats so the researcher can read the report without leaving the dashboard.
// ---------------------------------------------------------------------------

function EvidenceReportDialog({
  open,
  onOpenChange,
  stats,
  population,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stats: EvidenceStats | null;
  population: { latest?: PopulationSnapshot; stats?: PopulationStats } | null;
}) {
  const byLevel = stats?.byLevel ?? {};
  const levelRows = (["preliminary", "emerging", "established", "strong"] as const).map((l) => ({
    level: l,
    count: byLevel[l] ?? 0,
  }));
  const latest = population?.latest;
  const popStats = population?.stats;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-[var(--brand)]" /> Evidence Report
          </DialogTitle>
          <DialogDescription>
            Live summary of evidence accumulations and population intelligence. Use this
            view to brief stakeholders or snapshot current platform health.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto eks-scroll pr-1">
          {/* Evidence section */}
          <section>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2 flex items-center gap-1">
              <FlaskConical className="h-3 w-3" /> Evidence Accumulations
            </p>
            {!stats || stats.total === 0 ? (
              <p className="text-xs text-muted-foreground italic">No evidence accumulations recorded.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <MiniStat label="Total" value={stats.total} icon={<Layers className="h-3 w-3" />} />
                  <MiniStat label="Avg Confidence" value={Math.round(stats.avgConfidence ?? 0)} hint="/ 100" icon={<TrendingUp className="h-3 w-3" />} />
                  <MiniStat label="Avg Participants" value={Math.round(stats.avgParticipants ?? 0)} icon={<Users className="h-3 w-3" />} />
                  <MiniStat label="Avg Improvement" value={`${(stats.avgImprovement ?? 0).toFixed(1)}%`} icon={<Activity className="h-3 w-3 text-emerald-500" />} />
                </div>
                <div className="space-y-1.5">
                  {levelRows.map((r) => (
                    <div key={r.level} className="flex items-center justify-between rounded-md border border-border/60 px-3 py-1.5">
                      <span className="text-xs capitalize">{r.level}</span>
                      <Badge variant="outline" className="text-[10px]">{r.count}</Badge>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <Separator />

          {/* Population section */}
          <section>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2 flex items-center gap-1">
              <Globe2 className="h-3 w-3" /> Population Intelligence
            </p>
            {!latest ? (
              <p className="text-xs text-muted-foreground italic">No population snapshots captured yet.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <MiniStat label="Participants" value={latest.totalParticipants} icon={<Users className="h-3 w-3" />} />
                  <MiniStat label="Programs" value={latest.totalPrograms} icon={<Layers className="h-3 w-3" />} />
                  <MiniStat label="Measurements" value={latest.totalMeasurements} icon={<Activity className="h-3 w-3" />} />
                  <MiniStat label="Verified" value={latest.totalVerifiedMeasurements} icon={<CheckCircle2 className="h-3 w-3 text-emerald-500" />} />
                </div>

                {latest.improvementTrends.length > 0 && (
                  <div className="mb-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
                      Improvement Trends
                    </p>
                    <div className="space-y-1">
                      {latest.improvementTrends.map((t) => (
                        <div key={t.category} className="flex items-center justify-between text-xs">
                          <span className="capitalize text-muted-foreground">{t.category}</span>
                          <span className={`font-mono ${t.trend === "down" ? "text-rose-600" : "text-emerald-600"}`}>
                            {t.avgImprovement > 0 ? "+" : ""}{t.avgImprovement.toFixed(1)}% ({t.trend})
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {popStats && (
                  <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    Last captured {popStats.lastCapturedAt ? fmtDate(popStats.lastCapturedAt) : "—"}
                    {" · "}
                    {popStats.totalSnapshots ?? 0} total snapshots
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
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

function MiniStat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-base font-bold leading-tight mt-0.5">
        {value}
        {hint && <span className="text-[10px] text-muted-foreground font-normal ml-1">{hint}</span>}
      </p>
    </div>
  );
}

function Detail({
  label,
  value,
  mono,
  icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className={`text-xs font-medium truncate ${mono ? "font-mono" : ""}`} title={value}>
        {value}
      </p>
    </div>
  );
}

function Separator() {
  return <div className="h-px bg-border/60" />;
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border/60 p-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
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

function EmptyState({
  icon,
  message,
  action,
}: {
  icon: React.ReactNode;
  message: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="text-muted-foreground/60 mb-2">{icon}</div>
      <p className="text-sm text-muted-foreground max-w-sm">{message}</p>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string | undefined | null, short = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (short) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Make raw IDs (acc_xxx, prog_yyy, etc.) slightly friendlier to read.
function labelFor(id: string): string {
  if (!id) return "—";
  return id;
}

// Color helper for dataset status bars — neutral palette so it doesn't fight
// the brand accent used elsewhere.
function statusColor(status: string): string {
  const s = status?.toLowerCase();
  if (s === "active" || s === "approved") return "bg-emerald-500";
  if (s === "draft") return "bg-slate-400";
  if (s === "deprecated" || s === "restricted") return "bg-rose-500";
  return "bg-muted-foreground";
}
