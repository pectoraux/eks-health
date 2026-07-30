import { withPlatform, platformSnapshot } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => platformSnapshot());
}
