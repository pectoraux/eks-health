import { withPlatform, getAuth, getAccounts, getDevices, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// List auth providers
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return getAuth().listProviders();
  });
}

// Sign in (step 1)
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      providerId?: string;
      email?: string;
      password?: string;
      deviceId?: string;
      ipAddress?: string;
      userAgent?: string;
    };
    if (!body.providerId) throw new IdentityError({ code: "eks.identity.auth.provider_required", category: "validation", message: "providerId required" });
    const device = body.deviceId ? getDevices().get(body.deviceId as never) : undefined;
    const result = await getAuth().signIn({
      providerId: body.providerId,
      credentials: body.providerId === "password" ? { email: body.email, password: body.password } : { authorizationCode: body.password },
      device: device ?? undefined,
      ipAddress: body.ipAddress,
      userAgent: body.userAgent,
    });
    if (result.status === "mfa_required") {
      return { status: "mfa_required", mfaChallengeId: result.mfaChallengeId };
    }
    return {
      status: "authenticated",
      principal: result.result!.principal,
      sessionId: result.result!.sessionId,
      accessToken: result.result!.accessToken,
      refreshToken: result.result!.refreshToken,
      expiresAt: result.result!.expiresAt,
      strength: result.result!.strength,
      riskScore: result.result!.riskScore,
    };
  });
}
