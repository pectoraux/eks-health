import { withPlatform, getSdk, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const sdk = getSdk();
    return {
      templates: sdk.listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description })),
      cliCommands: sdk.listCliCommands().map((c) => ({ id: c.id, name: c.name, description: c.description, usage: c.usage })),
    };
  });
}

export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { template?: string; slug?: string; name?: string; developerName?: string; developerEmail?: string };
    if (!body.template || !body.slug || !body.name) {
      throw new Error("template, slug, name required");
    }
    const sdk = getSdk();
    const result = sdk.scaffold({
      templateId: body.template,
      slug: body.slug,
      name: body.name,
      developerId: "dev_demo_1",
      developerName: body.developerName ?? "Demo Developer",
      developerEmail: body.developerEmail ?? "dev@eks.health",
    });
    return {
      files: result.project.files.map((f) => ({ path: f.path, contentPreview: f.content.slice(0, 200) })),
      fileCount: result.project.files.length,
      manifestSlug: result.manifest.slug,
    };
  });
}
