"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  HeartPulse, LogOut, Activity, Trophy, Target, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Typed shapes for API responses
// ---------------------------------------------------------------------------

interface MeasurementEntry {
  id: string;
  value: number;
  unitSymbol: string;
  sourceLabel: string;
  verificationState: string;
  sourceType: string;
  collectedAt: string;
}

interface MissionEntry {
  id: string;
  title: string;
  type: string;
  category: string;
  state: string;
  difficulty: string;
  aiGenerated?: boolean;
  scheduledFor?: string;
  createdAt?: string;
}

interface CompetitionEntry {
  id: string;
  name: string;
  scope: string;
  state: string;
  currentParticipants: number;
  startsAt?: string;
  endsAt?: string;
  createdAt?: string;
}

interface TimelineEntry {
  id: string;
  type: "measurement" | "mission" | "competition";
  timestamp: string;
  title: string;
  description: string;
  source: string;
}

type FilterType = "all" | "measurement" | "mission" | "competition";

const TYPE_ICONS: Record<TimelineEntry["type"], React.ReactNode> = {
  measurement: <Activity className="h-3.5 w-3.5" />,
  mission: <Target className="h-3.5 w-3.5" />,
  competition: <Trophy className="h-3.5 w-3.5" />,
};

const FILTERS: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "measurement", label: "Measurements" },
  { value: "mission", label: "Missions" },
  { value: "competition", label: "Competitions" },
];

/** Pick the most representative timestamp, falling back to now if missing. */
function pickTimestamp(candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (c && typeof c === "string" && !Number.isNaN(Date.parse(c))) return c;
  }
  return new Date().toISOString();
}

export default function TimelinePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>("all");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [measRes, missionsRes, compsRes] = await Promise.all([
          fetch("/api/health/measurements?limit=20", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/missions/list", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/competitions/list", { cache: "no-store" }).then((r) => r.json()),
        ]);

        if (cancelled) return;

        const timeline: TimelineEntry[] = [];

        // Measurements — use collectedAt as the authoritative timestamp.
        if (measRes?.ok) {
          const recent: MeasurementEntry[] = measRes.data?.recent ?? [];
          for (const m of recent) {
            timeline.push({
              id: m.id,
              type: "measurement",
              timestamp: pickTimestamp([m.collectedAt]),
              title: `Measurement: ${m.value} ${m.unitSymbol}`,
              description: `Source: ${m.sourceLabel} · ${m.verificationState}`,
              source: m.sourceType,
            });
          }
        }

        // Missions — fetch real scheduledFor / createdAt timestamps instead of "now".
        if (missionsRes?.ok) {
          const missions: MissionEntry[] = missionsRes.data?.missions ?? [];
          for (const m of missions) {
            timeline.push({
              id: m.id,
              type: "mission",
              timestamp: pickTimestamp([m.scheduledFor, m.createdAt]),
              title: m.title,
              description: `${m.category} · ${m.state} · ${m.difficulty}${m.aiGenerated ? " · AI-generated" : ""}`,
              source: "mission_engine",
            });
          }
        }

        // Competitions — fetch real startsAt / createdAt timestamps.
        if (compsRes?.ok) {
          const comps: CompetitionEntry[] = compsRes.data?.competitions ?? [];
          for (const c of comps) {
            timeline.push({
              id: c.id,
              type: "competition",
              timestamp: pickTimestamp([c.startsAt, c.createdAt]),
              title: c.name,
              description: `${c.scope} · ${c.currentParticipants} participants · ${c.state}`,
              source: "competition_engine",
            });
          }
        }

        // Sort by timestamp descending
        timeline.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        setEntries(timeline);
      } catch {
        if (!cancelled) {
          toast({
            title: "Failed to load timeline",
            description: "Could not fetch timeline activity. Please try again.",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.type === filter);
  }, [entries, filter]);

  const signOut = async () => {
    try {
      await fetch("/api/auth/sign-out", { method: "POST" });
    } catch {
      // best-effort
    }
    router.push("/");
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]">
              <HeartPulse className="h-4 w-4" />
            </div>
            <span className="font-bold text-sm">Timeline</span>
          </button>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard")}>
              Back to Dashboard
            </Button>
            <Button variant="ghost" size="sm" onClick={signOut} aria-label="Sign out">
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight mb-2">Health Timeline</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Every measurement, mission, and competition in one chronological view.
        </p>

        {/* Filter row */}
        <div className="flex flex-wrap gap-2 mb-6" role="tablist" aria-label="Filter timeline by type">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? "default" : "outline"}
              role="tab"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-12">
            <div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Loading timeline...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {entries.length === 0
                ? "No activity yet. Start by recording a measurement or completing a mission!"
                : "No entries match this filter."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((entry, i) => (
              <div key={`${entry.type}-${entry.id}`} className="flex gap-3">
                {/* Timeline line */}
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)] shrink-0">
                    {TYPE_ICONS[entry.type] ?? <Activity className="h-3.5 w-3.5" />}
                  </div>
                  {i < filtered.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                </div>
                {/* Content */}
                <Card className="flex-1 mb-1">
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{entry.title}</p>
                        <p className="text-xs text-muted-foreground">{entry.description}</p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0 capitalize">
                        {entry.type}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {new Date(entry.timestamp).toLocaleString()}
                    </p>
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="max-w-3xl mx-auto px-4 py-4 text-xs text-muted-foreground text-center">
          Eks-Health — Preventive Health Operating System · prototype
        </div>
      </footer>
    </div>
  );
}
