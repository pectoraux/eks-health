import { withPlatform, getMonitoring, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return {
      incidents: getMonitoring().listIncidents(),
      openCount: getMonitoring().listIncidents().filter((i) => i.status === "open" || i.status === "investigating").length,
    };
  });
}

// Acknowledge / resolve an incident
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { incidentId?: string; action?: "acknowledge" | "resolve"; by?: string; resolution?: string };
    if (!body.incidentId || !body.action) throw new Error("incidentId, action required");
    if (body.action === "acknowledge") {
      getMonitoring().acknowledgeIncident(body.incidentId as never, body.by ?? "system");
    } else {
      getMonitoring().resolveIncident(body.incidentId as never, body.resolution ?? "resolved");
    }
    return { incidentId: body.incidentId, action: body.action };
  });
}
