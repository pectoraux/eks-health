import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform } from "@/lib/platform-server";
import { getSession, ensureAdminAccount } from "@/lib/auth";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensurePlatform();
  await ensureAdminAccount();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: { message: "Admin access required" } }, { status: 403 });

  const { id } = await params;
  try {
    await db.eksWaitlistEntry.update({
      where: { id },
      data: { status: "rejected" },
    });
    return NextResponse.json({ ok: true, data: { id, status: "rejected" } });
  } catch {
    return NextResponse.json({ ok: false, error: { message: "Waitlist entry not found" } }, { status: 404 });
  }
}
