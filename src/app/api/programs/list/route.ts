import { withPlatform, getProgramRegistry, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const registry = getProgramRegistry();
    return {
      programs: registry.list().map((p) => ({
        id: p.id, slug: p.slug, name: p.name, kind: p.kind, category: p.category,
        state: p.state, developerId: p.developerId, versionCount: p.versions.length,
        currentVersionId: p.currentVersionId, installedCount: p.installedCount,
        activeInstallCount: p.activeInstallCount, rating: p.rating, reviewCount: p.reviewCount,
        createdAt: p.createdAt, publishedAt: p.publishedAt, forkedFrom: p.forkedFrom,
      })),
      capabilities: getProgramRegistry().getAuditLog().slice(-20),
    };
  });
}
