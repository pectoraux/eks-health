import { withPlatform, getRewardManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const rewards = getRewardManager();
    return {
      schedules: rewards.listSchedules(undefined as never, undefined as never).map((s) => ({
        id: s.id, name: s.name, type: s.type, podiumSize: s.podiumSize,
        distribution: s.distribution, minPoolThreshold: s.minPoolThreshold,
      })),
      events: rewards.listRewardEvents().slice(0, 30).map((e) => ({
        id: e.id, type: e.type, participantId: e.participantId, rank: e.rank,
        amount: e.amount, currency: e.currency, createdAt: e.createdAt,
      })),
    };
  });
}
