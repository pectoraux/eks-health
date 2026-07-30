import { withPlatform, getAudit, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const url = new URL(req.url);
    const category = url.searchParams.get("category") as never;
    const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
    const entries = getAudit().query({
      category: category ?? undefined,
    });
    return {
      counts: getAudit().countByCategory(),
      chainValid: getAudit().verifyChain().valid,
      entries: entries.slice(-limit),
    };
  });
}
