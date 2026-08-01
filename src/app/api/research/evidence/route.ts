import { withPlatform, getEvidenceEngine, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const engine = getEvidenceEngine();
    const evidence = engine.getTopEvidence(50);
    return {
      evidence: evidence.map((e) => ({
        programId: e.programId, totalParticipants: e.totalParticipants,
        effectSize: e.effectSize, confidence: e.confidence,
        state: e.state, lastUpdated: e.lastUpdated,
        positiveEvidenceCount: e.positiveEvidence?.length ?? 0,
      })),
      stats: engine.getStats(),
    };
  });
}
