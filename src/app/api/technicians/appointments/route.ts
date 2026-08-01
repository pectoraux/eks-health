import { NextRequest } from "next/server";
import { withPlatform, getAppointmentManager, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
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

export async function POST(req: NextRequest) {
  ensurePlatform();
  await ensureHydrated();
  const session = await getSession();
  if (!session) return Response.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });

  const body = await req.json() as {
    technicianId?: string;
    participantId?: string;
    programId?: string;
    sessionType?: string;
    scheduledAt?: string;
    durationMinutes?: number;
    notes?: string[];
  };

  if (!body.technicianId || !body.participantId || !body.programId || !body.sessionType || !body.scheduledAt) {
    return Response.json({ ok: false, error: { message: "technicianId, participantId, programId, sessionType, scheduledAt required" } }, { status: 400 });
  }

  try {
    const appts = getAppointmentManager();
    const appointment = appts.book({
      technicianId: body.technicianId as never,
      participantId: body.participantId as never,
      programId: body.programId as never,
      sessionType: body.sessionType as never,
      scheduledAt: body.scheduledAt,
      durationMinutes: body.durationMinutes,
      notes: body.notes,
      createdBy: session.accountId as never,
      skipRuleValidation: true, // allow demo bookings without strict rule validation
    });
    return Response.json({ ok: true, data: { id: appointment.id, status: appointment.status, scheduledAt: appointment.scheduledAt } });
  } catch (err) {
    const e = err as { userMessage?: string; message?: string };
    return Response.json({ ok: false, error: { message: e.userMessage ?? e.message ?? "Booking failed" } }, { status: 400 });
  }
}
