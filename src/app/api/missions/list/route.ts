import { withPlatform, getMissionManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const missions = getMissionManager();
    return {
      missions: missions.list({}).slice(0, 50).map((m) => ({
        id: m.id, title: m.title, type: m.type, category: m.category,
        state: m.state, priority: m.priority, difficulty: m.difficulty,
        scheduledFor: m.scheduledFor, participantId: m.participantId,
        programId: m.programId, aiGenerated: m.aiGenerated,
      })),
      stats: missions.getStats(),
      templates: missions.listTemplates().map((t) => ({ id: t.id, slug: t.slug, name: t.name, type: t.type, category: t.category })),
    };
  });
}
