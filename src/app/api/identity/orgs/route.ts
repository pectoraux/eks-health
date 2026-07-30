import { withPlatform, getOrganizations, ensurePlatform } from "@/lib/platform-server";
import { IdentityError } from "@/identity";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return getOrganizations().list();
  });
}

export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { name?: string; type?: string; createdBy?: string };
    if (!body.name || !body.type) throw new IdentityError({ code: "eks.identity.org.invalid_input", category: "validation", message: "name, type required" });
    const org = getOrganizations().create({
      name: body.name,
      type: body.type as never,
      createdBy: body.createdBy as never,
    });
    return { orgId: org.id, name: org.name, type: org.type };
  });
}
