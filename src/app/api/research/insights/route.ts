import { withPlatform, getInsights, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => { ensurePlatform(); return { stats: getInsights().getStats() }; });
}
