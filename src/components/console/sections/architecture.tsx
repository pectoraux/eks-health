"use client";

import { Network } from "lucide-react";
import { SectionHeader, Panel, Mono } from "../primitives";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import type { PlatformSnapshot } from "@/hooks/use-platform";

export function ArchitectureSection({ data }: { data: PlatformSnapshot }) {
  const kernel = data.kernel as Record<string, unknown>;
  const contexts = (kernel.contexts as Array<{
    id: string; name: string; description: string;
    ubiquitousLanguage: { term: string; definition: string }[];
    aggregates: string[]; entities: string[]; valueObjects: string[]; domainEvents: string[];
    domainServices: string[]; policies: string[]; owner: string;
  }>) ?? [];
  const eventCatalog = (kernel.eventCatalog as Array<{
    type: string; kind: string; producer: string; consumers: string[];
    schemaVersion: number; description: string; retryable: boolean; ordered: boolean;
  }>) ?? [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Architecture & Domain Model"
        subtitle="Bounded contexts, ubiquitous language, aggregates, domain events, and the integration event catalog. DDD with clean separation — no infrastructure leaking into business logic."
        icon={<Network className="h-5 w-5" />}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Panel><div className="text-center"><p className="text-2xl font-semibold text-[var(--brand)]">{contexts.length}</p><p className="text-xs text-muted-foreground mt-1">bounded contexts</p></div></Panel>
        <Panel><div className="text-center"><p className="text-2xl font-semibold">{eventCatalog.length}</p><p className="text-xs text-muted-foreground mt-1">cataloged events</p></div></Panel>
        <Panel><div className="text-center"><p className="text-2xl font-semibold">{contexts.reduce((a, c) => a + c.aggregates.length, 0)}</p><p className="text-xs text-muted-foreground mt-1">aggregates</p></div></Panel>
        <Panel><div className="text-center"><p className="text-2xl font-semibold">{contexts.reduce((a, c) => a + c.policies.length, 0)}</p><p className="text-xs text-muted-foreground mt-1">domain policies</p></div></Panel>
      </div>

      <Panel title="Bounded Contexts (Domain-Driven Design)">
        <Accordion type="single" collapsible className="w-full">
          {contexts.map((ctx) => (
            <AccordionItem key={ctx.id} value={ctx.id}>
              <AccordionTrigger className="hover:no-underline">
                <div className="flex items-center gap-3 text-left">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--brand-muted)] text-[var(--brand)] text-xs font-mono uppercase">
                    {ctx.id.slice(0, 2)}
                  </div>
                  <div>
                    <p className="text-sm font-medium">{ctx.name}</p>
                    <p className="text-xs text-muted-foreground">owner: {ctx.owner}</p>
                  </div>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pb-4">
                <p className="text-sm text-muted-foreground">{ctx.description}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <DomainGroup title="Aggregates" items={ctx.aggregates} accent />
                  <DomainGroup title="Entities" items={ctx.entities} />
                  <DomainGroup title="Value Objects" items={ctx.valueObjects} />
                  <DomainGroup title="Domain Services" items={ctx.domainServices} />
                  <DomainGroup title="Domain Events" items={ctx.domainEvents} />
                  <DomainGroup title="Policies" items={ctx.policies} />
                </div>
                {ctx.ubiquitousLanguage.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Ubiquitous Language</p>
                    <div className="space-y-1">
                      {ctx.ubiquitousLanguage.map((t) => (
                        <div key={t.term} className="flex gap-2 text-xs">
                          <Mono className="text-[var(--brand)] shrink-0">{t.term}</Mono>
                          <span className="text-muted-foreground">— {t.definition}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Panel>

      <Panel title="Integration Event Catalog">
        <div className="max-h-96 overflow-y-auto eks-scroll space-y-2">
          {eventCatalog.map((e) => (
            <div key={e.type} className="rounded-md border border-border/60 p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <Mono className="text-[var(--brand)]">{e.type}</Mono>
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{e.kind}</span>
                  {e.retryable && <span className="rounded bg-[var(--brand-muted)] px-1.5 py-0.5 text-[10px] text-[var(--brand)]">retryable</span>}
                  {e.ordered && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">ordered</span>}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{e.description}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground">
                <span>producer: <Mono>{e.producer}</Mono></span>
                <span>consumers: {e.consumers.length > 0 ? e.consumers.join(", ") : "—"}</span>
                <span>v{e.schemaVersion}</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function DomainGroup({ title, items, accent }: { title: string; items: string[]; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{title}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">reserved</p>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((i) => (
            <span key={i} className={`rounded px-1.5 py-0.5 text-[11px] font-mono ${accent ? "bg-[var(--brand-muted)] text-[var(--brand)]" : "bg-muted"}`}>{i}</span>
          ))}
        </div>
      )}
    </div>
  );
}
