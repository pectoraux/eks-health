import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform, getMissionManager } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  ensurePlatform();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });

  const body = await req.json() as { missionId?: string; outcome?: "success" | "partial" | "failed"; value?: unknown };
  if (!body.missionId) return NextResponse.json({ ok: false, error: { message: "missionId required" } }, { status: 400 });

  try {
    const missions = getMissionManager();
    const mission = missions.get(body.missionId as never);
    if (!mission) return NextResponse.json({ ok: false, error: { message: "Mission not found" } }, { status: 404 });

    const updated = missions.complete(body.missionId as never, {
      outcome: body.outcome ?? "success",
      value: body.value,
    });

    return NextResponse.json({ ok: true, data: { missionId: updated.id, state: updated.state, result: updated.result } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: { message: (err as Error).message } }, { status: 500 });
  }
}
