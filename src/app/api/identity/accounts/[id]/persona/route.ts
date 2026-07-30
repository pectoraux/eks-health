import { withPlatform, getAccounts, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// Switch active persona
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { persona?: string };
    if (!body.persona) throw new IdentityError({ code: "eks.identity.persona.required", category: "validation", message: "persona required" });
    const result = getAccounts().switchPersona(id as never, body.persona as never);
    return { accountId: result.account.id, previousPersona: result.previousPersona, activePersona: result.newPersona };
  });
}

// Add a persona to the account
export function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { persona?: string };
    if (!body.persona) throw new IdentityError({ code: "eks.identity.persona.required", category: "validation", message: "persona required" });
    const account = getAccounts().addPersona(id as never, body.persona as never);
    return { accountId: account.id, personas: account.personas };
  });
}
