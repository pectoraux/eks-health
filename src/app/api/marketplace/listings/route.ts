import { withPlatform, getListingRegistry, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const profiles = getListingRegistry();
    return {
      listings: profiles.list({ status: "published" }).map((l) => ({
        id: l.id, name: l.solution.name, tagline: l.solution.tagline, category: l.solution.category,
        bodySystems: l.solution.bodySystems, healthGoals: l.solution.healthGoals,
        developerName: l.developerName, pricing: l.pricing,
        supportedCountries: l.supportedCountries, installCount: l.installCount,
        activeInstallCount: l.activeInstallCount, version: l.version, publishedAt: l.publishedAt,
      })),
      stats: profiles.getStats(),
    };
  });
}
