import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/identity";
import { ensurePlatform, getAccounts, getSessions } from "@/lib/platform-server";
import { setSessionCookies, ensureAdminAccount, ensureDemoAccounts } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  ensurePlatform();
  await ensureAdminAccount();
  await ensureDemoAccounts();

  const body = await req.json() as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return NextResponse.json(
      { ok: false, error: { message: "Email and password required" } },
      { status: 400 },
    );
  }

  try {
    const auth = getAuth();
    const result = await auth.signIn({
      providerId: "password",
      credentials: { email: body.email, password: body.password },
    });

    if (result.status === "mfa_required") {
      return NextResponse.json({
        ok: true,
        data: { status: "mfa_required", mfaChallengeId: result.mfaChallengeId },
      });
    }

    const authResult = result.result!;
    await setSessionCookies(authResult.accessToken, authResult.refreshToken);

    const account = getAccounts().get(authResult.principal.accountId!);
    return NextResponse.json({
      ok: true,
      data: {
        accountId: account?.id,
        email: account?.email,
        displayName: account?.displayName,
        activePersona: account?.activePersona,
        personas: account?.personas,
        isDemo: account?.email.endsWith("@demo.eks.health"),
        isAdmin: account?.email === "ekontetevi@gmail.com",
      },
    });
  } catch (err) {
    const e = err as { category?: string; userMessage?: string; message?: string };
    return NextResponse.json(
      { ok: false, error: { message: e.userMessage ?? e.message ?? "Sign in failed" } },
      { status: 401 },
    );
  }
}
