"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, LogOut, User, Shield, Bell, Smartphone, Package, Building2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Session { email: string; displayName: string; activePersona: string; personas: string[]; isDemo: boolean; isAdmin: boolean; accountId: string; }

export default function SettingsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then(r => r.json())
      .then(d => { if (d.ok && d.data) setSession(d.data); else router.push("/sign-in"); });
  }, [router]);

  if (!session) return <div className="min-h-screen flex items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin" /></div>;

  const signOut = async () => { await fetch("/api/auth/sign-out", { method: "POST" }); router.push("/"); };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]"><HeartPulse className="h-4 w-4" /></div>
            <span className="font-bold text-sm">Settings</span>
          </button>
          <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-3.5 w-3.5" /></Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

        {/* Profile */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><User className="h-4 w-4" /> Profile</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div><Label>Display Name</Label><Input defaultValue={session.displayName} /></div>
            <div><Label>Email</Label><Input defaultValue={session.email} disabled /></div>
            <div>
              <Label>Active Role</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {session.personas.map(p => <Badge key={p} variant={p === session.activePersona ? "default" : "outline"} className="text-xs">{p.replace(/_/g, " ")}</Badge>)}
              </div>
            </div>
            <Button size="sm">Save Profile</Button>
          </CardContent>
        </Card>

        {/* Privacy & Consent */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="h-4 w-4" /> Privacy & Consent</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span>Field-level consent management</span><Badge variant="outline">Active</Badge></div>
            <div className="flex items-center justify-between"><span>Purpose-based access control</span><Badge variant="outline">Enforced</Badge></div>
            <div className="flex items-center justify-between"><span>Data residency</span><Badge variant="outline">Africa/Accra</Badge></div>
            <p className="text-xs text-muted-foreground mt-2">Your data is encrypted, consent-gated, and fully auditable. You can revoke access at any time.</p>
          </CardContent>
        </Card>

        {/* Security */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> Security</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span>Multi-Factor Authentication</span><Badge variant="secondary">Disabled</Badge></div>
            <div className="flex items-center justify-between"><span>Session timeout</span><Badge variant="outline">7 days</Badge></div>
            <div className="flex items-center justify-between"><span>Password</span><Button variant="outline" size="sm">Change</Button></div>
            <Button variant="outline" size="sm" className="mt-2">Enable MFA</Button>
          </CardContent>
        </Card>

        {/* Installed Programs */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> Installed Programs</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">Manage your installed health programs and their permissions.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => router.push("/marketplace")}>Browse Marketplace</Button>
          </CardContent>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" /> Notifications</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span>Mission reminders</span><Badge variant="default">On</Badge></div>
            <div className="flex items-center justify-between"><span>Competition updates</span><Badge variant="default">On</Badge></div>
            <div className="flex items-center justify-between"><span>Reward notifications</span><Badge variant="default">On</Badge></div>
            <div className="flex items-center justify-between"><span>Research participation</span><Badge variant="secondary">Off</Badge></div>
          </CardContent>
        </Card>

        {/* Devices */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Smartphone className="h-4 w-4" /> Devices</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">No devices connected. Connect a wearable or measurement device to sync data automatically.</p>
            <Button variant="outline" size="sm" className="mt-2">Connect Device</Button>
          </CardContent>
        </Card>

        {/* Organizations */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" /> Organizations</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">You are not a member of any organization.</p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
