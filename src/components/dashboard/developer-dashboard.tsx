"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import {
  Code2, Store, TrendingUp, Trophy, ShieldCheck, Play, FileCode,
  Terminal, RefreshCw, Package, CheckCircle2, XCircle, AlertTriangle,
  ArrowRight, Layers, Sparkles, ExternalLink, BadgeCheck, Activity,
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
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types — mirror the shapes returned by /api/dashboard (developer role) and
// the developer / programs / marketplace sub-APIs. All API responses are
// wrapped by `withPlatform` as `{ ok, data, meta }`. Fields are kept optional
// so the dashboard degrades gracefully when the platform has no seeded data.
// ---------------------------------------------------------------------------

interface DeveloperProfile {
  id: string;
  name: string;
  email: string;
  verified: boolean;
  metrics: {
    programsCount?: number;
    publishedCount?: number;
    totalInstalls?: number;
    avgRating?: number;
  };
}

interface MarketplaceStats {
  total?: number;
  published?: number;
  totalInstalls?: number;
  activeInstalls?: number;
}

interface DashboardData {
  persona: string;
  displayName: string;
  email: string;
  developer?: {
    profiles: DeveloperProfile[];
  };
  marketplace?: {
    stats: MarketplaceStats;
  };
}

type ProgramState =
  | "draft" | "built" | "signed" | "validated" | "uploaded"
  | "in_review" | "certified" | "rejected" | "published"
  | "installed" | "active" | "paused" | "disabled"
  | "deprecated" | "archived" | "uninstalled";

interface ProgramSummary {
  id: string;
  slug: string;
  name: string;
  kind: string;
  category?: string;
  state: ProgramState | string;
  developerId: string;
  versionCount: number;
  currentVersionId?: string;
  installedCount: number;
  activeInstallCount: number;
  rating?: number;
  reviewCount?: number;
  createdAt?: string;
  publishedAt?: string;
  forkedFrom?: string | null;
}

interface SdkTemplate {
  id: string;
  name: string;
  description?: string;
}

interface ScaffoldResult {
  files: { path: string; contentPreview: string }[];
  fileCount: number;
  manifestSlug: string;
}

interface ApiEndpoint {
  id: string;
  path: string;
  method: string;
  description?: string;
  category?: string;
  authRequired?: boolean;
}

interface SimulatorScenario {
  id: string;
  name: string;
  description?: string;
  entityCount: number;
  eventCount: number;
}

interface SimulationResult {
  simulationId: string;
  eventsFired: number;
  errors: unknown[];
  durationMs: number;
  stateSnapshot?: unknown;
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
  rating?: number;
  reviewCount?: number;
}

interface CertifyResult {
  runId: string;
  status: string;
  passed: number;
  failed: number;
  warned: number;
  checks: { rule: string; category?: string; result: string; message?: string }[];
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DeveloperDashboard({ data, onRefresh }: { data: DashboardData; onRefresh: () => void }) {
  const profiles = data.developer?.profiles ?? [];
  const mpStats = data.marketplace?.stats ?? {};
  const primaryProfile = profiles[0];

  // Sub-API state — loaded client-side; dashboard route only ships aggregates.
  const [programs, setPrograms] = useState<ProgramSummary[]>([]);
  const [templates, setTemplates] = useState<SdkTemplate[]>([]);
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([]);
  const [scenarios, setScenarios] = useState<SimulatorScenario[]>([]);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);

  const [loadingSub, setLoadingSub] = useState(true);
  const [subError, setSubError] = useState<string | null>(null);

  // Per-row action state.
  const [publishing, setPublishing] = useState<Record<string, boolean>>({});
  const [certifying, setCertifying] = useState<Record<string, boolean>>({});
  const [runningSim, setRunningSim] = useState<Record<string, boolean>>({});

  // Certify dialog (shows rule results after a run).
  const [certResult, setCertResult] = useState<{ program: ProgramSummary; result: CertifyResult } | null>(null);
  // Scaffold dialog (shows scaffolded file tree after a run).
  const [scaffoldResult, setScaffoldResult] = useState<ScaffoldResult | null>(null);
  // Simulation dialog (shows events fired / errors after a run).
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);

  const loadSubData = useCallback(async () => {
    setLoadingSub(true);
    setSubError(null);
    try {
      const [progRes, sdkRes, apiRes, simRes, mpRes] = await Promise.allSettled([
        fetch("/api/programs/list", { cache: "no-store" }),
        fetch("/api/programs/sdk/scaffold", { cache: "no-store" }),
        fetch("/api/developer/api-explorer", { cache: "no-store" }),
        fetch("/api/developer/simulator", { cache: "no-store" }),
        fetch("/api/marketplace/listings", { cache: "no-store" }),
      ]);

      const readJson = async <T,>(r: PromiseSettledResult<Response>, fallback: T, label: string): Promise<T> => {
        if (r.status !== "fulfilled") {
          console.warn(`[developer-dashboard] ${label} request rejected`);
          return fallback;
        }
        try {
          const j = (await r.value.json()) as { ok?: boolean; data?: T; error?: { message?: string } };
          if (!j?.ok) {
            console.warn(`[developer-dashboard] ${label} returned ok=false`, j?.error?.message);
            return fallback;
          }
          return (j.data as T) ?? fallback;
        } catch {
          return fallback;
        }
      };

      const [prog, sdk, api, sim, mp] = await Promise.all([
        readJson<{ programs: ProgramSummary[] } | ProgramSummary[]>(progRes, { programs: [] }, "programs"),
        readJson<{ templates: SdkTemplate[] } | SdkTemplate[]>(sdkRes, { templates: [] }, "sdk-templates"),
        readJson<{ endpoints: ApiEndpoint[] } | ApiEndpoint[]>(apiRes, { endpoints: [] }, "api-explorer"),
        readJson<{ scenarios: SimulatorScenario[] } | SimulatorScenario[]>(simRes, { scenarios: [] }, "simulator"),
        readJson<{ listings: MarketplaceListing[] } | MarketplaceListing[]>(mpRes, { listings: [] }, "marketplace"),
      ]);

      setPrograms(Array.isArray(prog) ? prog : prog.programs ?? []);
      setTemplates(Array.isArray(sdk) ? sdk : sdk.templates ?? []);
      setEndpoints(Array.isArray(api) ? api : api.endpoints ?? []);
      setScenarios(Array.isArray(sim) ? sim : sim.scenarios ?? []);
      setListings(Array.isArray(mp) ? mp : mp.listings ?? []);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load developer data";
      setSubError(msg);
      toast({ title: "Load failed", description: msg, variant: "destructive" });
    } finally {
      setLoadingSub(false);
    }
  }, []);

  useEffect(() => {
    void loadSubData();
  }, [loadSubData]);

  // --- Actions -----------------------------------------------------------

  const publishProgram = useCallback(async (p: ProgramSummary) => {
    setPublishing((s) => ({ ...s, [p.id]: true }));
    try {
      const res = await fetch(`/api/programs/${encodeURIComponent(p.id)}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "published" }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: { programId?: string; state?: string }; error?: { message?: string } };
      if (j.ok) {
        toast({
          title: "Program published",
          description: `${p.name} is now ${j.data?.state ?? "published"} on the marketplace.`,
        });
        setPrograms((prev) => prev.map((x) => (x.id === p.id ? { ...x, state: j.data?.state ?? "published" } : x)));
        onRefresh();
      } else {
        toast({
          title: "Publish failed",
          description: j.error?.message ?? "Server rejected the transition",
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
      setPublishing((s) => ({ ...s, [p.id]: false }));
    }
  }, [onRefresh]);

  const certifyProgram = useCallback(async (p: ProgramSummary) => {
    setCertifying((s) => ({ ...s, [p.id]: true }));
    try {
      const res = await fetch(`/api/programs/${encodeURIComponent(p.id)}/certify`, {
        method: "POST",
      });
      const j = (await res.json()) as { ok?: boolean; data?: CertifyResult; error?: { message?: string } };
      if (j.ok && j.data) {
        toast({
          title: j.data.status === "passed" ? "Certification passed" : "Certification finished",
          description: `${p.name}: ${j.data.passed} passed · ${j.data.failed} failed · ${j.data.warned} warned`,
          variant: j.data.status === "passed" ? "default" : "destructive",
        });
        setCertResult({ program: p, result: j.data });
        // Re-fetch programs list so the new state shows up.
        void loadSubData();
        onRefresh();
      } else {
        toast({
          title: "Certification failed",
          description: j.error?.message ?? "Server rejected the certification run",
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
      setCertifying((s) => ({ ...s, [p.id]: false }));
    }
  }, [loadSubData, onRefresh]);

  const runSimulation = useCallback(async (s: SimulatorScenario) => {
    setRunningSim((st) => ({ ...st, [s.id]: true }));
    try {
      const res = await fetch("/api/developer/simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: s.id }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: SimulationResult; error?: { message?: string } };
      if (j.ok && j.data) {
        toast({
          title: "Simulation complete",
          description: `${s.name}: ${j.data.eventsFired} events fired in ${j.data.durationMs}ms`,
        });
        setSimResult(j.data);
      } else {
        toast({
          title: "Simulation failed",
          description: j.error?.message ?? "Server rejected the simulation run",
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
      setRunningSim((st) => ({ ...st, [s.id]: false }));
    }
  }, []);

  const handleManualRefresh = useCallback(() => {
    onRefresh();
    void loadSubData();
  }, [onRefresh, loadSubData]);

  // --- Derived -----------------------------------------------------------
  const totalListings = mpStats.total ?? listings.length;

  return (
    <div className="space-y-6">
      {/* Top stat row + primary action */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
          <StatCard
            icon={<Code2 className="h-4 w-4" />}
            label="Programs"
            value={primaryProfile?.metrics?.programsCount ?? programs.length}
            hint={`${programs.filter((p) => p.state !== "archived").length} active`}
          />
          <StatCard
            icon={<Store className="h-4 w-4" />}
            label="Published"
            value={primaryProfile?.metrics?.publishedCount ?? programs.filter((p) => p.state === "published").length}
            hint={`${programs.filter((p) => p.state === "draft").length} in draft`}
          />
          <StatCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Total Installs"
            value={primaryProfile?.metrics?.totalInstalls ?? mpStats.totalInstalls ?? 0}
            hint={`${mpStats.activeInstalls ?? 0} active`}
          />
          <StatCard
            icon={<Trophy className="h-4 w-4" />}
            label="Marketplace"
            value={totalListings}
            hint={`${mpStats.published ?? 0} published`}
            accent
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
          Could not load some developer data: {subError}. Showing partial view.
        </div>
      )}

      {/* Profile + Marketplace performance */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DeveloperProfileCard profile={primaryProfile} loading={loadingSub && !primaryProfile} />
        <MarketplacePerformanceCard listings={listings} stats={mpStats} loading={loadingSub} />
      </div>

      {/* My Programs (full width) */}
      <MyProgramsCard
        programs={programs}
        loading={loadingSub}
        publishing={publishing}
        certifying={certifying}
        onPublish={publishProgram}
        onCertify={certifyProgram}
      />

      {/* SDK Scaffold + API Explorer */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SdkScaffoldCard
          templates={templates}
          loading={loadingSub}
          onScaffold={setScaffoldResult}
        />
        <ApiExplorerCard endpoints={endpoints} loading={loadingSub} />
      </div>

      {/* Simulator + Sample programs (samples is a bonus read-only list) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SimulatorCard
          scenarios={scenarios}
          loading={loadingSub}
          running={runningSim}
          onRun={runSimulation}
        />
        <SamplesCard loading={loadingSub} />
      </div>

      {/* Result dialogs */}
      <CertifyResultDialog
        open={!!certResult}
        onOpenChange={(o) => !o && setCertResult(null)}
        data={certResult}
      />
      <ScaffoldResultDialog
        open={!!scaffoldResult}
        onOpenChange={(o) => !o && setScaffoldResult(null)}
        result={scaffoldResult}
      />
      <SimulationResultDialog
        open={!!simResult}
        onOpenChange={(o) => !o && setSimResult(null)}
        result={simResult}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Developer Profile card
// ---------------------------------------------------------------------------

function DeveloperProfileCard({ profile, loading }: { profile?: DeveloperProfile; loading: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <BadgeCheck className="h-4 w-4 text-muted-foreground" />
          Developer Profile
        </CardTitle>
        {profile?.verified && (
          <Badge className="text-[10px] bg-emerald-500/15 text-emerald-600 border-emerald-600/30">
            <ShieldCheck className="h-3 w-3 mr-0.5" /> Verified
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {loading && !profile ? (
          <div className="space-y-2">
            <div className="h-5 w-1/2 rounded bg-muted animate-pulse" />
            <div className="h-3 w-1/3 rounded bg-muted animate-pulse" />
          </div>
        ) : !profile ? (
          <EmptyState
            icon={<BadgeCheck className="h-8 w-8" />}
            message="No developer profile registered. Sign in with a developer account to seed a profile."
          />
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-base font-semibold flex items-center gap-1.5">
                {profile.name}
                {profile.verified && <ShieldCheck className="h-4 w-4 text-emerald-600" />}
              </p>
              <p className="text-xs text-muted-foreground font-mono">{profile.email}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono truncate" title={profile.id}>
                {profile.id}
              </p>
            </div>
            <Separator />
            <div className="grid grid-cols-2 gap-3">
              <MetricTile label="Programs" value={profile.metrics.programsCount ?? 0} icon={<Code2 className="h-3 w-3" />} />
              <MetricTile label="Published" value={profile.metrics.publishedCount ?? 0} icon={<Store className="h-3 w-3" />} />
              <MetricTile label="Total Installs" value={profile.metrics.totalInstalls ?? 0} icon={<TrendingUp className="h-3 w-3" />} />
              <MetricTile
                label="Avg Rating"
                value={typeof profile.metrics.avgRating === "number" ? `${profile.metrics.avgRating.toFixed(1)}★` : "—"}
                icon={<Trophy className="h-3 w-3" />}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricTile({ label, value, icon }: { label: string; value: React.ReactNode; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-lg font-bold mt-0.5">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Programs card — list with state badges + Publish / Certify / View actions
// ---------------------------------------------------------------------------

function MyProgramsCard({
  programs,
  loading,
  publishing,
  certifying,
  onPublish,
  onCertify,
}: {
  programs: ProgramSummary[];
  loading: boolean;
  publishing: Record<string, boolean>;
  certifying: Record<string, boolean>;
  onPublish: (p: ProgramSummary) => void;
  onCertify: (p: ProgramSummary) => void;
}) {
  const sorted = useMemo(() => {
    return [...programs].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
  }, [programs]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          My Programs
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{programs.length} total</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<Package className="h-8 w-8" />}
            message="No programs yet. Scaffold one from the SDK card to get started."
          />
        ) : (
          <div className="space-y-1.5 max-h-[28rem] overflow-y-auto eks-scroll pr-1">
            {sorted.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-border/60 p-3 hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
                    <Layers className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {p.kind}
                      {p.category ? ` · ${p.category}` : ""}
                      {" · v"}{p.versionCount}
                      {typeof p.rating === "number" && p.rating > 0 ? ` · ${p.rating.toFixed(1)}★` : ""}
                    </p>
                    <p className="text-[10px] text-muted-foreground/80 font-mono truncate mt-0.5" title={p.slug}>
                      {p.slug}
                    </p>
                  </div>
                  <StateBadge state={p.state} />
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {p.state === "draft" && (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-xs bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
                      disabled={publishing[p.id]}
                      onClick={() => onPublish(p)}
                    >
                      {publishing[p.id] ? (
                        <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Publishing…</>
                      ) : (
                        <><Store className="h-3 w-3 mr-1" /> Publish</>
                      )}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={certifying[p.id]}
                    onClick={() => onCertify(p)}
                  >
                    {certifying[p.id] ? (
                      <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Certifying…</>
                    ) : (
                      <><ShieldCheck className="h-3 w-3 mr-1" /> Certify</>
                    )}
                  </Button>
                  <Button
                    asChild
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs ml-auto"
                  >
                    <Link href={`/programs/${encodeURIComponent(p.id)}`}>
                      View Details <ArrowRight className="h-3 w-3 ml-1" />
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StateBadge({ state }: { state: string }) {
  const s = state?.toLowerCase();
  const variant: "default" | "secondary" | "destructive" | "outline" =
    s === "published" || s === "certified" || s === "active" ? "default"
    : s === "draft" || s === "in_review" || s === "validated" || s === "built" || s === "signed" || s === "uploaded" ? "secondary"
    : s === "rejected" || s === "disabled" || s === "archived" ? "destructive"
    : "outline";
  return (
    <Badge variant={variant} className="text-[10px] capitalize shrink-0">
      {state?.replace(/_/g, " ")}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// SDK Scaffold card — select template + enter name, POST scaffold
// ---------------------------------------------------------------------------

function SdkScaffoldCard({
  templates,
  loading,
  onScaffold,
}: {
  templates: SdkTemplate[];
  loading: boolean;
  onScaffold: (r: ScaffoldResult) => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Pick the first template by default once loaded.
  useEffect(() => {
    if (!templateId && templates[0]) setTemplateId(templates[0].id);
  }, [templates, templateId]);

  // Auto-derive a slug from the name when the user types.
  const slug = useMemo(() => {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  }, [name]);

  const submit = async () => {
    if (!templateId || !name.trim() || !slug) {
      toast({
        title: "Missing fields",
        description: "Template and project name are required.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/programs/sdk/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: templateId, slug, name: name.trim() }),
      });
      const j = (await res.json()) as { ok?: boolean; data?: ScaffoldResult; error?: { message?: string } };
      if (j.ok && j.data) {
        toast({
          title: "Project scaffolded",
          description: `${j.data.fileCount} files generated · slug: ${j.data.manifestSlug}`,
        });
        onScaffold(j.data);
        setName("");
      } else {
        toast({
          title: "Scaffold failed",
          description: j.error?.message ?? "Server rejected the scaffold request",
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

  const selectedTemplate = templates.find((t) => t.id === templateId);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          SDK Scaffold
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{templates.length} templates</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : templates.length === 0 ? (
          <EmptyState icon={<Terminal className="h-8 w-8" />} message="No SDK templates registered." />
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger><SelectValue placeholder="Select template" /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedTemplate?.description && (
                <p className="text-[10px] text-muted-foreground">{selectedTemplate.description}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sdk-name">Project Name</Label>
              <Input
                id="sdk-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Health Program"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sdk-slug">Slug (auto-derived)</Label>
              <Input
                id="sdk-slug"
                value={slug}
                readOnly
                placeholder="my-health-program"
                className="font-mono text-xs"
              />
            </div>

            <Button
              onClick={submit}
              disabled={submitting || !templateId || !name.trim()}
              className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90"
            >
              {submitting ? (
                <><RefreshCw className="h-4 w-4 mr-1 animate-spin" /> Scaffolding…</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-1" /> Scaffold</>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API Explorer card — list endpoints with method + path
// ---------------------------------------------------------------------------

function ApiExplorerCard({ endpoints, loading }: { endpoints: ApiEndpoint[]; loading: boolean }) {
  const methodColor = (m: string): string => {
    const upper = m?.toUpperCase();
    switch (upper) {
      case "GET": return "bg-emerald-500/15 text-emerald-600 border-emerald-600/30";
      case "POST": return "bg-blue-500/15 text-blue-600 border-blue-600/30";
      case "PUT":
      case "PATCH": return "bg-amber-500/15 text-amber-600 border-amber-600/30";
      case "DELETE": return "bg-rose-500/15 text-rose-600 border-rose-600/30";
      default: return "bg-muted text-muted-foreground";
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileCode className="h-4 w-4 text-muted-foreground" />
          API Explorer
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{endpoints.length} endpoints</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={4} />
        ) : endpoints.length === 0 ? (
          <EmptyState icon={<FileCode className="h-8 w-8" />} message="No API endpoints catalogued." />
        ) : (
          <div className="space-y-1 max-h-[28rem] overflow-y-auto eks-scroll pr-1">
            {endpoints.map((e) => (
              <div
                key={e.id}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 hover:bg-accent/30 transition-colors"
              >
                <span className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[9px] font-bold border ${methodColor(e.method)}`}>
                  {e.method?.toUpperCase() ?? "?"}
                </span>
                <code className="text-[11px] font-mono truncate flex-1" title={e.path}>
                  {e.path}
                </code>
                {e.authRequired && (
                  <ShieldCheck className="h-3 w-3 text-muted-foreground shrink-0" aria-label="Auth required" />
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Simulator card — list scenarios with Run button
// ---------------------------------------------------------------------------

function SimulatorCard({
  scenarios,
  loading,
  running,
  onRun,
}: {
  scenarios: SimulatorScenario[];
  loading: boolean;
  running: Record<string, boolean>;
  onRun: (s: SimulatorScenario) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Play className="h-4 w-4 text-muted-foreground" />
          Simulator
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{scenarios.length} scenarios</Badge>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : scenarios.length === 0 ? (
          <EmptyState icon={<Play className="h-8 w-8" />} message="No simulation scenarios available." />
        ) : (
          <div className="space-y-1.5 max-h-[28rem] overflow-y-auto eks-scroll pr-1">
            {scenarios.map((s) => (
              <div
                key={s.id}
                className="rounded-lg border border-border/60 p-3"
              >
                <div className="flex items-start gap-2 mb-1.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
                    <Play className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{s.name}</p>
                    {s.description && (
                      <p className="text-[11px] text-muted-foreground line-clamp-2">{s.description}</p>
                    )}
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {s.entityCount} entities · {s.eventCount} events
                    </p>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={running[s.id]}
                    onClick={() => onRun(s)}
                  >
                    {running[s.id] ? (
                      <><RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Running…</>
                    ) : (
                      <><Play className="h-3 w-3 mr-1" /> Run</>
                    )}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Marketplace Performance card — install counts + ratings
// ---------------------------------------------------------------------------

function MarketplacePerformanceCard({
  listings,
  stats,
  loading,
}: {
  listings: MarketplaceListing[];
  stats: MarketplaceStats;
  loading: boolean;
}) {
  const top = useMemo(() => {
    return [...listings].sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0)).slice(0, 6);
  }, [listings]);

  const maxInstalls = useMemo(() => {
    return Math.max(1, ...top.map((l) => l.installCount ?? 0));
  }, [top]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Trophy className="h-4 w-4 text-muted-foreground" />
          Marketplace Performance
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">{stats.total ?? listings.length} listings</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {loading && listings.length === 0 ? (
          <ListSkeleton rows={3} />
        ) : listings.length === 0 ? (
          <EmptyState icon={<Trophy className="h-8 w-8" />} message="No marketplace listings yet. Publish a program to appear here." />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <MetricTile label="Total Installs" value={stats.totalInstalls ?? listings.reduce((s, l) => s + (l.installCount ?? 0), 0)} icon={<TrendingUp className="h-3 w-3" />} />
              <MetricTile label="Active Installs" value={stats.activeInstalls ?? listings.reduce((s, l) => s + (l.activeInstallCount ?? 0), 0)} icon={<Activity />} />
            </div>
            <Separator />
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Top Listings</p>
            <div className="space-y-2 max-h-64 overflow-y-auto eks-scroll pr-1">
              {top.map((l) => (
                <div key={l.id} className="rounded-md border border-border/60 p-2.5">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-xs font-medium truncate">{l.name}</p>
                    {typeof l.rating === "number" && l.rating > 0 && (
                      <Badge variant="outline" className="text-[9px] shrink-0">
                        <Trophy className="h-2.5 w-2.5 mr-0.5" />
                        {l.rating.toFixed(1)}★
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-[var(--brand)] rounded-full"
                        style={{ width: `${Math.round(((l.installCount ?? 0) / maxInstalls) * 100)}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                      {l.installCount ?? 0} installs
                    </span>
                  </div>
                  {(l.developerName || l.version) && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {l.developerName ? `by ${l.developerName}` : ""}
                      {l.version ? ` · v${l.version}` : ""}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <Button asChild size="sm" variant="ghost" className="w-full h-7 text-xs">
              <Link href="/marketplace">
                Browse Marketplace <ExternalLink className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Samples card — bonus: read-only list of sample programs
// ---------------------------------------------------------------------------

interface SampleProgram {
  id: string;
  slug: string;
  name: string;
  category?: string;
  difficulty?: string;
  features?: string[];
  estimatedSetupMinutes?: number;
}

function SamplesCard({ loading }: { loading: boolean }) {
  const [samples, setSamples] = useState<SampleProgram[]>([]);
  const [innerLoading, setInnerLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/developer/samples", { cache: "no-store" });
        const j = (await res.json()) as { ok?: boolean; data?: SampleProgram[] | { samples?: SampleProgram[] }; error?: { message?: string } };
        if (!j?.ok) { if (!cancelled) setSamples([]); return; }
        const data = j.data;
        const arr = Array.isArray(data) ? data : (data as { samples?: SampleProgram[] })?.samples ?? [];
        if (!cancelled) setSamples(arr);
      } catch {
        if (!cancelled) setSamples([]);
      } finally {
        if (!cancelled) setInnerLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isLoading = loading && innerLoading;
  const difficultyVariant = (d?: string): "default" | "secondary" | "destructive" | "outline" => {
    const s = d?.toLowerCase();
    if (s === "beginner") return "default";
    if (s === "intermediate") return "secondary";
    if (s === "advanced") return "destructive";
    return "outline";
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Code2 className="h-4 w-4 text-muted-foreground" />
          Sample Programs
        </CardTitle>
        <Badge variant="outline" className="text-[10px]">{samples.length} samples</Badge>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <ListSkeleton rows={3} />
        ) : samples.length === 0 ? (
          <EmptyState icon={<Code2 className="h-8 w-8" />} message="No sample programs available." />
        ) : (
          <div className="space-y-1.5 max-h-[28rem] overflow-y-auto eks-scroll pr-1">
            {samples.map((s) => (
              <div key={s.id} className="rounded-lg border border-border/60 p-3">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  {s.difficulty && (
                    <Badge variant={difficultyVariant(s.difficulty)} className="text-[9px] capitalize shrink-0">
                      {s.difficulty}
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {s.category ? `${s.category}` : ""}
                  {s.estimatedSetupMinutes ? ` · ~${s.estimatedSetupMinutes}m setup` : ""}
                </p>
                {s.features && s.features.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {s.features.slice(0, 4).map((f) => (
                      <Badge key={f} variant="outline" className="text-[9px] py-0">{f}</Badge>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground/80 font-mono truncate mt-1" title={s.slug}>
                  {s.slug}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Certify result dialog — shows pass/fail/warn + per-rule checks
// ---------------------------------------------------------------------------

function CertifyResultDialog({
  open,
  onOpenChange,
  data,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  data: { program: ProgramSummary; result: CertifyResult } | null;
}) {
  if (!data) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" />
      </Dialog>
    );
  }
  const { program, result } = data;
  const passed = result.status === "passed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {passed ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            )}
            Certification Result — {program.name}
          </DialogTitle>
          <DialogDescription>
            Run <code className="font-mono text-[10px]">{result.runId}</code> · status{" "}
            <span className={`font-semibold ${passed ? "text-emerald-600" : "text-amber-600"}`}>
              {result.status}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-2 py-1">
          <div className="rounded-md border border-emerald-600/30 bg-emerald-500/5 p-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Passed</p>
            <p className="text-xl font-bold text-emerald-600">{result.passed}</p>
          </div>
          <div className="rounded-md border border-rose-600/30 bg-rose-500/5 p-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-rose-700 dark:text-rose-400">Failed</p>
            <p className="text-xl font-bold text-rose-600">{result.failed}</p>
          </div>
          <div className="rounded-md border border-amber-600/30 bg-amber-500/5 p-2 text-center">
            <p className="text-[10px] uppercase tracking-wide text-amber-700 dark:text-amber-400">Warned</p>
            <p className="text-xl font-bold text-amber-600">{result.warned}</p>
          </div>
        </div>

        {result.checks.length > 0 && (
          <div className="space-y-1 max-h-64 overflow-y-auto eks-scroll pr-1 mt-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Checks</p>
            {result.checks.map((c, idx) => (
              <div key={`${c.rule}-${idx}`} className="flex items-start gap-2 rounded-md border border-border/60 p-2">
                {c.result === "pass" ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />
                ) : c.result === "fail" ? (
                  <XCircle className="h-3.5 w-3.5 text-rose-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium font-mono truncate" title={c.rule}>{c.rule}</p>
                  {c.message && (
                    <p className="text-[10px] text-muted-foreground">{c.message}</p>
                  )}
                </div>
                {c.category && (
                  <Badge variant="outline" className="text-[9px] capitalize shrink-0">{c.category}</Badge>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Scaffold result dialog — shows generated file tree
// ---------------------------------------------------------------------------

function ScaffoldResultDialog({
  open,
  onOpenChange,
  result,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  result: ScaffoldResult | null;
}) {
  if (!result) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode className="h-4 w-4" />
            Scaffolded Project — {result.manifestSlug}
          </DialogTitle>
          <DialogDescription>
            Generated {result.fileCount} files. Use the SDK CLI to push the manifest to the platform.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-80 overflow-y-auto eks-scroll pr-1 space-y-1">
          {result.files.map((f, idx) => (
            <div key={`${f.path}-${idx}`} className="rounded-md border border-border/60 p-2">
              <p className="text-[11px] font-mono font-medium truncate flex items-center gap-1" title={f.path}>
                <FileCode className="h-3 w-3 text-muted-foreground shrink-0" />
                {f.path}
              </p>
              {f.contentPreview && (
                <pre className="text-[10px] text-muted-foreground font-mono mt-1 line-clamp-3 whitespace-pre-wrap break-all">
                  {f.contentPreview}
                  {f.contentPreview.length >= 200 ? "…" : ""}
                </pre>
              )}
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Simulation result dialog — shows events fired / duration / errors
// ---------------------------------------------------------------------------

function SimulationResultDialog({
  open,
  onOpenChange,
  result,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  result: SimulationResult | null;
}) {
  if (!result) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md" />
      </Dialog>
    );
  }

  const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4" />
            Simulation Result
          </DialogTitle>
          <DialogDescription>
            Run <code className="font-mono text-[10px]">{result.simulationId}</code>
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-1">
          <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Events Fired</p>
            <p className="text-xl font-bold">{result.eventsFired}</p>
          </div>
          <div className="rounded-md border border-border/60 bg-muted/30 p-2.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Duration</p>
            <p className="text-xl font-bold">{result.durationMs}<span className="text-xs font-normal text-muted-foreground">ms</span></p>
          </div>
          <div className={`rounded-md border p-2.5 col-span-2 ${errorCount > 0 ? "border-rose-600/30 bg-rose-500/5" : "border-emerald-600/30 bg-emerald-500/5"}`}>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              {errorCount > 0 ? <XCircle className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
              Errors
            </p>
            <p className={`text-xl font-bold ${errorCount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
              {errorCount}
            </p>
          </div>
        </div>

        {result.stateSnapshot !== undefined && (
          <details className="rounded-md border border-border/60 p-2">
            <summary className="text-[11px] font-medium cursor-pointer select-none">State Snapshot</summary>
            <pre className="text-[10px] text-muted-foreground font-mono mt-1 max-h-48 overflow-y-auto eks-scroll whitespace-pre-wrap break-all">
              {JSON.stringify(result.stateSnapshot, null, 2)}
            </pre>
          </details>
        )}

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

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="text-muted-foreground/60 mb-2">{icon}</div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
