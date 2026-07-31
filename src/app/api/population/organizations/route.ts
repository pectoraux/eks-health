import { withPlatform, getHierarchy, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const h = getHierarchy();
    return {
      organizations: h.list().map((o) => ({ id: o.id, name: o.name, slug: o.slug, type: o.type, tier: o.tier, country: o.country, memberCount: o.memberCount, activeMemberCount: o.activeMemberCount, status: o.status })),
      stats: h.getStats(),
    };
  });
}
