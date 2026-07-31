import { withPlatform, getCampaigns, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const c = getCampaigns();
    return {
      campaigns: c.list().map((x) => ({ id: x.id, name: x.name, status: x.status, scope: x.scope, participationGoal: x.participationGoal, actualParticipation: x.actualParticipation })),
      stats: c.getStats(),
    };
  });
}
