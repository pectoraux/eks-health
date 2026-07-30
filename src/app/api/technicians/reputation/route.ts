import { withPlatform, getReputationManager, getTechnicianRegistry, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const reputation = getReputationManager();
    const techs = getTechnicianRegistry();
    return {
      profiles: techs.list().map((t) => {
        const rep = reputation.get(t.id);
        return rep ? {
          technicianId: t.id, technicianName: t.displayName,
          overallScore: rep.overallScore, trend: rep.trend,
          reviewCount: rep.reviewCount, positiveCount: rep.positiveCount,
          negativeCount: rep.negativeCount,
        } : null;
      }).filter(Boolean),
    };
  });
}
