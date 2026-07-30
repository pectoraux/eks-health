import { withPlatform, getTechnicianRegistry, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const techs = getTechnicianRegistry();
    return {
      technicians: techs.list().map((t) => ({
        id: t.id, accountId: t.accountId, category: t.category, displayName: t.displayName,
        languages: t.languages, regionsServed: t.regionsServed, skills: t.skills,
        supportedPrograms: t.supportedPrograms, rating: t.rating, reviewCount: t.reviewCount,
        totalSessions: t.totalSessions, verifiedSessions: t.verifiedSessions,
        disputedSessions: t.disputedSessions, status: t.status, createdAt: t.createdAt,
      })),
      stats: techs.getStats(),
    };
  });
}
