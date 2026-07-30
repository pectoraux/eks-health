import { withPlatform, getApiExplorer, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const api = getApiExplorer();
    return {
      endpoints: api.listEndpoints().map((e) => ({ id: e.id, path: e.path, method: e.method, description: e.description, category: e.category, authRequired: e.authRequired })),
      categories: api.listCategories(),
      stats: api.getStats(),
    };
  });
}
