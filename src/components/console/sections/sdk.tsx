"use client";

import { useState } from "react";
import { Code2, FileCode, Terminal, Sparkles } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, CodeBlock } from "../primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiPost, type PlatformSnapshot } from "@/hooks/use-platform";
import { toast } from "sonner";

export function SdkSection({ data }: { data: PlatformSnapshot }) {
  const sdk = (data.programs as { sdk?: { templates?: Array<{ id: string; name: string; description: string }>; cliCommands?: Array<{ id: string; name: string; description: string; usage: string }> } }).sdk ?? {};
  const templates = sdk.templates ?? [];
  const cliCommands = sdk.cliCommands ?? [];
  const dependencies = (data.programs as { dependencies?: { libraries?: Array<{ name: string; versions: string[] }> } }).dependencies ?? {};
  const libraries = dependencies.libraries ?? [];

  const [slug, setSlug] = useState("my-health-program");
  const [name, setName] = useState("My Health Program");
  const [template, setTemplate] = useState("blank-program");
  const [scaffoldResult, setScaffoldResult] = useState<{ files: Array<{ path: string; contentPreview: string }>; fileCount: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function scaffold() {
    setBusy(true);
    const res = await apiPost<{ files: Array<{ path: string; contentPreview: string }>; fileCount: number; manifestSlug: string }>("/api/programs/sdk/scaffold", { template, slug, name });
    setBusy(false);
    if (res.ok && res.data) {
      setScaffoldResult(res.data);
      toast.success(`Scaffolded ${res.data.fileCount} files`, { description: `Manifest slug: ${res.data.manifestSlug}` });
    } else {
      toast.error("Scaffold failed", { description: res.error?.message });
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Developer SDK"
        subtitle="One-command project creation, manifest generation, packaging, signing, contract validation, local simulation, docs generation, upgrade validation. Building Programs should feel delightful."
        icon={<Code2 className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Scaffold Templates" value={templates.length} accent />
        <StatCard label="CLI Commands" value={cliCommands.length} />
        <StatCard label="Shared Libraries" value={libraries.length} />
        <StatCard label="Signing" value="RSA-256" hint="real crypto" />
      </div>

      <Panel title="Project Scaffolding (live)">
        <p className="text-xs text-muted-foreground mb-3">Generate a real Program project structure — manifest, entry point, tests, README.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Template</label>
            <select className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Slug</label>
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-program" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Program" />
          </div>
        </div>
        <Button onClick={scaffold} disabled={busy}><Sparkles className="h-4 w-4 mr-1.5" />{busy ? "Scaffolding…" : "Scaffold project"}</Button>
        {scaffoldResult && (
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2">
              <FileCode className="h-4 w-4 text-[var(--brand)]" />
              <span className="text-sm font-medium">{scaffoldResult.fileCount} files generated</span>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-y-auto eks-scroll">
              {scaffoldResult.files.map((f) => (
                <div key={f.path} className="rounded-md border border-border/40 p-2">
                  <Mono className="text-[var(--brand)] text-[10px]">{f.path}</Mono>
                  <CodeBlock className="mt-1 text-[10px]">{f.contentPreview}</CodeBlock>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Scaffold Templates">
          <div className="space-y-2">
            {templates.map((t) => (
              <div key={t.id} className="rounded-md border border-border/60 p-2.5">
                <div className="flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-[var(--brand)]" />
                  <span className="text-sm font-medium">{t.name}</span>
                  <Mono className="text-[10px] text-muted-foreground ml-auto">{t.id}</Mono>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="CLI Commands">
          <div className="space-y-1.5 max-h-72 overflow-y-auto eks-scroll">
            {cliCommands.map((c) => (
              <div key={c.id} className="rounded-md border border-border/40 p-2">
                <div className="flex items-center gap-2">
                  <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                  <Mono className="text-xs text-[var(--brand)]">eks {c.name}</Mono>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">{c.description}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Shared Libraries">
        <p className="text-xs text-muted-foreground mb-2">Versioned shared components Programs may depend on, with real semver range resolution.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {libraries.map((l) => (
            <div key={l.name} className="rounded-md border border-border/60 p-2.5">
              <Mono className="text-xs text-[var(--brand)]">{l.name}</Mono>
              <div className="flex flex-wrap gap-1 mt-1.5">
                {l.versions.map((v) => <Badge key={v} variant="outline" className="text-[10px] font-mono">{v}</Badge>)}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
