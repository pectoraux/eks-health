import { withPlatform, getOrganizations, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

// Invite a member by email
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { email?: string; role?: string; invitedBy?: string };
    if (!body.email || !body.role) throw new IdentityError({ code: "eks.identity.org.invalid_input", category: "validation", message: "email, role required" });
    const token = getOrganizations().invite(id as never, body.email, body.role as never, body.invitedBy as never);
    return { invited: true, email: body.email, token };
  });
}

// Accept an invite
export function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { token?: string; accountId?: string };
    if (!body.token || !body.accountId) throw new IdentityError({ code: "eks.identity.org.invalid_input", category: "validation", message: "token, accountId required" });
    const membership = getOrganizations().acceptInvite(body.token, body.accountId as never);
    return { accepted: true, orgId: id, membership };
  });
}
