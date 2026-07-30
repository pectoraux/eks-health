import { withPlatform, getAccounts, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// Issue a verification code (demo: returns the code so the console can show it)
export function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const account = getAccounts().get(id as never);
    if (!account) throw new IdentityError({ code: "eks.identity.account.not_found", category: "account_not_found", message: "Not found" });
    const code = getAccounts().issueVerificationToken(account.id, account.email, "email");
    return { sent: true, code, message: "Verification code issued (demo returns it inline)." };
  });
}

// Verify with a code
export function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { code?: string };
    if (!body.code) throw new IdentityError({ code: "eks.identity.verification.invalid", category: "verification_required", message: "code required" });
    const account = getAccounts().verifyToken(body.code);
    return { verified: true, accountId: account.id, state: account.state };
  });
}
