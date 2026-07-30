import { withPlatform, getPopulation, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => { ensurePlatform(); const p = getPopulation(); return { latest: p.getLatest(), stats: p.getStats() }; });
}
