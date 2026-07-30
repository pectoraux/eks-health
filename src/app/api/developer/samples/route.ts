import { withPlatform, getSampleLibrary, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return getSampleLibrary().list().map((s) => ({
      id: s.id, slug: s.slug, name: s.name, category: s.category,
      difficulty: s.difficulty, features: s.features, estimatedSetupMinutes: s.estimatedSetupMinutes,
    }));
  });
}
