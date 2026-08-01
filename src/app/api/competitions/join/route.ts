import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform, ensureHydrated, getCompetitionRegistry, getQualificationManager } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  ensurePlatform();
  await ensureHydrated();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });

  const body = await req.json() as { competitionId?: string };
  if (!body.competitionId) return NextResponse.json({ ok: false, error: { message: "competitionId required" } }, { status: 400 });

  try {
    const comps = getCompetitionRegistry();
    const comp = comps.get(body.competitionId as never);
    if (!comp) return NextResponse.json({ ok: false, error: { message: "Competition not found" } }, { status: 404 });
    if (comp.state !== "active" && comp.state !== "registration" && comp.state !== "qualification") {
      return NextResponse.json({ ok: false, error: { message: `Competition is ${comp.state}, cannot join` } }, { status: 400 });
    }

    // Register participant
    const qual = getQualificationManager();
    const season = comp.seasonIds[comp.seasonIds.length - 1];
    if (!season) return NextResponse.json({ ok: false, error: { message: "No active season" } }, { status: 400 });

    const participation = qual.register({
      participantId: session.accountId as never,
      competitionId: body.competitionId as never,
      seasonId: season,
    });
    comps.incrementParticipants(body.competitionId as never);

    return NextResponse.json({ ok: true, data: { participationId: participation.id, competitionId: body.competitionId, status: participation.status } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: { message: (err as Error).message } }, { status: 500 });
  }
}
