import { withPlatform, getPlanManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const plans = getPlanManager();
    return {
      plans: plans.list().slice(0, 50).map((p) => ({
        id: p.id, name: p.name, state: p.state, version: p.version,
        missionCount: p.missionIds.length, goalCount: p.goalIds.length,
        habitCount: p.habitIds.length, participantId: p.participantId,
        createdAt: p.createdAt, updatedAt: p.updatedAt,
      })),
      stats: plans.getStats(),
    };
  });
}
