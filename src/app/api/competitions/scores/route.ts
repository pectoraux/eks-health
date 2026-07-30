import { withPlatform, getScoreCompiler, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const scoring = getScoreCompiler();
    return {
      specs: scoring.listSpecs().map((s) => ({
        id: s.id, name: s.name, description: s.description, version: s.version,
        componentCount: s.components.length, totalWeight: s.totalWeight,
        components: s.components.map((c) => ({ name: c.name, weight: c.weight, type: c.type, aggregation: c.aggregation })),
      })),
    };
  });
}
