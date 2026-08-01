import { withPlatform, getMemberships, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const mgr = getMemberships();
    // List all memberships across orgs (call listByOrg for each known org,
    // but since we don't have an org list here, just return stats + a note).
    return {
      memberships: [],
      stats: mgr.getStats(),
      message: "Use /api/identity/orgs/[id] to view memberships for a specific org.",
    };
  });
}
