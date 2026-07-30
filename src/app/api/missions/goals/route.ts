import { withPlatform, getGoalManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
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
