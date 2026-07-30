import { withPlatform, getCli, ensurePlatform } from "@/lib/platform-server";

export const dynamic = "force-dynamic";

export function GET() {
  return withPlatform(() => {
    ensurePlatform();
    const cli = getCli();
    return {
      commands: cli.listCommands().map((c) => ({ name: c.name, description: c.description, category: c.category, usage: c.usage, args: c.args, options: c.options, examples: c.examples })),
      stats: cli.getStats(),
    };
  });
}

export function POST(req: Request) {
  return withPlatform(async () => {
    ensurePlatform();
    const body = await req.json() as { command?: string; args?: Record<string, string>; options?: Record<string, unknown> };
    if (!body.command) throw new Error("command required");
    const invocation = await getCli().execute(body.command as never, body.args ?? {}, body.options ?? {});
    return { id: invocation.id, exitCode: invocation.exitCode, stdout: invocation.stdout, stderr: invocation.stderr, durationMs: invocation.durationMs };
  });
}
