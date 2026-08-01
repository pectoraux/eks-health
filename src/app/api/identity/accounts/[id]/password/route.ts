import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform, getAccounts } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensurePlatform();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });
  // Only allow changing your own password (or admin)
  if (session.accountId !== (await params).id && !session.isAdmin) {
    return NextResponse.json({ ok: false, error: { message: "Can only change your own password" } }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json() as { currentPassword?: string; newPassword?: string };
  if (!body.currentPassword || !body.newPassword) {
    return NextResponse.json({ ok: false, error: { message: "Current and new password required" } }, { status: 400 });
  }

  try {
    getAccounts().changePassword(id as never, body.currentPassword, body.newPassword);
    return NextResponse.json({ ok: true, data: { message: "Password changed successfully" } });
  } catch (err) {
    const e = err as { userMessage?: string; message?: string };
    return NextResponse.json({ ok: false, error: { message: e.userMessage ?? e.message ?? "Password change failed" } }, { status: 400 });
  }
}
