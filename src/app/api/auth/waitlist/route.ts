import { NextResponse } from "next/server";
import { ensurePlatform } from "@/lib/platform-server";
import { getWaitlist } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  ensurePlatform();
  const waitlist = await getWaitlist();
  return NextResponse.json({ ok: true, data: waitlist });
}
