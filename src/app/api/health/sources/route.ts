import { withPlatform, getHealthSources, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const sources = getHealthSources();
    return {
      sources: sources.list().map((s) => ({
        id: s.id, type: s.type, label: s.label, trustLevel: s.trustLevel,
        verified: s.verified, deviceModel: s.deviceModel, orgId: s.orgId,
      })),
      types: sources.listTypes(),
    };
  });
}
