import { withPlatform, getHealthSchemas, ensurePlatform, ensureHydrated } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    return getHealthSchemas().list().map((s) => ({
      id: s.id, slug: s.slug, name: s.name, category: s.category,
      valueType: s.valueType, programId: s.programId, allowedUnits: s.allowedUnits,
      allowedSources: s.allowedSources, verificationRequired: s.verificationWorkflow.required,
      visibility: s.visibility, tags: s.tags, isComposite: !!s.compositeComponents,
      derivedFrom: s.derivedFrom, createdAt: s.createdAt,
    }));
  });
}
