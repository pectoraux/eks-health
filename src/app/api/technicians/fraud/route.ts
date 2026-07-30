import { withPlatform, getFraudDetection, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const fraud = getFraudDetection();
    return {
      stats: fraud.getStats(),
      alerts: fraud.listAlerts({}).slice(0, 30).map((a) => ({
        id: a.id, type: a.type, severity: a.severity, status: a.status,
        detectedAt: a.detectedAt, technicianId: a.technicianId,
      })),
    };
  });
}
