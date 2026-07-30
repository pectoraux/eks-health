import { withPlatform, getCertification, ensurePlatform } from "@/lib/platform-server";
import { ProgramError } from "@/programs";

export const dynamic = "force-dynamic";

export function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const registry = (await import("@/programs")).getRegistry();
    const record = registry.get(id as never);
    if (!record) throw new ProgramError({ code: "eks.program.not_found", category: "not_found", message: "Not found" });
    const version = record.versions.find((v) => v.id === record.currentVersionId) ?? record.versions[0];
    if (!version) throw new ProgramError({ code: "eks.program.version.none", category: "not_found", message: "No versions" });
    registry.transition(record.id, "in_review");
    const run = await getCertification().run(version.manifest, version.id);
    if (run.status === "passed") {
      registry.transition(record.id, "certified");
    }
    return {
      runId: run.id, status: run.status,
      passed: run.checks.filter((c) => c.result === "pass").length,
      failed: run.checks.filter((c) => c.result === "fail").length,
      warned: run.checks.filter((c) => c.result === "warn").length,
      checks: run.checks.map((c) => ({ rule: c.ruleId, category: c.category, result: c.result, message: c.message })),
    };
  });
}
