import { withPlatform, getKnowledgeManager, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const knowledge = getKnowledgeManager();
    return {
      bases: knowledge.listBases().map((b) => ({
        id: b.id, name: b.name, type: b.type, entryCount: b.entryCount,
        allowedRetrieval: b.licensing?.allowedRetrieval ?? true,
      })),
      stats: knowledge.getStats(),
    };
  });
}
