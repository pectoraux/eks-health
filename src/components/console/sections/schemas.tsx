"use client";

import { Database } from "lucide-react";
import { SectionHeader, Panel, Mono, StatCard, StateBadge } from "../primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function SchemasSection({ data }: { data: PlatformSnapshot }) {
  const health = (data.health as Record<string, unknown>) ?? {};
  const schemas = (health.schemas as Array<{
    id: string; slug: string; name: string; category: string; valueType: string;
    programId: string; unitCount: number; allowedSources: string[];
    verificationRequired: boolean; visibility: string; tags: string[];
    derivedFrom?: string[]; isComposite?: boolean; createdAt: string;
  }>) ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Measurement Schemas"
        subtitle="Programs define measurement schemas (name, units, validation, ranges, precision, sources, evidence, verification, visibility, retention, versioning). The platform validates and stores them. No hardcoded measurement types — Programs introduce everything."
        icon={<Database className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Total Schemas" value={schemas.length} accent />
        <StatCard label="Composite" value={schemas.filter((s) => s.isComposite).length} />
        <StatCard label="Derived" value={schemas.filter((s) => s.derivedFrom && s.derivedFrom.length > 0).length} />
        <StatCard label="Verification Required" value={schemas.filter((s) => s.verificationRequired).length} />
      </div>

      <Panel title="Schema Registry">
        <div className="max-h-[32rem] overflow-y-auto eks-scroll -mx-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Schema</TableHead>
                <TableHead>Value Type</TableHead>
                <TableHead>Units</TableHead>
                <TableHead>Sources</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead className="pr-4">Tags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schemas.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium text-sm">{s.name}</div>
                    <Mono className="text-muted-foreground">{s.slug}</Mono>
                    <Mono className="text-[10px] text-muted-foreground block">{s.programId.slice(0, 20)}…</Mono>
                  </TableCell>
                  <TableCell><Mono className="text-xs">{s.valueType}</Mono></TableCell>
                  <TableCell><Mono className="text-xs">{s.unitCount}</Mono></TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-0.5">
                      {s.allowedSources.slice(0, 2).map((src) => (
                        <Mono key={src} className="text-[10px] text-muted-foreground">{src}</Mono>
                      ))}
                      {s.allowedSources.length > 2 && <Mono className="text-[10px] text-muted-foreground">+{s.allowedSources.length - 2}</Mono>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {s.verificationRequired ? <span className="text-xs text-[var(--brand)]">required</span> : <span className="text-xs text-muted-foreground">optional</span>}
                  </TableCell>
                  <TableCell><StateBadge state={s.visibility} map={{ private: "secondary", program: "default", technician: "default", organization: "default", research_anonymized: "secondary", public: "default" }} /></TableCell>
                  <TableCell className="pr-4">
                    <div className="flex flex-wrap gap-0.5">
                      {s.tags.slice(0, 2).map((t) => (
                        <Mono key={t} className="text-[10px] text-muted-foreground">{t}</Mono>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
    </div>
  );
}
