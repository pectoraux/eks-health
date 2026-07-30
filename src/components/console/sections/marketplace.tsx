"use client";

import { Store, Search, Star } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, EmptyState } from "../primitives";
import { Badge } from "@/components/ui/badge";
import type { PlatformSnapshot } from "@/hooks/use-platform";

interface Listing {
  id: string; programId: string; name: string; slug: string;
  category: string; status: string; pricingModel: string;
  rating?: number; reviewCount?: number;
}

export function MarketplaceSection({ data }: { data: PlatformSnapshot }) {
  const marketplace = (data.programs as { marketplace?: { listings?: Listing[]; categories?: { id: string; label: string }[]; stats?: { total?: number; published?: number; avgRating?: number } } }).marketplace ?? {};
  const listings = marketplace.listings ?? [];
  const categories = marketplace.categories ?? [];
  const stats = marketplace.stats ?? {};

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Marketplace"
        subtitle="Program discovery infrastructure: categories, pricing models, ratings, reviews, evidence references. No marketplace UI yet — only the data layer that future marketplace pages will consume."
        icon={<Store className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Listings" value={stats.total ?? listings.length} accent />
        <StatCard label="Published" value={stats.published ?? listings.filter((l) => l.status === "published").length} />
        <StatCard label="Categories" value={categories.length} />
        <StatCard label="Avg Rating" value={stats.avgRating ? stats.avgRating.toFixed(1) : "—"} />
      </div>

      <Panel title="Discovery Categories">
        <p className="text-xs text-muted-foreground mb-2">Marketplace categories are discovery labels — NOT platform business logic. Programs self-categorize.</p>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <Badge key={c.id} variant="outline" className="text-xs font-mono capitalize">{c.label}</Badge>
          ))}
        </div>
      </Panel>

      <Panel title="Listings">
        {listings.length === 0 ? <EmptyState message="No listings yet. Certify and publish a program to create one." /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {listings.map((l) => (
              <div key={l.id} className="rounded-lg border border-border/60 p-3 hover:border-[var(--brand)]/40 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{l.name}</p>
                    <Mono className="text-muted-foreground text-[10px]">{l.slug}</Mono>
                  </div>
                  {l.rating && (
                    <div className="flex items-center gap-0.5 text-xs">
                      <Star className="h-3 w-3 fill-[var(--brand)] text-[var(--brand)]" />
                      <span className="font-medium">{l.rating.toFixed(1)}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <Badge variant="outline" className="text-[10px] capitalize">{l.category}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{l.pricingModel}</Badge>
                  <Badge variant={l.status === "published" ? "default" : "secondary"} className="text-[10px]">{l.status}</Badge>
                </div>
                {l.reviewCount !== undefined && l.reviewCount > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-1.5">{l.reviewCount} reviews</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
