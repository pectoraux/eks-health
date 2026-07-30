import { withPlatform, getConsent, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

// Grant consent (user approves a purpose request)
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      consentId?: string;
      approvedFields?: string[];
      deniedFields?: string[];
      durationDays?: number;
    };
    if (!body.consentId || !body.approvedFields) throw new Error("consentId, approvedFields required");
    const consent = getConsent().grant(
      body.consentId as never,
      body.approvedFields,
      body.deniedFields ?? [],
      body.durationDays ? body.durationDays * 24 * 60 * 60 * 1000 : undefined,
    );
    return { consentId: consent.id, status: consent.status, receiptId: consent.receiptId };
  });
}
