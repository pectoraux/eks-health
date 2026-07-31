"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, ArrowRight, AlertCircle, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const DEMO_ACCOUNTS = [
  { email: "ama@eks.health", label: "Participant", icon: "🏃", desc: "Track health, compete, earn rewards" },
  { email: "clinic@eks.health", label: "Health Technician", icon: "🩺", desc: "Verify measurements, build reputation" },
  { email: "kwame@eks.health", label: "Developer", icon: "💻", desc: "Build and publish health Programs" },
  { email: "research@eks.health", label: "Researcher", icon: "🔬", desc: "Analyze populations, publish findings" },
  { email: "admin@eks.health", label: "Org Admin", icon: "🏢", desc: "Manage population wellness" },
  { email: "ekontetevi@gmail.com", label: "Platform Admin", icon: "⚙️", desc: "Full platform administration" },
];

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function signIn(emailVal?: string, passVal?: string) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailVal ?? email, password: passVal ?? password }),
      });
      const data = await res.json();
      if (data.ok) {
        router.push("/dashboard");
      } else {
        setError(data.error?.message ?? "Sign in failed");
      }
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }

  function quickLogin(demoEmail: string) {
    setEmail(demoEmail);
    setPassword("DemoPass123!");
    signIn(demoEmail, demoEmail === "ekontetevi@gmail.com" ? "Payswap123456" : "DemoPass123!");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <button onClick={() => router.push("/")} className="inline-flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand)] text-[var(--brand-foreground)]">
              <HeartPulse className="h-5 w-5" />
            </div>
            <span className="font-bold text-xl">Eks-Health</span>
          </button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-center">Sign In</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" onKeyDown={(e) => e.key === "Enter" && signIn()} />
            </div>
            <Button className="w-full bg-[var(--brand)] text-[var(--brand-foreground)] hover:opacity-90" onClick={() => signIn()} disabled={loading}>
              {loading ? "Signing in..." : "Sign In"} {!loading && <ArrowRight className="h-4 w-4 ml-1.5" />}
            </Button>
            <div className="text-center text-xs text-muted-foreground">
              <button onClick={() => router.push("/sign-up")} className="hover:text-foreground">Don't have an account? Join the waitlist</button>
            </div>
          </CardContent>
        </Card>

        {/* Quick Demo Login */}
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-4 w-4 text-[var(--brand)]" />
            <span className="text-sm font-medium">Quick Demo Login</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.email}
                onClick={() => quickLogin(acc.email)}
                disabled={loading}
                className="flex items-start gap-2 rounded-lg border border-border/60 p-2.5 text-left hover:border-[var(--brand)]/40 hover:bg-accent/30 transition-colors disabled:opacity-50"
              >
                <span className="text-lg">{acc.icon}</span>
                <div className="min-w-0">
                  <p className="text-xs font-medium">{acc.label}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{acc.desc}</p>
                </div>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2 text-center">
            Demo password: DemoPass123! (Admin: Payswap123456)
          </p>
        </div>
      </div>
    </div>
  );
}
