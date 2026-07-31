import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform } from "@/lib/platform-server";
import { getSession, approveWaitlistEntry } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensurePlatform();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: { message: "Admin access required" } }, { status: 403 });

  const { id } = await params;
  const entry = await approveWaitlistEntry(id);
  if (!entry) return NextResponse.json({ ok: false, error: { message: "Waitlist entry not found" } }, { status: 404 });

  return NextResponse.json({ ok: true, data: { id: entry.id, status: entry.status, accountId: entry.accountId, email: entry.email } });
}
