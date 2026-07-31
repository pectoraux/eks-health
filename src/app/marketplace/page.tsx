"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, Search, Store, Star, Zap, ArrowRight, Activity, Trophy, ShieldCheck, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface Listing {
  id: string; name: string; tagline: string; category: string;
  bodySystems: string[]; healthGoals: string[];
  developerName: string; pricing: { type: string; price?: number };
  supportedCountries: string[]; installCount: number; version: string;
}

export default function MarketplacePage() {
  const router = useRouter();
  const [listings, setListings] = useState<Listing[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    fetch("/api/marketplace/listings", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d.ok) setListings(d.data.listings ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = listings.filter(l => {
    if (filter !== "all" && l.category !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return l.name.toLowerCase().includes(q) || l.tagline.toLowerCase().includes(q) ||
        l.healthGoals.some(g => g.toLowerCase().includes(q));
    }
    return true;
  });

  const categories = [...new Set(listings.map(l => l.category))];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]">
              <HeartPulse className="h-4 w-4" />
            </div>
            <span className="font-bold text-sm">Eks-Health</span>
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => router.push("/sign-in")}>Sign In</Button>
            <Button size="sm" onClick={() => router.push("/sign-up")} className="bg-[var(--brand)] text-[var(--brand-foreground)]">Get Started</Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight mb-2">Health Solutions Marketplace</h1>
          <p className="text-muted-foreground">Discover Programs based on health outcomes, not downloads. AI-matched to your goals.</p>
        </div>

        <div className="flex flex-wrap gap-3 mb-6">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search: 'lose weight', 'blood pressure', 'sleep'..."
            className="max-w-md"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={filter === "all" ? "default" : "outline"} onClick={() => setFilter("all")}>All</Button>
            {categories.map(c => (
              <Button key={c} size="sm" variant={filter === c ? "default" : "outline"} onClick={() => setFilter(c)}
                className={filter === c ? "bg-[var(--brand)] text-[var(--brand-foreground)]" : ""}>
                {c.replace(/_/g, " ")}
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12"><div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin mx-auto mb-3" /><p className="text-sm text-muted-foreground">Loading programs...</p></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12"><Store className="h-12 w-12 text-muted-foreground mx-auto mb-3" /><p className="text-sm text-muted-foreground">No programs found. Try a different search.</p></div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(l => (
              <Card key={l.id} className="hover:border-[var(--brand)]/40 transition-colors cursor-pointer" onClick={() => router.push(`/programs/${l.id}`)}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-sm truncate">{l.name}</h3>
                      <p className="text-xs text-muted-foreground truncate">{l.tagline}</p>
                    </div>
                    <Badge variant="outline" className="text-[10px] ml-2 shrink-0">{l.pricing.type === "free" ? "Free" : l.pricing.price ? `$${l.pricing.price}` : l.pricing.type}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1 mb-3">
                    {l.healthGoals.slice(0, 3).map(g => <Badge key={g} variant="secondary" className="text-[9px]">{g}</Badge>)}
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{l.developerName}</span>
                    <span>{l.installCount} installs</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
