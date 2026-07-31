"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { HeartPulse, LogOut, Activity, Trophy, Target, Zap, CheckCircle2, Clock, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TimelineEntry { id: string; type: string; timestamp: string; title: string; description: string; source: string; }

const TYPE_ICONS: Record<string, React.ReactNode> = {
  measurement: <Activity className="h-3.5 w-3.5" />,
  mission: <Target className="h-3.5 w-3.5" />,
  competition: <Trophy className="h-3.5 w-3.5" />,
  achievement: <Star className="h-3.5 w-3.5" />,
  reward: <Zap className="h-3.5 w-3.5" />,
};

export default function TimelinePage() {
  const router = useRouter();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch dashboard data which includes measurements and missions
    Promise.all([
      fetch("/api/dashboard", { cache: "no-store" }).then(r => r.json()),
      fetch("/api/health/measurements?limit=20", { cache: "no-store" }).then(r => r.json()),
    ]).then(([dashData, measData]) => {
      const timeline: TimelineEntry[] = [];
      
      // Add measurements
      if (measData.ok) {
        (measData.data?.recent ?? []).forEach((m: any) => {
          timeline.push({
            id: m.id, type: "measurement",
            timestamp: m.collectedAt,
            title: `Measurement: ${m.value} ${m.unitSymbol}`,
            description: `Source: ${m.sourceLabel} · ${m.verificationState}`,
            source: m.sourceType,
          });
        });
      }
      
      // Add missions from dashboard
      if (dashData.ok) {
        const todayMissions = dashData.data?.missions?.today ?? [];
        todayMissions.forEach((m: any) => {
          timeline.push({
            id: m.id, type: "mission",
            timestamp: new Date().toISOString(),
            title: m.title,
            description: `${m.category} · ${m.state} · ${m.difficulty}${m.aiGenerated ? " · AI-generated" : ""}`,
            source: "mission_engine",
          });
        });
        
        // Add competitions
        const comps = dashData.data?.competitions?.active ?? [];
        comps.forEach((c: any) => {
          timeline.push({
            id: c.id, type: "competition",
            timestamp: new Date().toISOString(),
            title: c.name,
            description: `${c.scope} · ${c.currentParticipants} participants`,
            source: "competition_engine",
          });
        });
      }
      
      // Sort by timestamp descending
      timeline.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setEntries(timeline);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--brand)] text-[var(--brand-foreground)]"><HeartPulse className="h-4 w-4" /></div>
            <span className="font-bold text-sm">Timeline</span>
          </button>
          <Button variant="ghost" size="sm" onClick={() => router.push("/dashboard")}>Back to Dashboard</Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold tracking-tight mb-2">Health Timeline</h1>
        <p className="text-sm text-muted-foreground mb-6">Every measurement, mission, competition, and achievement in one chronological view.</p>

        {loading ? (
          <div className="text-center py-12"><div className="h-8 w-8 rounded-full border-2 border-muted border-t-foreground animate-spin mx-auto mb-3" /><p className="text-sm text-muted-foreground">Loading timeline...</p></div>
        ) : entries.length === 0 ? (
          <div className="text-center py-12"><Clock className="h-12 w-12 text-muted-foreground mx-auto mb-3" /><p className="text-sm text-muted-foreground">No activity yet. Start by recording a measurement or completing a mission!</p></div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry, i) => (
              <div key={entry.id} className="flex gap-3">
                {/* Timeline line */}
                <div className="flex flex-col items-center">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--brand-muted)] text-[var(--brand)] shrink-0">
                    {TYPE_ICONS[entry.type] || <Activity className="h-3.5 w-3.5" />}
                  </div>
                  {i < entries.length - 1 && <div className="w-px flex-1 bg-border mt-1" />}
                </div>
                {/* Content */}
                <Card className="flex-1 mb-1">
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{entry.title}</p>
                        <p className="text-xs text-muted-foreground">{entry.description}</p>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">{entry.type}</Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">{new Date(entry.timestamp).toLocaleString()}</p>
                  </CardContent>
                </Card>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
