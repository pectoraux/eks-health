import { withPlatform, getSimulator, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const sim = getSimulator();
    return {
      scenarios: sim.listScenarios().map((s) => ({ id: s.id, name: s.name, description: s.description, entityCount: s.entities.length, eventCount: s.eventSequence.length })),
      stats: sim.getStats(),
    };
  });
}

export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { scenarioId?: string; config?: Record<string, unknown> };
    if (!body.scenarioId) throw new Error("scenarioId required");
    const result = await getSimulator().run(body.scenarioId as never, body.config as never);
    return { simulationId: result.id, eventsFired: result.eventsFired, errors: result.errors, durationMs: result.durationMs, stateSnapshot: result.stateSnapshot };
  });
}
