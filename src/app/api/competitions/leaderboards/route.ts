import { withPlatform, getLeaderboardManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const lbs = getLeaderboardManager();
    return {
      leaderboards: lbs.list(undefined as never).map((l) => ({
        id: l.id, competitionId: l.competitionId, seasonId: l.seasonId,
        name: l.name, scope: l.scope, rankingMethod: l.rankingMethod,
        entryCount: lbs.getParticipantCount(l.id),
      })),
    };
  });
}
