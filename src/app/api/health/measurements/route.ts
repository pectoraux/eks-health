import { withPlatform, getHealthMeasurements, ensurePlatform } from "@/lib/platform-server";

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
    if (!body.schemaId || !body.profileId || body.value === undefined || !body.unitId || !body.sourceId) {
      throw new Error("schemaId, profileId, value, unitId, sourceId required");
    }
    const measurements = getHealthMeasurements();
    const m = measurements.record({
      schemaId: body.schemaId as never,
      profileId: body.profileId as never,
      value: body.value as never,
      unitId: body.unitId as never,
      sourceId: body.sourceId as never,
      provenance: {
        collectedBy: body.collectedBy as never,
        sourceId: body.sourceId as never,
        collectedAt: new Date().toISOString(),
        verificationHistory: [],
      },
      tags: body.tags,
    });
    return { measurementId: m.id, verificationState: m.verificationState };
  });
}
