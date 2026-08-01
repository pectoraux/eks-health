import { NextResponse } from "next/server";
import {
  ensurePlatform,
  ensureHydrated,
  getMissionManager, getGoalManager, getHabitManager,
  getCompetitionRegistry, getHealthMeasurements,
  getTechnicianRegistry, getDeveloperManager,
  getMarketplace, getMarketplaceAnalytics,
  getResearchConsent, getPopulationAnalytics,
  getAccounts,
} from "@/lib/platform-server";
import { getSession, getWaitlist } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  ensurePlatform();
  await ensureHydrated();
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });
  }

  const persona = session.activePersona;
  const data: Record<string, unknown> = { persona, displayName: session.displayName, email: session.email };

  try {
    if (persona === "participant") {
      const missions = getMissionManager();
      const goals = getGoalManager();
      const habits = getHabitManager();
      // Demo accounts use the demo participant ID so they see seeded data
      const participantId = (session.isDemo ? "acc_demo_1" : session.accountId) as never;
      data.missions = {
        stats: missions.getStats(),
        today: missions.getToday(participantId).map((m) => ({ id: m.id, title: m.title, category: m.category, state: m.state, priority: m.priority, difficulty: m.difficulty, aiGenerated: m.aiGenerated })),
      };
      data.goals = {
        stats: goals.getStats(),
        active: goals.list({ state: "active" }).slice(0, 5).map((g) => ({ id: g.id, name: g.name, targetValue: g.targetValue, currentValue: g.currentValue, unit: g.unit, progress: g.targetValue > 0 ? Math.round((g.currentValue / g.targetValue) * 100) : 0 })),
      };
      data.habits = {
        stats: habits.getStats(),
        active: habits.list({ activeOnly: true }).slice(0, 5).map((h) => ({ id: h.id, name: h.name, currentStreak: h.streak.current, bestStreak: h.streak.best, score: h.score })),
      };
      try {
        const comps = getCompetitionRegistry();
        data.competitions = { stats: comps.getStats(), active: comps.list({ state: "active" }).slice(0, 5).map((c) => ({ id: c.id, name: c.name, scope: c.scope, currentParticipants: c.currentParticipants })) };
      } catch { data.competitions = { stats: {}, active: [] }; }
      try {
        const measurements = getHealthMeasurements();
        data.measurements = { stats: measurements.getStats(), recent: measurements.list({ limit: 10 }).map((m) => measurements.toRecord(m)) };
      } catch { data.measurements = { stats: {}, recent: [] }; }
    }

    if (persona === "health_technician") {
      try {
        const techs = getTechnicianRegistry();
        data.technicians = {
          stats: techs.getStats(),
          list: techs.list().slice(0, 10).map((t) => ({ id: t.id, displayName: t.displayName, category: t.category, rating: t.rating, totalSessions: t.totalSessions, verifiedSessions: t.verifiedSessions, status: t.status })),
        };
      } catch { data.technicians = { stats: {}, list: [] }; }
      try {
        data.measurements = { stats: getHealthMeasurements().getStats() };
      } catch { data.measurements = { stats: {} }; }
    }

    if (persona === "developer") {
      try {
        const devMgr = getDeveloperManager();
        data.developer = { profiles: devMgr.listProfiles().map((p) => ({ id: p.id, name: p.name, email: p.email, verified: p.verification.status === "verified", metrics: devMgr.getMetrics(p.id) })) };
      } catch { data.developer = { profiles: [] }; }
      try {
        data.marketplace = { stats: getMarketplace().getStats() };
      } catch { data.marketplace = { stats: {} }; }
    }

    if (persona === "researcher") {
      try { data.research = { consentStats: getResearchConsent().getStats() }; } catch { data.research = { consentStats: {} }; }
    }

    if (persona === "org_admin") {
      try { data.population = { stats: getPopulationAnalytics().getStats() }; } catch { data.population = { stats: {} }; }
    }

    if (persona === "platform_admin") {
      try {
        data.platform = {
          accounts: getAccounts().list().map((a) => ({ id: a.id, email: a.email, displayName: a.displayName, state: a.state, personas: a.personas, activePersona: a.activePersona, createdAt: a.createdAt })),
          waitlist: await getWaitlist(),
        };
      } catch { data.platform = { accounts: [], waitlist: [] }; }
      try { data.marketplace = { stats: getMarketplace().getStats() }; } catch { data.marketplace = { stats: {} }; }
    }
  } catch {
    // Graceful degradation
  }

  return NextResponse.json({ ok: true, data });
}
