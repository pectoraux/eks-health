"use client";

import { useState } from "react";
import { Store, Search, Star, TrendingUp, ShieldCheck, Zap, Coins, Eye, BarChart3 } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, StateBadge } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function MarketplaceSection({ data }: { data: PlatformSnapshot }) {
  const m = (data.marketplace as Record<string, unknown>) ?? {};
  const listings = (m.listings as Array<{ id: string; name: string; tagline: string; category: string; bodySystems: string[]; healthGoals: string[]; developerName: string; pricing: { type: string; price?: number }; supportedCountries: string[]; installCount: number; activeInstallCount: number; version: string; publishedAt?: string }>) ?? [];
  const stats = (m.listingStats as { total?: number; published?: number; totalInstalls?: number; activeInstalls?: number }) ?? {};
  const outcomes = (m.outcomes as { stats?: { total?: number; avgImprovement?: number; avgCompletion?: number }; top?: Array<{ averageImprovement: number; completionRate: number; populationSize: number }> }) ?? {};
  const evidence = (m.evidence as { totalPages?: number; byConfidence?: Record<string, number>; avgQuality?: number }) ?? {};
  const reviews = (m.reviews as { total?: number; avgRating?: number; verifiedRate?: number }) ?? {};
  const collections = (m.collections as { list?: Array<{ id: string; name: string; description: string; category: string; listingCount: number }> })?.list ?? [];
  const monetization = (m.monetization as { totalIntents?: number; confirmed?: number; activeLicenses?: number }) ?? {};
  const revenue = (m.revenue as { totalProcessed?: number; byRecipientType?: Record<string, number> }) ?? {};
  const analytics = (m.analytics as { totalListings?: number; totalInstalls?: number; totalRevenue?: number; avgRating?: number }) ?? {};
  const matching = (m.matching as { totalScores?: number; avgScore?: number }) ?? {};

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ listingId: string; name: string; score: number }> | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    if (!searchQuery.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/marketplace/search?q=${encodeURIComponent(searchQuery)}`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok && json.data) {
        setSearchResults(json.data.results);
      }
    } catch {
      toast.error("Search failed");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Health Marketplace"
        subtitle="The global marketplace for preventive health solutions. Users browse HEALTH SOLUTIONS, not apps. AI-powered search, evidence-aware comparison, outcome-based ranking. The marketplace optimizes for health outcomes, not downloads."
        icon={<Store className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Listings" value={stats.total ?? 0} hint={`${stats.published ?? 0} published`} accent />
        <StatCard label="Total Installs" value={stats.totalInstalls ?? 0} />
        <StatCard label="Avg Outcome" value={outcomes.stats?.avgImprovement ? `${outcomes.stats.avgImprovement.toFixed(1)}%` : "—"} hint="improvement" />
        <StatCard label="Evidence Pages" value={evidence.totalPages ?? 0} hint={`avg quality: ${evidence.avgQuality?.toFixed(0) ?? "—"}`} />
      </div>

      <Panel title="Solution Search (AI-powered)">
        <div className="flex gap-2">
          <Input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="Search: 'I want to lose weight' or 'reduce blood pressure'" onKeyDown={(e) => e.key === "Enter" && search()} />
          <Button onClick={search} disabled={busy}><Search className="h-4 w-4 mr-1.5" />Search</Button>
        </div>
        {searchResults && (
          <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto eks-scroll">
            {searchResults.length === 0 ? <p className="text-xs text-muted-foreground">No results — try a different query.</p> : searchResults.map((r) => (
              <div key={r.listingId} className="flex items-center justify-between text-xs rounded-md border border-border/40 p-2">
                <span className="font-medium">{r.name}</span>
                <Badge variant="outline" className="text-[10px]">relevance: {r.score}</Badge>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Health Solutions (Listings)">
        <div className="max-h-[28rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Solution</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Pricing</TableHead>
                <TableHead>Goals</TableHead>
                <TableHead>Installs</TableHead>
                <TableHead className="pr-4">Version</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listings.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm">{l.name}</div>
                    <p className="text-xs text-muted-foreground">{l.tagline}</p>
                  </TableCell>
                  <TableCell><Badge variant="outline" className="text-[10px] font-mono">{l.category}</Badge></TableCell>
                  <TableCell>
                    <span className="text-xs font-medium">{l.pricing.type === "free" ? "Free" : l.pricing.price !== undefined ? `${l.pricing.price}` : l.pricing.type}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-0.5">
                      {l.healthGoals.slice(0, 2).map((g) => <Mono key={g} className="text-[10px] text-muted-foreground">{g}</Mono>)}
                      {l.healthGoals.length > 2 && <Mono className="text-[10px] text-muted-foreground">+{l.healthGoals.length - 2}</Mono>}
                    </div>
                  </TableCell>
                  <TableCell><Mono className="text-xs">{l.activeInstallCount}/{l.installCount}</Mono></TableCell>
                  <TableCell className="pr-4"><Mono className="text-xs">v{l.version}</Mono></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Outcome Metrics">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><TrendingUp className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Avg Improvement</span></div>
              <p className="text-lg font-semibold mt-1">{outcomes.stats?.avgImprovement?.toFixed(1) ?? "—"}%</p>
            </div>
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Completion Rate</span></div>
              <p className="text-lg font-semibold mt-1">{outcomes.stats?.avgCompletion ? `${(outcomes.stats.avgCompletion * 100).toFixed(0)}%` : "—"}</p>
            </div>
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><Star className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Avg Rating</span></div>
              <p className="text-lg font-semibold mt-1">{reviews.avgRating?.toFixed(1) ?? "—"}</p>
            </div>
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Evidence Quality</span></div>
              <p className="text-lg font-semibold mt-1">{evidence.avgQuality?.toFixed(0) ?? "—"}/100</p>
            </div>
          </div>
        </Panel>

        <Panel title="Monetization & Revenue">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><Coins className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Purchase Intents</span></div>
              <p className="text-lg font-semibold mt-1">{monetization.totalIntents ?? 0}</p>
            </div>
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><Coins className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Active Licenses</span></div>
              <p className="text-lg font-semibold mt-1">{monetization.activeLicenses ?? 0}</p>
            </div>
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">AI Matches</span></div>
              <p className="text-lg font-semibold mt-1">{matching.totalScores ?? 0}</p>
            </div>
            <div className="rounded-md border border-border/40 p-2.5">
              <div className="flex items-center gap-1.5"><Eye className="h-3.5 w-3.5 text-[var(--brand)]" /><span className="font-medium">Avg Suitability</span></div>
              <p className="text-lg font-semibold mt-1">{matching.avgScore?.toFixed(0) ?? "—"}/100</p>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Curated Collections">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {collections.map((c) => (
            <div key={c.id} className="rounded-md border border-border/60 p-3">
              <p className="text-sm font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{c.description}</p>
              <div className="flex items-center gap-2 mt-1.5">
                <Badge variant="outline" className="text-[10px]">{c.category}</Badge>
                <span className="text-[10px] text-muted-foreground">{c.listingCount} programs</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Marketplace Philosophy">
        <div className="rounded-md border border-[var(--brand)]/30 bg-[var(--brand-muted)]/20 p-3">
          <div className="flex items-start gap-2">
            <Store className="h-4 w-4 text-[var(--brand)] mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-[var(--brand)]">Users browse HEALTH SOLUTIONS, not apps</p>
              <p className="text-xs text-muted-foreground mt-1">
                The marketplace optimizes for health outcomes, not downloads. AI-powered search understands
                "I want to lose weight" and recommends the most suitable Programs. Evidence-aware comparison
                shows peer-reviewed confidence levels. Outcome metrics auto-update from verified measurements.
                All payment execution remains delegated to the Payment Provider Interface — the marketplace
                never processes payments directly.
              </p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
