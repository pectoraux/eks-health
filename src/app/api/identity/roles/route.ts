import { withPlatform, getRoles, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return {
      roles: getRoles().listRoles(),
      assignments: getRoles().listAssignments({ activeOnly: true }),
    };
  });
}

// Assign a role
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { accountId?: string; roleName?: string; scope?: string; scopeId?: string };
    if (!body.accountId || !body.roleName) throw new Error("accountId, roleName required");
    const role = getRoles().getRoleByName(body.roleName);
    if (!role) throw new Error("Unknown role");
    const assignment = getRoles().assignRole(body.accountId as never, role.id, {
      scope: (body.scope ?? "account") as never,
      scopeId: body.scopeId,
    });
    return { assignmentId: assignment.id, roleId: role.id, roleName: role.name };
  });
}

// Simulate adding a role
export function PUT(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { accountId?: string; roleName?: string };
    if (!body.accountId || !body.roleName) throw new Error("accountId, roleName required");
    const role = getRoles().getRoleByName(body.roleName);
    if (!role) throw new Error("Unknown role");
    return getRoles().simulate(body.accountId as never, role.id);
  });
}
