import { withPlatform, getHealthMeasurements, getHealthSources, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const url = new URL(req.url);
    const profileId = url.searchParams.get("profileId") ?? undefined;
    const schemaId = url.searchParams.get("schemaId") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const measurements = getHealthMeasurements();
    return {
      stats: measurements.getStats(profileId as never | undefined),
      recent: measurements.list({ profileId: profileId as never | undefined, schemaId: schemaId as never | undefined, limit }).map((m) => measurements.toRecord(m)),
    };
  });
}

export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      schemaId?: string; profileId?: string; value?: unknown; unitId?: string;
      sourceId?: string; collectedBy?: string; tags?: string[];
    };
    if (!body.schemaId || !body.profileId || body.value === undefined || !body.unitId) {
      throw new Error("schemaId, profileId, value, unitId required");
    }
    // If no sourceId provided, or sourceId doesn't exist, use the first available source
    let sourceId = body.sourceId;
    if (!sourceId) {
      const sources = getHealthSources().list();
      if (sources.length > 0) {
        sourceId = sources[0].id;
      }
    }
    if (!sourceId) {
      throw new Error("No measurement source available. Ensure health platform is seeded.");
    }
    const measurements = getHealthMeasurements();
    const m = measurements.record({
      schemaId: body.schemaId as never,
      profileId: body.profileId as never,
      value: body.value as never,
      unitId: body.unitId as never,
      sourceId: sourceId as never,
      provenance: {
        collectedBy: body.collectedBy as never,
        sourceId: sourceId as never,
        collectedAt: new Date().toISOString(),
        verificationHistory: [],
      },
      tags: body.tags,
    });
    return { measurementId: m.id, verificationState: m.verificationState };
  });
}
