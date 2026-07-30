import { withPlatform, getCollectionManager, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const collections = getCollectionManager();
    return {
      collections: collections.list().map((c) => ({ id: c.id, name: c.name, description: c.description, category: c.category, listingCount: c.listingIds.length })),
    };
  });
}
