import { NextRequest, NextResponse } from "next/server";
import { withPlatform, getGoalManager, ensurePlatform, ensureHydrated } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const goals = getGoalManager();
    return {
      goals: goals.list().slice(0, 50).map((g) => ({
        id: g.id, name: g.name, type: g.type, state: g.state,
        targetValue: g.targetValue, currentValue: g.currentValue, unit: g.unit,
        progress: g.targetValue > 0 ? Math.round((g.currentValue / g.targetValue) * 100) : 0,
        milestoneCount: g.milestones.length, achievedMilestones: g.milestones.filter((m) => m.achievedAt).length,
        adaptive: g.adaptive, deadline: g.deadline,
      })),
      stats: goals.getStats(),
    };
  });
}

export async function POST(req: NextRequest) {
  ensurePlatform();
  await ensureHydrated();
  const body = await req.json() as { goalId?: string; action?: "updateProgress"; currentValue?: number };
  if (!body.goalId || body.action !== "updateProgress" || body.currentValue === undefined) {
    return NextResponse.json({ ok: false, error: { message: "goalId, action=updateProgress, currentValue required" } }, { status: 400 });
  }
  try {
    const goals = getGoalManager();
    const goal = goals.get(body.goalId as never);
    if (!goal) return NextResponse.json({ ok: false, error: { message: "Goal not found" } }, { status: 404 });
    const updated = goals.updateProgress(body.goalId as never, body.currentValue);
    const progress = updated.targetValue > 0 ? Math.round((updated.currentValue / updated.targetValue) * 100) : 0;
    return NextResponse.json({ ok: true, data: { goalId: updated.id, currentValue: updated.currentValue, progress, state: updated.state } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: { message: (err as Error).message } }, { status: 500 });
  }
}
