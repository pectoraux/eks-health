import { withPlatform, getConsent, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

// Check whether a program may access a field for a purpose
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      accountId?: string;
      programId?: string;
      purpose?: string;
      field?: string;
    };
    if (!body.accountId || !body.programId || !body.purpose || !body.field) {
      throw new Error("accountId, programId, purpose, field required");
    }
    const allowed = getConsent().checkAccess(body.accountId as never, body.programId, body.purpose, body.field);
    return { allowed, accountId: body.accountId, programId: body.programId, purpose: body.purpose, field: body.field };
  });
}
