import { withPlatform, getDisputeManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const disputes = getDisputeManager();
    return {
      stats: disputes.getStats(),
      disputes: disputes.list({}).slice(0, 30).map((d) => ({
        id: d.id, status: d.status, reason: d.reason, openedAt: d.openedAt,
        technicianId: d.technicianId, programId: d.programId,
      })),
    };
  });
}
