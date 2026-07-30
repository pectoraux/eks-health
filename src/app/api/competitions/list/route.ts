import { withPlatform, getCompetitionRegistry, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const comps = getCompetitionRegistry();
    return {
      competitions: comps.list().map((c) => ({
        id: c.id, slug: c.slug, name: c.name, scope: c.scope, state: c.state,
        programId: c.programId, currentParticipants: c.currentParticipants,
        maxParticipants: c.maxParticipants, startsAt: c.startsAt, endsAt: c.endsAt,
        divisionCount: c.divisionIds.length, seasonCount: c.seasonIds.length,
        tags: c.tags, createdAt: c.createdAt,
      })),
      stats: comps.getStats(),
    };
  });
}
