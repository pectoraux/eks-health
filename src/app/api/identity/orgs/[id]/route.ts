import { withPlatform, getOrganizations, getRoles, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const org = getOrganizations().get(id as never);
    if (!org) throw new IdentityError({ code: "eks.identity.org.not_found", category: "not_found", message: "Org not found" });
    const members = getOrganizations().listMembers(id as never);
    const teams = getOrganizations().listTeams(id as never);
    return { org, members, teams };
  });
}

// Add a member
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { accountId?: string; role?: string };
    if (!body.accountId || !body.role) throw new IdentityError({ code: "eks.identity.org.invalid_input", category: "validation", message: "accountId, role required" });
    getOrganizations().addMember(id as never, body.accountId as never, body.role as never);
    // Assign the matching org-scoped role
    const role = getRoles().getRoleByName(body.role === "admin" ? "org_admin" : body.role === "auditor" ? "auditor" : "participant");
    if (role) getRoles().assignRole(body.accountId as never, role.id, { scope: "org", scopeId: id });
    return { added: true, accountId: body.accountId, role: body.role };
  });
}
