import { withPlatform, getHabitManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const habits = getHabitManager();
    return {
      habits: habits.list().slice(0, 50).map((h) => ({
        id: h.id, name: h.name, frequency: h.frequency, active: h.active,
        currentStreak: h.streak.current, bestStreak: h.streak.best,
        totalCompletions: h.totalCompletions, score: h.score,
      })),
      stats: habits.getStats(),
    };
  });
}
