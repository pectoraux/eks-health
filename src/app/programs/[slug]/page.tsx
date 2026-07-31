"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { HeartPulse, ArrowLeft, Star, ShieldCheck, Activity, Trophy, Zap, Check, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ProgramDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params.id as string;
  const [listing, setListing] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/marketplace/listings", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          const found = (d.data.listings ?? []).find((l: any) => l.id === id);
          setListing(found || null);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="min-h-screen flex items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin" /></div>;
  if (!listing) return <div className="min-h-screen flex flex-col items-center justify-center gap-3"><Store className="h-12 w-12 text-muted-foreground" /><p className="text-sm text-muted-foreground">Program not found.</p><Button variant="outline" onClick={() => router.push("/marketplace")}>Back to Marketplace</Button></div>;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]"><HeartPulse className="h-4 w-4" /></div>
            <span className="font-bold text-sm">Eks-Health</span>
          </button>
          <Button variant="ghost" size="sm" onClick={() => router.push("/sign-in")}>Sign In</Button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
                  {listing.healthGoals?.map((g: string) => <Badge key={g} variant="secondary" className="text-xs">{g}</Badge>)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Body Systems</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {listing.bodySystems?.map((b: string) => <Badge key={b} variant="outline" className="text-xs capitalize">{b}</Badge>)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Supported Countries</CardTitle></CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {listing.supportedCountries?.map((c: string) => <Badge key={c} variant="outline" className="text-xs">{c}</Badge>)}
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-4">
            <Card className="sticky top-20">
              <CardContent className="p-5">
                <h3 className="font-semibold text-sm mb-3">Get Started</h3>
                <p className="text-xs text-muted-foreground mb-4">Sign in to install this program and start your health journey.</p>
                <Button className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] mb-2" onClick={() => router.push("/sign-in")}>
                  Install Program <ArrowLeft className="h-3.5 w-3.5 ml-1 rotate-180" />
                </Button>
                <Button variant="outline" className="w-full" onClick={() => router.push("/sign-up")}>Join Waitlist</Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
