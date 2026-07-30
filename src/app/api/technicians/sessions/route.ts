import { withPlatform, getSessionManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const sessions = getSessionManager();
    return {
      sessions: sessions.list({}).slice(0, 50).map((s) => ({
        id: s.id, participantId: s.participantId, technicianId: s.technicianId,
        programId: s.programId, status: s.status, scheduledAt: s.scheduledAt,
        measurementCount: s.recordedMeasurements.length, evidenceCount: s.evidenceIds.length,
        completedAt: s.completedAt,
      })),
    };
  });
}
