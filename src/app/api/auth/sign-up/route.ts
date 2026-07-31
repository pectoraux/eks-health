import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform } from "@/lib/platform-server";
import { addToWaitlist } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  ensurePlatform();
  const body = await req.json() as {
    name?: string; email?: string; country?: string;
    interestedRoles?: string[]; reason?: string; referral?: string;
  };

  if (!body.name || !body.email || !body.country) {
    return NextResponse.json(
      { ok: false, error: { message: "Name, email, and country required" } },
      { status: 400 },
    );
  }

  const entry = await addToWaitlist({
    name: body.name,
    email: body.email,
    country: body.country,
    interestedRoles: body.interestedRoles ?? ["participant"],
    reason: body.reason ?? "",
    referral: body.referral,
  });

  return NextResponse.json({
    ok: true,
    data: { id: entry.id, status: entry.status, message: "You're on the waitlist! We'll notify you when your account is approved." },
  });
}
