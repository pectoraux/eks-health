import { withPlatform, getFunding, ensurePlatform, ensureHydrated } from "@/lib/platform-server";
export const dynamic = "force-dynamic";
export function GET() {
  return withPlatform(async () => {
    ensurePlatform();
    await ensureHydrated();
    const funding = getFunding();
    const requests = funding.listRequests();
    const policies = funding.listPolicies();
    return {
      requests: requests.slice(0, 50).map((r) => ({
        id: r.id, orgId: r.orgId, programId: r.programId,
        amount: r.amount, currency: r.currency, status: r.status,
        requestedAt: r.requestedAt, processedAt: r.processedAt,
      })),
      policies: policies.slice(0, 20).map((p) => ({
        id: p.id, orgId: p.orgId, name: p.name, type: p.type,
        allocation: p.allocation, currency: p.currency, active: p.active,
      })),
      stats: funding.getStats(),
    };
  });
}
