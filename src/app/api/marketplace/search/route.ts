import { withPlatform, getDiscoveryEngine, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  return withPlatform(() => {
    ensurePlatform();
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    const results = getDiscoveryEngine().search({ text: q });
    return { query: q, results: results.map((r) => ({ listingId: r.listingId, name: r.listing.solution.name, score: r.score })), total: results.length };
  });
}
