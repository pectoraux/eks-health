import { withPlatform, getProgramCapabilities, ensurePlatform } from "@/lib/platform-server";
import { listCapabilities } from "@/programs";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    return {
      catalog: listCapabilities(),
      grants: getProgramCapabilities().listGrants(),
    };
  });
}
