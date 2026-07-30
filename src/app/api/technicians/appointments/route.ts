import { withPlatform, getAppointmentManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const appts = getAppointmentManager();
    return {
      appointments: appts.list({}).slice(0, 50).map((a) => ({
        id: a.id, participantId: a.participantId, technicianId: a.technicianId,
        programId: a.programId, status: a.status, scheduledAt: a.scheduledAt,
        durationMinutes: a.durationMinutes, sessionType: a.sessionType,
      })),
    };
  });
}
