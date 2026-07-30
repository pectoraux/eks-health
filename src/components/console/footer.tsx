"use client";

import { useTheme } from "next-themes";

interface SnapshotMeta {
  meta?: { kernel?: string; identity?: string; at?: string };
}

export function ConsoleFooter({ snapshot }: { snapshot: unknown }) {
  const meta = (snapshot as { meta?: { kernel?: string; identity?: string; programs?: string; health?: string; technicians?: string; at?: string } } | null)?.meta;
  return (
    <footer className="mt-auto border-t border-border bg-background/80 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)] animate-pulse" />
            <span className="font-mono">platform online</span>
          </span>
          {meta?.kernel && <span className="font-mono">kernel <span className="text-foreground">{meta.kernel}</span></span>}
          {meta?.identity && <span className="font-mono">identity <span className="text-foreground">{meta.identity}</span></span>}
          {meta?.programs && <span className="font-mono">programs <span className="text-foreground">{meta.programs}</span></span>}
          {meta?.health && <span className="font-mono">health <span className="text-foreground">{meta.health}</span></span>}
          {meta?.technicians && <span className="font-mono">technicians <span className="text-foreground">{meta.technicians}</span></span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono">region af-west-1</span>
          <span className="font-mono">tz Africa/Accra</span>
        </div>
      </div>
    </footer>
  );
}
