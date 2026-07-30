import { withPlatform, getSessions, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// Sign out (revoke session)
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { sessionId?: string };
    if (!body.sessionId) throw new IdentityError({ code: "eks.identity.session.required", category: "validation", message: "sessionId required" });
    getSessions().revoke(body.sessionId as never, "user_signout");
    return { signedOut: true };
  });
}
