import { withPlatform, getCertification, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return {
      rules: getCertification().listRules().map((r) => ({ id: r.id, category: r.category, severity: r.severity, description: r.description })),
      runs: getCertification().listRuns().slice(-20).map((r) => ({
        id: r.id, programId: r.programId, versionId: r.versionId, status: r.status, startedAt: r.startedAt,
      })),
    };
  });
}
