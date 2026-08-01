import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform, ensureHydrated, getAccounts } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensurePlatform();
  await ensureHydrated();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });
  if (session.accountId !== (await params).id && !session.isAdmin) {
    return NextResponse.json({ ok: false, error: { message: "Can only modify your own account" } }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json() as { enabled?: boolean };
  if (body.enabled === undefined) {
    return NextResponse.json({ ok: false, error: { message: "enabled field required" } }, { status: 400 });
  }

  try {
    const account = getAccounts().setMfaEnabled(id as never, body.enabled);
    return NextResponse.json({ ok: true, data: { id: account.id, mfaEnabled: account.mfaEnabled } });
  } catch (err) {
    const e = err as { userMessage?: string; message?: string };
    return NextResponse.json({ ok: false, error: { message: e.userMessage ?? e.message ?? "MFA toggle failed" } }, { status: 400 });
  }
}
