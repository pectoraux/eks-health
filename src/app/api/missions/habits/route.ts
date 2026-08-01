import { NextRequest, NextResponse } from "next/server";
import { withPlatform, getHabitManager, ensurePlatform, ensureHydrated } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
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

export async function POST(req: NextRequest) {
  ensurePlatform();
  await ensureHydrated();
  const body = await req.json() as { habitId?: string; action?: "complete" | "miss" };
  if (!body.habitId || !body.action) {
    return NextResponse.json({ ok: false, error: { message: "habitId and action required" } }, { status: 400 });
  }
  try {
    const habits = getHabitManager();
    const habit = habits.get(body.habitId as never);
    if (!habit) return NextResponse.json({ ok: false, error: { message: "Habit not found" } }, { status: 404 });
    const updated = body.action === "complete" ? habits.complete(body.habitId as never) : habits.miss(body.habitId as never);
    return NextResponse.json({ ok: true, data: { habitId: updated.id, currentStreak: updated.streak.current, bestStreak: updated.streak.best, score: updated.score } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: { message: (err as Error).message } }, { status: 500 });
  }
}
