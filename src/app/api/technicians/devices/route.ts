import { withPlatform, getDeviceRegistry, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const devices = getDeviceRegistry();
    return {
      devices: devices.list().map((d) => ({
        id: d.id, serialNumber: d.serialNumber, model: d.model, manufacturer: d.manufacturer,
        type: d.type, trustLevel: d.trustLevel, status: d.status, certified: d.certified,
        firmwareVersion: d.firmwareVersion, lastCalibratedAt: d.lastCalibratedAt,
      })),
    };
  });
}
