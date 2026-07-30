"use client";

import { useState } from "react";
import { Terminal, Play, Package, FlaskConical, Bug, Eye, Code2, BookOpen, Boxes, Zap } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, CodeBlock } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function DeveloperSection({ data }: { data: PlatformSnapshot }) {
  const dev = (data.developer as {
    cli?: { commands?: Array<{ name: string; description: string; category: string; usage: string }>; stats?: { total?: number; byCommand?: Record<string, number>; successRate?: number } };
    simulator?: { scenarios?: Array<{ id: string; name: string; description: string; entityCount: number; eventCount: number }>; stats?: { totalRuns?: number; totalEvents?: number; totalErrors?: number; avgDurationMs?: number } };
    designer?: { templates?: Array<{ type: string; name: string; description: string }>; stats?: { totalProjects?: number; totalElements?: number } };
    workflowBuilder?: { nodeKinds?: Array<{ kind: string; label: string; description: string }>; specs?: Array<{ id: string; name: string; nodeCount: number; edgeCount: number; version: number }>; stats?: { totalSpecs?: number; totalNodes?: number; totalEdges?: number } };
    apiExplorer?: { endpoints?: Array<{ id: string; path: string; method: string; description: string; category: string }>; categories?: Array<{ category: string; count: number }>; stats?: { totalEndpoints?: number; totalExecutions?: number } };
    docs?: { stats?: { totalBuilds?: number; totalPages?: number } };
    samples?: { programs?: Array<{ id: string; slug: string; name: string; category: string; difficulty: string; features: string[]; estimatedSetupMinutes: number }>; stats?: { totalSamples?: number; byCategory?: Record<string, number> } };
  }) ?? {};
  const cli = dev.cli ?? {};
  const sim = dev.simulator ?? {};
  const designer = dev.designer ?? {};
  const wf = dev.workflowBuilder ?? {};
  const api = dev.apiExplorer ?? {};
  const docs = dev.docs ?? {};
  const samples = dev.samples ?? {};

  const [cliOutput, setCliOutput] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function runCli(command: string) {
    setBusy(true);
    setCliOutput(null);
    const res = await apiPost<{ stdout: string[]; exitCode: number; durationMs?: number }>("/api/developer/cli", { command, args: {}, options: {} });
    setBusy(false);
    if (res.ok && res.data) {
      setCliOutput(res.data.stdout);
      toast.success(`eks ${command} completed`, { description: `Exit code: ${res.data.exitCode} in ${res.data.durationMs ?? 0}ms` });
    } else {
      toast.error("CLI failed", { description: res.error?.message });
    }
  }

  async function runSimulation(scenarioId: string) {
    setBusy(true);
    const res = await apiPost<{ simulationId: string; eventsFired: number; errors: string[]; durationMs?: number }>("/api/developer/simulator", { scenarioId });
    setBusy(false);
    if (res.ok && res.data) {
      toast.success(`Simulation complete`, { description: `${res.data.eventsFired} events fired in ${res.data.durationMs ?? 0}ms` });
    } else {
      toast.error("Simulation failed", { description: res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Developer Platform"
        subtitle="The world's best developer experience for preventive health. CLI, local simulator, visual designers, AI workflow builder, debugger, inspector, API explorer, docs generator, and sample programs. Developers only implement their health methodology — the platform provides everything else."
        icon={<Terminal className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="CLI Commands" value={cli.commands?.length ?? 0} accent />
        <StatCard label="Sim Scenarios" value={sim.scenarios?.length ?? 0} />
        <StatCard label="API Endpoints" value={api.endpoints?.length ?? 0} hint="explorable" />
        <StatCard label="Sample Programs" value={samples.programs?.length ?? 0} hint="reference impls" />
      </div>

      <Panel title="Developer CLI (interactive)">
        <p className="text-xs text-muted-foreground mb-3">Try real CLI commands — they produce real output from the platform:</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {["new-program", "dev", "simulate", "package", "validate", "test", "certify", "inspect", "doctor", "docs", "whoami"].map((cmd) => (
            <Button key={cmd} size="sm" variant="outline" onClick={() => runCli(cmd)} disabled={busy}>
              <Terminal className="h-3 w-3 mr-1" />eks {cmd}
            </Button>
          ))}
        </div>
        {cliOutput && (
          <div className="rounded-md bg-muted/50 p-3 max-h-64 overflow-y-auto eks-scroll">
            {cliOutput.map((line, i) => (
              <p key={i} className={`text-xs font-mono ${line.startsWith("✓") ? "text-[var(--brand)]" : line.startsWith("$") ? "text-foreground font-medium" : "text-muted-foreground"}`}>{line}</p>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Simulation Scenarios">
        <div className="space-y-2">
          {(sim.scenarios ?? []).map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded-md border border-border/60 p-3">
              <div className="flex items-center gap-2.5">
                <FlaskConical className="h-4 w-4 text-[var(--brand)]" />
                <div>
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{s.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge variant="outline" className="text-[10px]">{s.entityCount} entities</Badge>
                    <Badge variant="outline" className="text-[10px]">{s.eventCount} events</Badge>
                  </div>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => runSimulation(s.id)} disabled={busy}>
                <Play className="h-3 w-3 mr-1" />Run
              </Button>
            </div>
          ))}
        </div>
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Visual Designer">
          <p className="text-xs text-muted-foreground mb-2">Low-code visual editor for all platform concepts:</p>
          <div className="flex flex-wrap gap-1.5">
            {(designer.templates ?? []).map((t) => (
              <Badge key={t.type} variant="outline" className="text-[10px] font-mono">{t.type}</Badge>
            ))}
          </div>
        </Panel>

        <Panel title="AI Workflow Builder">
          <p className="text-xs text-muted-foreground mb-2">Visual orchestration with {wf.nodeKinds?.length ?? 0} node types:</p>
          <div className="flex flex-wrap gap-1.5">
            {(wf.nodeKinds ?? []).map((k) => (
              <Badge key={k.kind} variant="outline" className="text-[10px] font-mono">{k.kind}</Badge>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="API Explorer">
        <p className="text-xs text-muted-foreground mb-2">{api.endpoints?.length ?? 0} endpoints across {api.categories?.length ?? 0} categories:</p>
        <div className="max-h-64 overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Method</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="pr-4">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(api.endpoints ?? []).slice(0, 20).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="pl-4"><Badge variant={e.method === "GET" ? "secondary" : "default"} className="text-[10px] font-mono">{e.method}</Badge></TableCell>
                  <TableCell><Mono className="text-xs">{e.path}</Mono></TableCell>
                  <TableCell><span className="text-xs font-mono text-muted-foreground">{e.category}</span></TableCell>
                  <TableCell className="pr-4 text-xs">{e.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <Panel title="Sample Programs">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {(samples.programs ?? []).map((s) => (
            <div key={s.id} className="rounded-md border border-border/60 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{s.name}</p>
                <Badge variant={s.difficulty === "beginner" ? "default" : s.difficulty === "intermediate" ? "secondary" : "destructive"} className="text-[10px]">{s.difficulty}</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{s.category}</p>
              <p className="text-[10px] text-muted-foreground mt-1">~{s.estimatedSetupMinutes} min setup</p>
              <div className="flex flex-wrap gap-0.5 mt-1.5">
                {s.features.slice(0, 2).map((f) => <Mono key={f} className="text-[10px] text-muted-foreground">{f}</Mono>)}
                {s.features.length > 2 && <Mono className="text-[10px] text-muted-foreground">+{s.features.length - 2}</Mono>}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Developer Platform Capabilities">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {[
            { icon: <Terminal className="h-4 w-4" />, name: "CLI", desc: "20 commands: new-program, dev, simulate, package, certify, publish" },
            { icon: <FlaskConical className="h-4 w-4" />, name: "Simulator", desc: "5 scenarios: competition-flow, offline-sync, large-scale, network-failure, AI-workflow" },
            { icon: <Code2 className="h-4 w-4" />, name: "Visual Designer", desc: "13 element types: schemas, missions, competitions, scores, leaderboards" },
            { icon: <Zap className="h-4 w-4" />, name: "Workflow Builder", desc: "13 node kinds: AI prompt, tool, conditional, parallel, retrieval, memory" },
            { icon: <Bug className="h-4 w-4" />, name: "Debugger", desc: "Event timeline, API traces, permission/consent inspection, replay" },
            { icon: <Eye className="h-4 w-4" />, name: "Inspector", desc: "Health, performance, resource usage, security issues, upgrade readiness" },
            { icon: <Package className="h-4 w-4" />, name: "API Explorer", desc: "20 endpoints, schema browsing, request replay, SDK examples" },
            { icon: <BookOpen className="h-4 w-4" />, name: "Docs Generator", desc: "Auto-generated: API reference, SDK guide, event catalog, migration" },
            { icon: <Boxes className="h-4 w-4" />, name: "Sample Programs", desc: "8 reference implementations: weight, BP, diabetes, sleep, mental, cardio, nutrition, habits" },
          ].map((c) => (
            <div key={c.name} className="flex items-start gap-2.5 rounded-md border border-border/40 p-2.5">
              <div className="text-[var(--brand)] mt-0.5">{c.icon}</div>
              <div>
                <p className="text-xs font-medium">{c.name}</p>
                <p className="text-[11px] text-muted-foreground">{c.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
