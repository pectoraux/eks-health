import { withPlatform, getSessions, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

// List sessions (optionally for an account)
export function GET(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const url = new URL(req.url);
    const accountId = url.searchParams.get("accountId");
    if (accountId) {
      return getSessions().listForAccount(accountId as never);
    }
    return { stats: getSessions().getStats(), sessions: getSessions().list().slice(-50) };
  });
}

// Refresh a session
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { refreshToken?: string };
    if (!body.refreshToken) throw new Error("refreshToken required");
    const session = getSessions().refresh(body.refreshToken);
    return {
      sessionId: session.id,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    };
  });
}
