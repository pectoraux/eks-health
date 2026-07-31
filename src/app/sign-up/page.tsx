"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, ArrowRight, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ROLES = [
  { value: "participant", label: "Participant", icon: "🏃", desc: "Track health & earn rewards" },
  { value: "health_technician", label: "Health Technician", icon: "🩺", desc: "Verify measurements" },
  { value: "developer", label: "Developer", icon: "💻", desc: "Build health Programs" },
  { value: "researcher", label: "Researcher", icon: "🔬", desc: "Conduct studies" },
  { value: "org_admin", label: "Organization", icon: "🏢", desc: "Manage populations" },
];

const COUNTRIES = ["Ghana", "Nigeria", "Kenya", "South Africa", "United States", "United Kingdom", "Other"];

export default function SignUpPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", country: "Ghana", reason: "", referral: "" });
  const [roles, setRoles] = useState<string[]>(["participant"]);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  function toggleRole(role: string) {
    setRoles((prev) => prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]);
  }

  async function submit() {
    if (!form.name || !form.email || !form.country) {
      setError("Name, email, and country are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, interestedRoles: roles }),
      });
      const data = await res.json();
      if (data.ok) {
        setSuccess(true);
      } else {
        setError(data.error?.message ?? "Registration failed");
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)] mx-auto mb-4">
              <Check className="h-8 w-8" />
            </div>
            <h2 className="text-xl font-bold mb-2">You're on the waitlist!</h2>
            <p className="text-sm text-muted-foreground mb-6">We'll notify you at <span className="font-medium text-foreground">{form.email}</span> when your account is approved.</p>
            <Button variant="outline" onClick={() => router.push("/sign-in")} className="w-full">Back to Sign In</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background py-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <button onClick={() => router.push("/")} className="inline-flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand)] text-[var(--brand-foreground)]">
              <HeartPulse className="h-5 w-5" />
            </div>
            <span className="font-bold text-xl">Eks-Health</span>
          </button>
        </div>

        <Card>
          <CardHeader><CardTitle className="text-center">Join the Waitlist</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />{error}
              </div>
            )}
            <div>
              <Label>Full Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" />
            </div>
            <div>
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@example.com" />
            </div>
            <div>
              <Label>Country</Label>
              <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
                {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <Label>I'm interested in...</Label>
              <div className="grid grid-cols-1 gap-1.5 mt-1">
                {ROLES.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => toggleRole(r.value)}
                    className={`flex items-center gap-2 rounded-md border p-2 text-left transition-colors ${roles.includes(r.value) ? "border-[var(--brand)] bg-[var(--brand-muted)]/30" : "border-border/60"}`}
                  >
                    <span className="text-lg">{r.icon}</span>
                    <div className="flex-1">
                      <p className="text-xs font-medium">{r.label}</p>
                      <p className="text-[10px] text-muted-foreground">{r.desc}</p>
                    </div>
                    {roles.includes(r.value) && <Check className="h-3.5 w-3.5 text-[var(--brand)]" />}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label>Why do you want to join? (optional)</Label>
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="I want to improve my health..." />
            </div>
            <div>
              <Label>Referral code (optional)</Label>
              <Input value={form.referral} onChange={(e) => setForm({ ...form, referral: e.target.value })} placeholder="Friend's email or code" />
            </div>
            <Button className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90" onClick={submit} disabled={loading}>
              {loading ? "Joining..." : "Join Waitlist"} {!loading && <ArrowRight className="h-4 w-4 ml-1.5" />}
            </Button>
            <div className="text-center text-xs text-muted-foreground">
              <button onClick={() => router.push("/sign-in")} className="hover:text-foreground">Already have an account? Sign in</button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
