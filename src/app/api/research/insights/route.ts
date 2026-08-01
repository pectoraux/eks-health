import { withPlatform, getInsights, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const mgr = getInsights();
    const insights = mgr.list();
    return {
      insights: insights.slice(0, 50).map((i) => ({
        id: i.id, type: i.type, title: i.title, summary: i.summary,
        programId: i.programId, confidence: i.confidence,
        generatedAt: i.generatedAt, status: i.status,
      })),
      stats: mgr.getStats(),
    };
  });
}
