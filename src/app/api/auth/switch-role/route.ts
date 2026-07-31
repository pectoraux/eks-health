import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform, getAccounts, getSessions } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  ensurePlatform();
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });
  }
  const body = await req.json() as { persona?: string };
  if (!body.persona) {
    return NextResponse.json({ ok: false, error: { message: "Persona required" } }, { status: 400 });
  }
  // Validate the persona is held by the account
  const account = getAccounts().get(session.accountId as never);
  if (!account || !account.personas.includes(body.persona as never)) {
    return NextResponse.json({ ok: false, error: { message: "You don't have this role" } }, { status: 403 });
  }
  // Switch persona on the session
  getSessions().switchPersona(session.sessionId as never, body.persona as never);
  // Update account active persona
  getAccounts().switchPersona(session.accountId as never, body.persona as never);
  return NextResponse.json({
    ok: true,
    data: { activePersona: body.persona, personas: account.personas },
  });
}
