import { withPlatform, getCompliance, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const url = new URL(req.url);
    const frameworkId = url.searchParams.get("framework");
    if (frameworkId) {
      return getCompliance().generateReport(frameworkId as never);
    }
    return getCompliance().listFrameworks();
  });
}
