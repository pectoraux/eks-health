import { NextRequest } from "next/server";
import { withPlatform, getAccounts, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// Get account details
export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const account = getAccounts().get(id as never);
    if (!account) throw new IdentityError({ code: "eks.identity.account.not_found", category: "account_not_found", message: "Not found" });
    return {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      state: account.state,
      personas: account.personas,
      activePersona: account.activePersona,
      contacts: account.contacts,
      mfaEnabled: account.mfaEnabled,
      createdAt: account.createdAt,
      lastSignInAt: account.lastSignInAt,
    };
  });
}

// Update account (display name, locale, timezone)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensurePlatform();
  const { id } = await params;
  const body = await req.json() as { displayName?: string; locale?: string; timezone?: string };
  try {
    const account = getAccounts().updateProfile(id as never, {
      displayName: body.displayName,
      locale: body.locale,
      timezone: body.timezone,
    });
    return Response.json({ ok: true, data: { id: account.id, displayName: account.displayName } });
  } catch (err) {
    const e = err as { userMessage?: string; message?: string };
    return Response.json({ ok: false, error: { message: e.userMessage ?? e.message ?? "Update failed" } }, { status: 400 });
  }
}
