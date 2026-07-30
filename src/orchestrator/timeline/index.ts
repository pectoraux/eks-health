/**
 * Eks-Health Health Orchestrator — Unified Timeline
 *
 * Every participant has ONE chronological experience that fuses measurements,
 * missions, competitions, rewards, appointments, research participation,
 * program installations, achievements, AI recommendations, health milestones,
 * technician visits, and orchestration events (merged missions, resolved
 * conflicts, shared measurements, unified goals). Programs contribute entries;
 * the orchestrator annotates them. The participant sees a single stream.
 *
 * Built on the Digital Twin, Health Context, and all prior milestones. Real
 * aggregation from the live platform subsystems (measurements / missions /
 * competitions / programs registry).
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type UnifiedTimelineId,
  type UnifiedTimeline,
  type UnifiedTimelineEntry,
  type TimelineEntryType,
  OrchestratorError,
  asUnifiedTimelineId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getMeasurements, asProfileId, type Measurement, type MeasurementFilter } from "@/health";
import { getMissions, type Mission } from "@/missions";
import { getCompetitions, type Competition } from "@/competitions";
import { getRegistry, type ProgramRecord } from "@/programs";

// ---------------------------------------------------------------------------
// Filter / pagination types
// ---------------------------------------------------------------------------

export interface TimelineFilter {
  readonly type?: TimelineEntryType;
  readonly source?: string;
  readonly programId?: ProgramId;
  readonly dateRange?: { from: string; to: string };
  readonly limit?: number;
  readonly offset?: number;
}

export interface TimelineStats {
  readonly totalTimelines: number;
  readonly totalEntries: number;
  readonly byType: Record<string, number>;
  readonly bySource: Record<string, number>;
}

export type TimelineExportFormat = "json" | "csv";

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class UnifiedTimelineManager {
  private readonly timelines = new Map<AccountId, UnifiedTimeline>();

  /** Get or create a participant's unified timeline. */
  getOrCreate(participantId: AccountId): UnifiedTimeline {
    let timeline = this.timelines.get(participantId);
    if (!timeline) {
      timeline = {
        id: asUnifiedTimelineId(generateId("utl_")),
        participantId,
        entries: [],
        lastUpdated: getClock().iso(),
      };
      this.timelines.set(participantId, timeline);
    }
    return timeline;
  }

  /** Add an entry to a participant's timeline. Inserts in chronological order. */
  addEntry(participantId: AccountId, entry: Omit<UnifiedTimelineEntry, "id">): UnifiedTimelineEntry {
    if (!entry.timestamp) {
      throw new OrchestratorError({
        code: "eks.orchestrator.timeline.missing_timestamp",
        category: "validation",
        message: "Timeline entry requires a timestamp.",
        userMessage: "Timeline entry is missing a timestamp.",
      });
    }
    if (!entry.type || !entry.title || !entry.source) {
      throw new OrchestratorError({
        code: "eks.orchestrator.timeline.missing_fields",
        category: "validation",
        message: "Timeline entry requires type, title, and source.",
        userMessage: "Timeline entry is missing required fields.",
      });
    }
    const timeline = this.getOrCreate(participantId);
    const full: UnifiedTimelineEntry = { ...entry, id: generateId("te_") };
    // Insert in chronological order (newest first by ISO timestamp desc).
    const entries = [...timeline.entries, full].sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    );
    this.timelines.set(participantId, {
      ...timeline,
      entries,
      lastUpdated: getClock().iso(),
    });
    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.timelineUpdated,
        { timelineId: timeline.id, participantId, entryId: full.id, type: full.type },
        {},
        "domain",
      ),
    );
    return full;
  }

  /** Filtered + paginated read of timeline entries. */
  get(participantId: AccountId, filter?: TimelineFilter): UnifiedTimelineEntry[] {
    const timeline = this.timelines.get(participantId);
    if (!timeline) return [];
    let list = [...timeline.entries];
    if (filter?.type) list = list.filter((e) => e.type === filter.type);
    if (filter?.source) list = list.filter((e) => e.source === filter.source);
    if (filter?.programId) list = list.filter((e) => e.programId === filter.programId);
    if (filter?.dateRange) {
      const { from, to } = filter.dateRange;
      list = list.filter((e) => e.timestamp >= from && e.timestamp <= to);
    }
    // Already sorted newest-first; preserve order through pagination.
    if (filter?.offset) list = list.slice(filter.offset);
    if (filter?.limit) list = list.slice(0, filter.limit);
    return list;
  }

  /** Entries for a specific calendar date (YYYY-MM-DD). */
  getByDate(participantId: AccountId, date: string): UnifiedTimelineEntry[] {
    const day = date.slice(0, 10);
    return this.get(participantId).filter((e) => e.timestamp.slice(0, 10) === day);
  }

  /** Most recent N entries. */
  getRecent(participantId: AccountId, limit: number): UnifiedTimelineEntry[] {
    return this.get(participantId, { limit: Math.max(0, limit) });
  }

  /** All known participant timelines (used by global analytics). */
  listTimelines(): UnifiedTimeline[] {
    return [...this.timelines.values()].sort((a, b) =>
      b.lastUpdated.localeCompare(a.lastUpdated),
    );
  }

  /** Every entry across every participant timeline (for global analytics). */
  getAllEntries(): UnifiedTimelineEntry[] {
    const all: UnifiedTimelineEntry[] = [];
    for (const t of this.timelines.values()) all.push(...t.entries);
    return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Entries contributed by a specific program. */
  getByProgram(participantId: AccountId, programId: ProgramId): UnifiedTimelineEntry[] {
    return this.get(participantId, { programId });
  }

  /** Entries of a specific type. */
  getByType(participantId: AccountId, type: TimelineEntryType): UnifiedTimelineEntry[] {
    return this.get(participantId, { type });
  }

  /** Case-insensitive text search across title, description, source. */
  search(participantId: AccountId, query: string): UnifiedTimelineEntry[] {
    if (!query) return [];
    const q = query.toLowerCase();
    return this.get(participantId).filter((e) => {
      const hay = `${e.title} ${e.description} ${e.source}`.toLowerCase();
      return hay.includes(q);
    });
  }

  /** Export a participant's timeline as JSON or CSV. */
  export(participantId: AccountId, format: TimelineExportFormat): string {
    const entries = this.get(participantId);
    if (format === "json") {
      return JSON.stringify(
        { participantId, exportedAt: getClock().iso(), entries },
        null,
        2,
      );
    }
    // CSV
    const header = [
      "id",
      "timestamp",
      "type",
      "source",
      "programId",
      "title",
      "description",
    ].join(",");
    const rows = entries.map((e) =>
      [
        csvCell(e.id),
        csvCell(e.timestamp),
        csvCell(e.type),
        csvCell(e.source),
        csvCell(e.programId ?? ""),
        csvCell(e.title),
        csvCell(e.description),
      ].join(","),
    );
    return [header, ...rows].join("\n");
  }

  /** Aggregate the participant's timeline from real platform data. */
  aggregateFromPlatform(participantId: AccountId): {
    readonly added: number;
    readonly sources: readonly string[];
  } {
    const sources: string[] = [];
    let added = 0;
    const seenIds = new Set<string>();

    // 1) Measurements (via @/health store). Guard with try/catch.
    try {
      const store = getMeasurements();
      // ProfileId is a separate branded id, but on this platform a
      // participant's account id is used as their health profile id.
      const filter: MeasurementFilter = { profileId: asProfileId(participantId as string) };
      const list: ReadonlyArray<Measurement> = store.list(filter);
      for (const m of list) {
        const id = `msr_${m.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        this.addEntry(participantId, {
          type: "measurement",
          timestamp: m.provenance.collectedAt,
          title: `Measurement recorded: ${m.schemaId}`,
          description: `Value ${JSON.stringify(m.value)} ${m.unitId} (verification: ${m.verificationState}).`,
          source: "health.measurements",
          programId: undefined,
          metadata: {
            schemaId: m.schemaId,
            measurementId: m.id,
            value: m.value,
            unitId: m.unitId,
            verificationState: m.verificationState,
            sourceId: m.sourceId,
          },
        });
        added++;
      }
      if (list.length > 0) sources.push("health.measurements");
    } catch {
      /* subsystem unavailable — skip */
    }

    // 2) Missions (via @/missions). Guard with try/catch.
    try {
      const mgr = getMissions();
      const list: ReadonlyArray<Mission> = mgr.list({ participantId });
      for (const m of list) {
        const id = `mis_${m.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        this.addEntry(participantId, {
          type: "mission",
          timestamp: m.scheduledFor,
          title: `${m.title} (${m.state})`,
          description: m.description,
          source: "missions",
          programId: m.programId,
          metadata: {
            missionId: m.id,
            state: m.state,
            category: m.category,
            type: m.type,
            priority: m.priority,
            difficulty: m.difficulty,
            durationMinutes: m.durationMinutes,
            completedAt: m.completedAt,
          },
        });
        added++;
      }
      if (list.length > 0) sources.push("missions");
    } catch {
      /* skip */
    }

    // 3) Competitions (via @/competitions). Guard with try/catch.
    try {
      const registry = getCompetitions();
      const list: ReadonlyArray<Competition> = registry.list();
      for (const c of list) {
        const id = `comp_${c.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        this.addEntry(participantId, {
          type: "competition",
          timestamp: c.startsAt ?? c.createdAt,
          title: `Competition: ${c.name}`,
          description: c.description,
          source: "competitions",
          programId: c.programId,
          metadata: {
            competitionId: c.id,
            slug: c.slug,
            state: c.state,
            scope: c.scope,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
          },
        });
        added++;
      }
      if (list.length > 0) sources.push("competitions");
    } catch {
      /* skip */
    }

    // 4) Program installations (via @/programs registry). Guard with try/catch.
    try {
      const registry = getRegistry();
      const list: ReadonlyArray<ProgramRecord> = registry
        .list()
        .filter((p) => p.state === "installed" || p.state === "active");
      for (const p of list) {
        const id = `inst_${p.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        this.addEntry(participantId, {
          type: "installation",
          timestamp: p.updatedAt,
          title: `Program installed: ${p.name}`,
          description: `Program "${p.slug}" (state: ${p.state}, category: ${p.category}).`,
          source: "programs.marketplace",
          programId: p.id,
          metadata: {
            programId: p.id,
            slug: p.slug,
            state: p.state,
            category: p.category,
            installedCount: p.installedCount,
          },
        });
        added++;
      }
      if (list.length > 0) sources.push("programs.marketplace");
    } catch {
      /* skip */
    }

    return { added, sources };
  }

  getStats(): TimelineStats {
    const list = [...this.timelines.values()];
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let totalEntries = 0;
    for (const t of list) {
      totalEntries += t.entries.length;
      for (const e of t.entries) {
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        bySource[e.source] = (bySource[e.source] ?? 0) + 1;
      }
    }
    return { totalTimelines: list.length, totalEntries, byType, bySource };
  }
}

// ---------------------------------------------------------------------------
// CSV helper
// ---------------------------------------------------------------------------

function csvCell(value: string): string {
  if (value == null) return "";
  const needs = /[",\n\r]/.test(value);
  const escaped = value.replace(/"/g, '""');
  return needs ? `"${escaped}"` : escaped;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: UnifiedTimelineManager | null = null;
export function getTimeline(): UnifiedTimelineManager {
  if (!_mgr) _mgr = new UnifiedTimelineManager();
  return _mgr;
}

// Re-export shared types for consumers
export type {
  AccountId,
  ProgramId,
  UnifiedTimeline,
  UnifiedTimelineEntry,
  UnifiedTimelineId,
  TimelineEntryType,
} from "../core";
