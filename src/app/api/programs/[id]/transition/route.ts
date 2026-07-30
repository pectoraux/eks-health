import { withPlatform, getProgramRegistry, ensurePlatform } from "@/lib/platform-server";
import { ProgramError, type ProgramState } from "@/programs";

export const dynamic = "force-dynamic";

export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withPlatform(async () => {
    ensurePlatform();
    const { id } = await params;
    const body = await req.json() as { to?: string };
    if (!body.to) throw new ProgramError({ code: "eks.program.transition.missing", category: "validation", message: "to required" });
    const record = getProgramRegistry().transition(id as never, body.to as ProgramState);
    return { programId: record.id, state: record.state };
  });
}
