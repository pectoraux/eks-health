import { NextResponse } from "next/server";
import { ensurePlatform } from "@/lib/platform-server";
import { getSession, ensureAdminAccount, ensureDemoAccounts } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  ensurePlatform();
  ensureAdminAccount();
  ensureDemoAccounts();
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: true, data: null });
  }
  return NextResponse.json({ ok: true, data: session });
}
