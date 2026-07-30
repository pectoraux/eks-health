import { withPlatform, getReviewManager, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const reviews = getReviewManager();
    return { stats: reviews.getStats() };
  });
}
