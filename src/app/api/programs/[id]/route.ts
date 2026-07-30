import { withPlatform, getProgramRegistry, ensurePlatform } from "@/lib/platform-server";
import { ProgramError } from "@/programs";

export const dynamic = "force-dynamic";

export function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const record = getProgramRegistry().get(id as never);
    if (!record) throw new ProgramError({ code: "eks.program.not_found", category: "not_found", message: "Not found" });
    return {
      ...record,
      versions: record.versions.map((v) => ({
        id: v.id, version: `${v.version.major}.${v.version.minor}.${v.version.patch}`,
        channel: v.channel, certified: v.certified, fingerprint: v.fingerprint.slice(0, 16),
        createdAt: v.createdAt, releaseNotes: v.releaseNotes,
        capabilities: v.manifest.capabilities.map((c) => c.capability),
        resourceLimits: v.manifest.resourceLimits,
        privacy: v.manifest.privacy,
        aiUsage: v.manifest.aiUsage,
      })),
      effectiveQuota: getProgramRegistry().getEffectiveQuota(record.id),
    };
  });
}
