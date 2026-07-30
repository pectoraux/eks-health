import { withPlatform, getAuth, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// Complete MFA challenge
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      challengeId?: string;
      code?: string;
      providerId?: string;
      email?: string;
      password?: string;
      ipAddress?: string;
    };
    if (!body.challengeId || !body.code) throw new IdentityError({ code: "eks.identity.mfa.invalid", category: "mfa_failed", message: "challengeId and code required" });
    const result = await getAuth().completeMfa(body.challengeId, body.code, {
      providerId: body.providerId ?? "password",
      credentials: { email: body.email, password: body.password },
      ipAddress: body.ipAddress,
    });
    return {
      status: "authenticated",
      principal: result.principal,
      sessionId: result.sessionId,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      strength: result.strength,
    };
  });
}
