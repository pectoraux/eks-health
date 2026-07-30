import { withPlatform, getHealthProfiles, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return getHealthProfiles().list().map((p) => ({
      id: p.id, accountId: p.accountId, programCount: p.programs.length,
      deviceCount: p.devices.length, customAttributeCount: Object.keys(p.customAttributes).length,
      createdAt: p.createdAt,
    }));
  });
}
