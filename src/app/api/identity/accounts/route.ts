import { withPlatform, getAccounts, ensurePlatform } from "@/lib/platform-server";
import { IdentityError, asAccountId, type AccountId } from "@/identity";

export const dynamic = "force-dynamic";

// List accounts
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return getAccounts().list().map((a) => ({
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      state: a.state,
      personas: a.personas,
      activePersona: a.activePersona,
      mfaEnabled: a.mfaEnabled,
      verified: a.contacts.some((c) => c.verified),
      createdAt: a.createdAt,
      lastSignInAt: a.lastSignInAt,
    }));
  });
}

// Register a new account
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      email?: string;
      password?: string;
      displayName?: string;
      persona?: string;
      locale?: string;
      timezone?: string;
    };
    if (!body.email || !body.password || !body.displayName) {
      throw new IdentityError({
        code: "eks.identity.account.invalid_input",
        category: "validation",
        message: "email, password, displayName required",
        userMessage: "Email, password and display name are required.",
      });
    }
    const account = getAccounts().register({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      persona: body.persona as never,
      locale: body.locale,
      timezone: body.timezone,
    });
    return {
      accountId: account.id,
      email: account.email,
      state: account.state,
      message: "Account created. Check your email for a verification code.",
    };
  });
}

// Helper to parse :id routes is handled by [id]/route.ts
export function accountIdParam(id: string): AccountId {
  return asAccountId(id);
}
