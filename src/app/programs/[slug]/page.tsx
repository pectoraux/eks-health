"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import {
  HeartPulse, ArrowLeft, Star, ShieldCheck, Activity, Trophy, Zap,
  Check, Store, Download, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";

interface Listing {
  id: string;
  slug?: string;
  name: string;
  tagline: string;
  category: string;
  bodySystems: string[];
  healthGoals: string[];
  developerName: string;
  version: string;
  installCount: number;
  activeInstallCount: number;
  pricing: { type: string; price?: number; currency?: string; freeTierFeatures?: string[]; premiumTierFeatures?: string[] };
  supportedCountries: string[];
  publishedAt: string;
}

export default function ProgramDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = (params.slug || params.id) as string;
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/marketplace/listings", { cache: "no-store" }).then(r => r.json()),
      fetch("/api/auth/session", { cache: "no-store" }).then(r => r.json()),
    ]).then(([d, sess]) => {
      if (d.ok) {
        const listings = d.data.listings ?? [];
        const found = listings.find((l: Listing) =>
          l.id === id ||
          l.slug === id ||
          l.name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === id
        );
        setListing(found || null);
        if (!found) console.warn("Program not found. Searched for:", id, "in listings:", listings.map(l => ({ id: l.id, slug: l.slug, name: l.name })));
      }
      if (sess.ok && sess.data) setSignedIn(true);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [id]);

  const install = async () => {
    if (!listing) return;
    setInstalling(true);
    try {
      // Retry on failure (handles cold-start session races on serverless).
      let data: { ok: boolean; data?: { installCount: number }; error?: { message?: string } } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`/api/marketplace/listings/${listing.id}/install`, { method: "POST" });
        data = await res.json();
        if (data?.ok) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }
      if (data?.ok) {
        setInstalled(true);
        toast({ title: "Program installed!", description: `${listing.name} is now in your health programs.` });
        setListing({ ...listing, installCount: data.data!.installCount });
      } else {
        toast({ title: "Failed", description: data?.error?.message ?? "Could not install. Please try again.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setInstalling(false);
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin" /></div>;
  if (!listing) return <div className="min-h-screen flex flex-col items-center justify-center gap-3"><Store className="h-12 w-12 text-muted-foreground" /><p className="text-sm text-muted-foreground">Program not found.</p><Button variant="outline" onClick={() => router.push("/marketplace")}>Back to Marketplace</Button></div>;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]"><HeartPulse className="h-4 w-4" /></div>
            <span className="font-bold text-sm">Eks-Health</span>
          </button>
          <div className="flex items-center gap-2">
            {signedIn ? (
              <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard")}>Dashboard</Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={() => router.push("/sign-in")}>Sign In</Button>
                <Button size="sm" onClick={() => router.push("/sign-up")} className="bg-[var(--brand)] text-[var(--brand-foreground)]">Get Started</Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        <Button variant="ghost" size="sm" onClick={() => router.push("/marketplace")} className="mb-4"><ArrowLeft className="h-3.5 w-3.5 mr-1" />Back to Marketplace</Button>

        <div className="mb-8">
          <Badge variant="outline" className="mb-2 capitalize">{listing.category?.replace(/_/g, " ")}</Badge>
          <h1 className="text-3xl font-bold tracking-tight mb-2">{listing.name}</h1>
          <p className="text-lg text-muted-foreground">{listing.tagline}</p>
          <div className="flex flex-wrap items-center gap-4 mt-4 text-sm text-muted-foreground">
            <span>By {listing.developerName}</span>
            <span>v{listing.version}</span>
            <span>{listing.installCount} installs</span>
            <Badge variant={listing.pricing?.type === "free" ? "default" : "secondary"} className="text-xs">
              {listing.pricing?.type === "free" ? "Free" : listing.pricing?.price ? `$${listing.pricing.price}` : listing.pricing?.type}
            </Badge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader><CardTitle className="text-base">Health Goals</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {listing.healthGoals?.map((g) => <Badge key={g} variant="secondary" className="text-xs">{g}</Badge>)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Body Systems</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {listing.bodySystems?.map((b) => <Badge key={b} variant="outline" className="text-xs capitalize">{b}</Badge>)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Pricing Details</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Type</span>
                  <Badge variant="outline" className="capitalize">{listing.pricing?.type}</Badge>
                </div>
                {listing.pricing?.freeTierFeatures && listing.pricing.freeTierFeatures.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Free tier includes:</p>
                    <ul className="space-y-1">
                      {listing.pricing.freeTierFeatures.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs"><Check className="h-3 w-3 text-[var(--brand)]" />{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {listing.pricing?.premiumTierFeatures && listing.pricing.premiumTierFeatures.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Premium tier:</p>
                    <ul className="space-y-1">
                      {listing.pricing.premiumTierFeatures.map((f, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs"><Zap className="h-3 w-3 text-[var(--brand)]" />{f}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Supported Countries</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {listing.supportedCountries?.map((c) => <Badge key={c} variant="outline" className="text-xs">{c}</Badge>)}
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-4">
            <Card className="sticky top-20">
              <CardContent className="p-5">
                <h3 className="font-semibold text-sm mb-3">Get Started</h3>
                {installed ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-[var(--brand)]">
                      <Check className="h-4 w-4" />
                      <span>Installed successfully!</span>
                    </div>
                    <Button className="w-full bg-[var(--brand)] text-[var(--brand-foreground)]" onClick={() => router.push("/dashboard")}>
                      Go to Dashboard
                    </Button>
                  </div>
                ) : signedIn ? (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">Install this program to add it to your health journey.</p>
                    <Button
                      className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] mb-2"
                      onClick={install}
                      disabled={installing}
                    >
                      {installing ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />Installing...</> : <><Download className="h-3.5 w-3.5 mr-1" />Install Program</>}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">Sign in to install this program and start your health journey.</p>
                    <Button className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] mb-2" onClick={() => router.push("/sign-in")}>
                      Sign In to Install
                    </Button>
                    <Button variant="outline" className="w-full" onClick={() => router.push("/sign-up")}>Join Waitlist</Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="max-w-4xl mx-auto px-4 py-4 text-xs text-muted-foreground text-center">
          Eks-Health — Preventive Health Operating System · prototype
        </div>
      </footer>
    </div>
  );
}
