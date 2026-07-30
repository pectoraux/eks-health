import { withPlatform, getConsent, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const url = new URL(req.url);
    const accountId = url.searchParams.get("accountId");
    const programId = url.searchParams.get("programId");
    if (accountId) {
      return getConsent().getActiveConsents(accountId as never, programId ?? undefined);
    }
    return { message: "Provide ?accountId= to list consents" };
  });
}

// Request consent (program asks for fields for a purpose)
export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as {
      accountId?: string;
      programId?: string;
      purpose?: string;
      requestedFields?: string[];
      optionalFields?: string[];
    };
    if (!body.accountId || !body.programId || !body.purpose || !body.requestedFields) {
      throw new Error("accountId, programId, purpose, requestedFields required");
    }
    const consent = getConsent().requestConsent(body.accountId as never, {
      purpose: body.purpose,
      requestedFields: body.requestedFields,
      optionalFields: body.optionalFields ?? [],
      deniedFields: [],
    }, body.programId);
    return { consentId: consent.id, status: consent.status, purpose: body.purpose };
  });
}
