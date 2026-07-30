import { withPlatform, getSessions, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

// Revoke a specific session
export function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    getSessions().revoke(id as never, "explicit_revoke");
    return { revoked: true, sessionId: id };
  });
}
