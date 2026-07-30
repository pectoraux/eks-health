import { withPlatform, getCertificationRegistry, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const certs = getCertificationRegistry();
    return {
      types: certs.listTypes().map((t) => ({
        id: t.id, slug: t.slug, name: t.name, category: t.category, level: t.level,
        requiresRenewal: t.requiresRenewal, validityDays: t.validityDays, skills: t.skills,
        acceptedInRegions: t.acceptedInRegions,
      })),
      stats: certs.getStats(),
    };
  });
}
