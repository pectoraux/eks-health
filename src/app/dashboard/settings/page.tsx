"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  HeartPulse, LogOut, User, Shield, Bell, Smartphone, Package,
  Building2, Lock, Check, RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";

interface Session {
  email: string;
  displayName: string;
  activePersona: string;
  personas: string[];
  isDemo: boolean;
  isAdmin: boolean;
  accountId: string;
}

export default function SettingsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [passwordDialog, setPasswordDialog] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [changingPw, setChangingPw] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [togglingMfa, setTogglingMfa] = useState(false);
  const [devices, setDevices] = useState<{ id: string; type: string; label: string; deviceModel?: string; verified: boolean }[]>([]);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.data) {
          setSession(d.data);
          setDisplayName(d.data.displayName);
          // Fetch account details for MFA status
          fetch(`/api/identity/accounts/${d.data.accountId}`)
            .then(r => r.json())
            .then(acc => {
              if (acc.ok) setMfaEnabled(acc.data.mfaEnabled);
            })
            .catch(() => {});
          // Fetch devices
          fetch("/api/technicians/devices")
            .then(r => r.json())
            .then(dev => {
              if (dev.ok) setDevices(dev.data.devices ?? []);
            })
            .catch(() => {});
        } else {
          router.push("/sign-in");
        }
      });
  }, [router]);

  if (!session) return <div className="min-h-screen flex items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin" /></div>;

  const signOut = async () => {
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.push("/");
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/identity/accounts/${session.accountId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Profile saved", description: "Your display name has been updated." });
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not save", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  const changePassword = async () => {
    if (newPw !== confirmPw) {
      toast({ title: "Mismatch", description: "New passwords don't match", variant: "destructive" });
      return;
    }
    if (newPw.length < 8) {
      toast({ title: "Too short", description: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    setChangingPw(true);
    try {
      const res = await fetch(`/api/identity/accounts/${session.accountId}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (data.ok) {
        toast({ title: "Password changed", description: "Your password has been updated." });
        setPasswordDialog(false);
        setCurrentPw(""); setNewPw(""); setConfirmPw("");
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not change password", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setChangingPw(false);
    }
  };

  const toggleMfa = async (enabled: boolean) => {
    setTogglingMfa(true);
    try {
      const res = await fetch(`/api/identity/accounts/${session.accountId}/mfa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (data.ok) {
        setMfaEnabled(data.data.mfaEnabled);
        toast({ title: enabled ? "MFA enabled" : "MFA disabled", description: enabled ? "Multi-factor authentication is now active." : "MFA has been turned off." });
      } else {
        toast({ title: "Failed", description: data.error?.message ?? "Could not toggle MFA", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error", variant: "destructive" });
    } finally {
      setTogglingMfa(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]"><HeartPulse className="h-4 w-4" /></div>
            <span className="font-bold text-sm">Settings</span>
          </button>
          <Button variant="ghost" size="sm" onClick={signOut}><LogOut className="h-3.5 w-3.5" /></Button>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

        {/* Profile */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><User className="h-4 w-4" /> Profile</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="name">Display Name</Label>
              <Input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <Label>Email</Label>
              <Input defaultValue={session.email} disabled />
            </div>
            <div>
              <Label>Active Role</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {session.personas.map(p => <Badge key={p} variant={p === session.activePersona ? "default" : "outline"} className="text-xs">{p.replace(/_/g, " ")}</Badge>)}
              </div>
            </div>
            <Button size="sm" onClick={saveProfile} disabled={savingProfile || displayName === session.displayName}>
              {savingProfile ? "Saving..." : "Save Profile"}
            </Button>
          </CardContent>
        </Card>

        {/* Security */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Lock className="h-4 w-4" /> Security</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <span>Multi-Factor Authentication</span>
                <p className="text-xs text-muted-foreground">Add an extra layer of security to your account.</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={mfaEnabled ? "default" : "secondary"}>{mfaEnabled ? "Enabled" : "Disabled"}</Badge>
                <Switch checked={mfaEnabled} onCheckedChange={toggleMfa} disabled={togglingMfa} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span>Session timeout</span>
              <Badge variant="outline">7 days</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>Password</span>
              <Button variant="outline" size="sm" onClick={() => setPasswordDialog(true)}>Change</Button>
            </div>
          </CardContent>
        </Card>

        {/* Devices */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Smartphone className="h-4 w-4" /> Devices</CardTitle></CardHeader>
          <CardContent>
            {devices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No devices connected. Connect a wearable or measurement device to sync data automatically.</p>
            ) : (
              <div className="space-y-2">
                {devices.map(d => (
                  <div key={d.id} className="flex items-center justify-between rounded-lg border border-border/60 p-2.5 text-sm">
                    <div className="flex items-center gap-2">
                      <Smartphone className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <span className="font-medium">{d.label}</span>
                        {d.deviceModel && <span className="text-muted-foreground ml-2">{d.deviceModel}</span>}
                      </div>
                    </div>
                    <Badge variant={d.verified ? "default" : "secondary"} className="text-[10px]">{d.verified ? "Verified" : "Pending"}</Badge>
                  </div>
                ))}
              </div>
            )}
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

        {/* Organizations */}
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Building2 className="h-4 w-4" /> Organizations</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">You are not a member of any organization.</p>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="max-w-3xl mx-auto px-4 py-4 text-xs text-muted-foreground text-center">
          Eks-Health — Preventive Health Operating System · prototype
        </div>
      </footer>

      {/* Change Password Dialog */}
      <Dialog open={passwordDialog} onOpenChange={setPasswordDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="currentPw">Current Password</Label>
              <Input id="currentPw" type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newPw">New Password</Label>
              <Input id="newPw" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirmPw">Confirm New Password</Label>
              <Input id="confirmPw" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
            </div>
            {newPw && newPw.length < 8 && (
              <p className="text-xs text-amber-600">Password must be at least 8 characters.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordDialog(false)}>Cancel</Button>
            <Button onClick={changePassword} disabled={changingPw || !currentPw || !newPw || !confirmPw}>
              {changingPw ? "Changing..." : "Change Password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
