import { withPlatform, getDatasets, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const ds = getDatasets();
    const datasets = ds.list();
    return {
      datasets: datasets.slice(0, 50).map((d) => ({
        id: d.id, name: d.name, description: d.description, type: d.type,
        status: d.status, participantCount: d.participantCount,
        privacyLevel: d.privacyLevel, createdAt: d.createdAt, updatedAt: d.updatedAt,
      })),
      stats: ds.getStats(),
    };
  });
}
