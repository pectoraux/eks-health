import { NextRequest, NextResponse } from "next/server";
import { ensurePlatform, ensureHydrated, getListingRegistry } from "@/lib/platform-server";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensurePlatform();
  await ensureHydrated();
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: { message: "Not authenticated" } }, { status: 401 });

  const { id } = await params;
  const profiles = getListingRegistry();
  const listing = profiles.get(id as never);
  if (!listing) return NextResponse.json({ ok: false, error: { message: "Listing not found" } }, { status: 404 });
  if (listing.status !== "published") return NextResponse.json({ ok: false, error: { message: "Listing not available" } }, { status: 400 });

  // Increment install count (simulates installation)
  profiles.incrementInstall(id as never);

  return NextResponse.json({
    ok: true,
    data: {
      listingId: id,
      programId: listing.programId,
      installCount: listing.installCount + 1,
      message: "Program installed successfully",
    },
  });
}
