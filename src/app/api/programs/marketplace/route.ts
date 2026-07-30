import { withPlatform, getMarketplace, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const url = new URL(req.url);
    const query = url.searchParams.get("q");
    if (query) {
      return { results: getMarketplace().search(query) };
    }
    return {
      listings: getMarketplace().listListings(),
      categories: getMarketplace().getCategories(),
      stats: getMarketplace().getStats(),
    };
  });
}
