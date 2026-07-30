import { withPlatform, getPrizePoolManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const pools = getPrizePoolManager();
    return {
      pools: pools.list().map((p) => ({
        id: p.id, competitionId: p.competitionId, seasonId: p.seasonId,
        currency: p.currency, balance: p.balance, allocated: p.allocated, pending: p.pending,
      })),
    };
  });
}
