import { withPlatform, getOutcomeTracker, ensurePlatform } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const outcomes = getOutcomeTracker();
    return { stats: outcomes.getStats(), top: outcomes.getTopOutcomes(5) };
  });
}
