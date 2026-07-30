import { withPlatform, getAuthorization, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

// Evaluate a permission for a principal
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      accountId?: string;
      persona?: string;
      permission?: string;
      orgId?: string;
      programId?: string;
      purpose?: string;
      mfaVerified?: boolean;
    };
    if (!body.accountId || !body.persona || !body.permission) {
      throw new Error("accountId, persona, permission required");
    }
    const result = getAuthorization().evaluate(
      {
        accountId: body.accountId as never,
        persona: body.persona as never,
        orgId: body.orgId,
        programId: body.programId,
        purpose: body.purpose,
        attributes: { mfaVerified: body.mfaVerified ?? false },
        time: new Date().toISOString(),
      },
      body.permission,
    );
    return {
      decision: result.decision,
      reasons: result.reasons,
      permission: body.permission,
    };
  });
}
