import { NextResponse } from "next/server";
import { clearSessionCookies } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearSessionCookies();
  return NextResponse.json({ ok: true, data: { signedOut: true } });
}
