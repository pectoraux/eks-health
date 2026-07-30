/**
 * Eks-Health Universal Health Data Platform — Measurement Timeline
 *
 * Every participant owns an immutable measurement timeline. The timeline is
 * the authoritative, append-only, time-ordered record of every measurement
 * ever recorded for that participant — including historical records, version
 * history, corrections, and superseded records.
 *
 * Capabilities:
 *  - Append a measurement (looked up from the measurements subsystem).
 *  - Query with filters (schemaId, date range, source type, verification state).
 *  - Time travel — snapshot the timeline at any past timestamp.
 *  - Compare two points in time for a given schema (delta, delta %, trend).
 *  - Summary rollups (counts per schema / source / verification state).
 *  - Export to JSON or CSV (real serialization, no external deps).
 *  - Recent-N retrieval.
 *
 * The platform never interprets the meaning of any measurement — it only
 * orders, filters, and serializes them generically.
 */

import "server-only";
import {
  type TimelineId,
  type ProfileId,
  type MeasurementId,
  type SchemaId,
  type UnitId,
  type SourceId,
  type SourceType,
  type VerificationState,
  type MeasurementValue,
  HealthError,
  HEALTH_EVENTS,
  asTimelineId,
} from "../core";
import type { MeasurementSchema } from "../schemas";
import { getSchemas } from "../schemas";
import { getUnits } from "../units";
import { getSources } from "../sources";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Timeline types
// ---------------------------------------------------------------------------

export interface Timeline {
  readonly id: TimelineId;
  readonly profileId: ProfileId;
  readonly entries: TimelineEntry[];
  readonly createdAt: string;
  lastUpdatedAt: string;
}

export interface TimelineEntry {
  readonly measurementId: MeasurementId;
  readonly schemaId: SchemaId;
  readonly schemaName: string;
  readonly value: MeasurementValue;
  readonly unit: string;
  readonly sourceLabel: string;
  readonly sourceType?: SourceType;
  readonly verificationState: VerificationState;
  readonly timestamp: string;
  readonly supersededBy?: MeasurementId;
  readonly appendedAt: string;
}

export interface TimelineQuery {
  readonly schemaId?: SchemaId;
  readonly dateRange?: { readonly from: string; readonly to: string };
  readonly sourceType?: SourceType;
  readonly verificationState?: VerificationState;
  readonly includeSuperseded?: boolean;
}

export interface TimelineComparison {
  readonly profileId: ProfileId;
  readonly schemaId: SchemaId;
  readonly from: string;
  readonly to: string;
  readonly beforeValue: number | null;
  readonly afterValue: number | null;
  readonly beforeAt: string | null;
  readonly afterAt: string | null;
  readonly delta: number | null;
  readonly deltaPercent: number | null;
  readonly trend: "up" | "down" | "stable" | "unknown";
}

export interface TimelineSnapshot {
  readonly profileId: ProfileId;
  readonly atTime: string;
  readonly entries: readonly TimelineEntry[];
  readonly count: number;
  readonly schemas: readonly SchemaId[];
}

export interface TimelineSummary {
  readonly profileId: ProfileId;
  readonly totalCount: number;
  readonly bySchema: ReadonlyArray<{ schemaId: SchemaId; schemaName: string; count: number }>;
  readonly bySource: ReadonlyArray<{ sourceLabel: string; count: number }>;
  readonly byVerificationState: Readonly<Record<VerificationState, number>>;
  readonly dateRange: { readonly earliest: string | null; readonly latest: string | null };
}

export type TimelineExportFormat = "json" | "csv";

// ---------------------------------------------------------------------------
// Defensive measurements loader (m4-2 ships ../measurements in parallel).
// We resolve it lazily so this module compiles independently.
// ---------------------------------------------------------------------------

interface MeasurementLike {
  readonly id: MeasurementId;
  readonly profileId: ProfileId;
  readonly schemaId: SchemaId;
  readonly value: MeasurementValue;
  readonly unitId?: UnitId;
  readonly timestamp: string;
  readonly sourceId?: SourceId;
  readonly sourceType?: SourceType;
  readonly verificationState?: VerificationState;
  readonly supersededBy?: MeasurementId | null;
  readonly [k: string]: unknown;
}

interface MeasurementsApi {
  list(filter?: Record<string, unknown>): MeasurementLike[] | Promise<MeasurementLike[]>;
  listByProfile(profileId: ProfileId): MeasurementLike[] | Promise<MeasurementLike[]>;
  getTrend?(
    profileId: ProfileId,
    schemaId: SchemaId,
    from: string,
    to: string,
  ): MeasurementLike[] | Promise<MeasurementLike[]>;
  get?(id: MeasurementId): MeasurementLike | undefined | null | Promise<MeasurementLike | undefined | null>;
}

const MEASUREMENTS_PATH = "../measurements";
let _measurementsCache: MeasurementsApi | null | undefined;

async function loadMeasurements(): Promise<MeasurementsApi | null> {
  if (_measurementsCache !== undefined) return _measurementsCache;
  try {
    const mod = await import(MEASUREMENTS_PATH);
    const getter = (mod as { getMeasurements?: () => MeasurementsApi }).getMeasurements;
    _measurementsCache = getter ? getter() : null;
  } catch {
    _measurementsCache = null;
  }
  return _measurementsCache;
}

async function resolveArray<T>(v: T[] | Promise<T[]> | undefined | null): Promise<T[]> {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return await v;
}

// ---------------------------------------------------------------------------
// Numeric extraction from a generic MeasurementValue
// ---------------------------------------------------------------------------

function numericValue(v: MeasurementValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; systolic?: unknown; diastolic?: unknown };
    if (typeof o.value === "number") return Number.isFinite(o.value) ? o.value : null;
    if (typeof o.systolic === "number") return Number.isFinite(o.systolic) ? o.systolic : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timeline manager
// ---------------------------------------------------------------------------

export class TimelineManager {
  private readonly timelines = new Map<ProfileId, Timeline>();

  /** Returns the participant's timeline, creating an empty one if needed. */
  getOrCreate(profileId: ProfileId): Timeline {
    let t = this.timelines.get(profileId);
    if (!t) {
      const now = getClock().iso();
      t = {
        id: asTimelineId(generateId("tl_")),
        profileId,
        entries: [],
        createdAt: now,
        lastUpdatedAt: now,
      };
      this.timelines.set(profileId, t);
      void getEventBus().publish(
        buildEvent(
          "eks.health.timeline.created",
          { timelineId: t.id, profileId },
          {},
          "domain",
        ),
      );
    }
    return t;
  }

  /** Appends a measurement to its owner's timeline (looks it up). */
  async append(measurementId: MeasurementId): Promise<TimelineEntry> {
    const api = await loadMeasurements();
    if (!api) {
      throw new HealthError({
        code: "eks.health.timeline.measurements_unavailable",
        category: "interop_error",
        message: "Measurements subsystem unavailable; cannot append to timeline.",
        userMessage: "Measurements are not available right now.",
        retryable: true,
      });
    }
    let measurement: MeasurementLike | undefined;
    if (typeof api.get === "function") {
      const got = await api.get(measurementId);
      measurement = got ?? undefined;
    }
    if (!measurement) {
      const list = await resolveArray(api.list({ measurementId } as Record<string, unknown>));
      measurement = list.find((m) => m.id === measurementId);
    }
    if (!measurement) {
      throw new HealthError({
        code: "eks.health.timeline.measurement_not_found",
        category: "not_found",
        message: `Measurement ${measurementId} not found.`,
        userMessage: "Measurement not found.",
      });
    }
    const profileId = measurement.profileId;
    const timeline = this.getOrCreate(profileId);

    const schema = getSchemas().get(measurement.schemaId);
    const unitLabel = this.resolveUnitLabel(measurement.unitId, schema);
    const sourceLabel = this.resolveSourceLabel(measurement.sourceId, measurement.sourceType);
    const verificationState: VerificationState = measurement.verificationState ?? "pending";

    const entry: TimelineEntry = {
      measurementId: measurement.id,
      schemaId: measurement.schemaId,
      schemaName: schema?.name ?? measurement.schemaId,
      value: measurement.value,
      unit: unitLabel,
      sourceLabel,
      sourceType: measurement.sourceType,
      verificationState,
      timestamp: measurement.timestamp,
      supersededBy: measurement.supersededBy ?? undefined,
      appendedAt: getClock().iso(),
    };

    // Append-only: never mutate existing entries. Replace the entries array.
    const updated: Timeline = {
      ...timeline,
      entries: [...timeline.entries, entry],
      lastUpdatedAt: entry.appendedAt,
    };
    this.timelines.set(profileId, updated);

    void getEventBus().publish(
      buildEvent(
        "eks.health.timeline.appended",
        { timelineId: updated.id, profileId, measurementId, schemaId: entry.schemaId },
        {},
        "domain",
      ),
    );

    return entry;
  }

  /** Returns the timeline, optionally filtered. Sorted by timestamp descending. */
  get(profileId: ProfileId, filter?: TimelineQuery): Timeline {
    const t = this.timelines.get(profileId);
    if (!t) return this.getOrCreate(profileId);
    if (!filter) return { ...t, entries: sortDesc([...t.entries]) };
    const filtered = t.entries.filter((e) => this.matchesFilter(e, filter));
    return { ...t, entries: sortDesc(filtered) };
  }

  /** Snapshot of the timeline at a past timestamp (time travel). */
  getAtTime(profileId: ProfileId, timestamp: string): TimelineSnapshot {
    const t = this.timelines.get(profileId);
    const atMs = Date.parse(timestamp);
    if (Number.isNaN(atMs)) {
      throw new HealthError({
        code: "eks.health.timeline.bad_timestamp",
        category: "schema_invalid",
        message: `Invalid timestamp: ${timestamp}`,
      });
    }
    const entries = t ? t.entries.filter((e) => Date.parse(e.timestamp) <= atMs) : [];
    const sorted = sortDesc(entries);
    const schemas = [...new Set(sorted.map((e) => e.schemaId))];
    return {
      profileId,
      atTime: timestamp,
      entries: sorted,
      count: sorted.length,
      schemas,
    };
  }

  /** Compare a schema's value at two points in time. */
  compare(profileId: ProfileId, schemaId: SchemaId, from: string, to: string): TimelineComparison {
    const t = this.timelines.get(profileId);
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new HealthError({
        code: "eks.health.timeline.bad_range",
        category: "schema_invalid",
        message: "Invalid from/to timestamps.",
      });
    }
    if (fromMs > toMs) {
      throw new HealthError({
        code: "eks.health.timeline.range_inverted",
        category: "schema_invalid",
        message: "from must be <= to.",
      });
    }
    const entries = t
      ? t.entries.filter((e) => e.schemaId === schemaId)
      : [];

    // Closest entry at or before `from`, and at or before `to`.
    const beforeEntry = pickClosestBefore(entries, fromMs);
    const afterEntry = pickClosestBefore(entries, toMs);

    const beforeVal = beforeEntry ? numericValue(beforeEntry.value) : null;
    const afterVal = afterEntry ? numericValue(afterEntry.value) : null;

    let delta: number | null = null;
    let deltaPercent: number | null = null;
    let trend: TimelineComparison["trend"] = "unknown";

    if (beforeVal !== null && afterVal !== null) {
      delta = afterVal - beforeVal;
      if (beforeVal !== 0) {
        deltaPercent = (delta / Math.abs(beforeVal)) * 100;
      } else if (delta === 0) {
        deltaPercent = 0;
      } else {
        deltaPercent = null;
      }
      const epsilon = 1e-9;
      if (Math.abs(delta) < epsilon) trend = "stable";
      else if (delta > 0) trend = "up";
      else trend = "down";
    }

    return {
      profileId,
      schemaId,
      from,
      to,
      beforeValue: beforeVal,
      afterValue: afterVal,
      beforeAt: beforeEntry?.timestamp ?? null,
      afterAt: afterEntry?.timestamp ?? null,
      delta,
      deltaPercent,
      trend,
    };
  }

  /** Counts per schema, per source, per verification state, plus date range. */
  getSummary(profileId: ProfileId): TimelineSummary {
    const t = this.timelines.get(profileId);
    const entries = t?.entries ?? [];

    const schemaCounts = new Map<SchemaId, { name: string; count: number }>();
    const sourceCounts = new Map<string, number>();
    const stateCounts: Record<VerificationState, number> = {
      pending: 0,
      verified: 0,
      rejected: 0,
      expired: 0,
      disputed: 0,
      superseded: 0,
    };
    let earliest: string | null = null;
    let latest: string | null = null;

    for (const e of entries) {
      const sc = schemaCounts.get(e.schemaId);
      if (sc) sc.count++;
      else schemaCounts.set(e.schemaId, { name: e.schemaName, count: 1 });
      sourceCounts.set(e.sourceLabel, (sourceCounts.get(e.sourceLabel) ?? 0) + 1);
      stateCounts[e.verificationState]++;
      if (!earliest || e.timestamp < earliest) earliest = e.timestamp;
      if (!latest || e.timestamp > latest) latest = e.timestamp;
    }

    return {
      profileId,
      totalCount: entries.length,
      bySchema: [...schemaCounts.entries()].map(([schemaId, v]) => ({ schemaId, schemaName: v.name, count: v.count })),
      bySource: [...sourceCounts.entries()].map(([sourceLabel, count]) => ({ sourceLabel, count })),
      byVerificationState: stateCounts,
      dateRange: { earliest, latest },
    };
  }

  /** Most recent N entries (sorted descending by timestamp). */
  getRecent(profileId: ProfileId, limit: number): TimelineEntry[] {
    const t = this.timelines.get(profileId);
    if (!t || t.entries.length === 0) return [];
    const n = Math.max(0, Math.floor(limit));
    return sortDesc([...t.entries]).slice(0, n);
  }

  /** Serialize the timeline as JSON or CSV. */
  export(profileId: ProfileId, format: TimelineExportFormat): string {
    const t = this.timelines.get(profileId) ?? this.getOrCreate(profileId);
    const entries = sortDesc([...t.entries]);
    if (format === "json") {
      const payload = {
        timelineId: t.id,
        profileId: t.profileId,
        createdAt: t.createdAt,
        lastUpdatedAt: t.lastUpdatedAt,
        entries,
      };
      return JSON.stringify(payload, null, 2);
    }
    if (format === "csv") {
      return toCsv(entries);
    }
    throw new HealthError({
      code: "eks.health.timeline.bad_format",
      category: "schema_invalid",
      message: `Unknown export format: ${format as string}`,
    });
  }

  // --- internals -----------------------------------------------------------

  private matchesFilter(e: TimelineEntry, f: TimelineQuery): boolean {
    if (f.schemaId && e.schemaId !== f.schemaId) return false;
    if (f.sourceType && e.sourceType !== f.sourceType) return false;
    if (f.verificationState && e.verificationState !== f.verificationState) return false;
    if (!f.includeSuperseded && e.supersededBy) return false;
    if (f.dateRange) {
      const ts = Date.parse(e.timestamp);
      if (Number.isNaN(ts)) return false;
      const fromMs = Date.parse(f.dateRange.from);
      const toMs = Date.parse(f.dateRange.to);
      if (!Number.isNaN(fromMs) && ts < fromMs) return false;
      if (!Number.isNaN(toMs) && ts > toMs) return false;
    }
    return true;
  }

  private resolveUnitLabel(unitId: UnitId | undefined, schema: MeasurementSchema | undefined): string {
    if (unitId) {
      const u = getUnits().get(unitId);
      if (u) return u.symbol;
    }
    if (schema?.defaultUnit) {
      const u = getUnits().get(schema.defaultUnit);
      if (u) return u.symbol;
    }
    return "";
  }

  private resolveSourceLabel(sourceId: SourceId | undefined, sourceType: SourceType | undefined): string {
    if (sourceId) {
      const s = getSources().get(sourceId);
      if (s) return s.label;
    }
    if (sourceType) {
      const meta = getSources().listTypes().find((t) => t.type === sourceType);
      if (meta) return meta.label;
    }
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortDesc(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.sort((a, b) => {
    const aMs = Date.parse(a.timestamp);
    const bMs = Date.parse(b.timestamp);
    if (aMs === bMs) return a.appendedAt < b.appendedAt ? 1 : -1;
    return bMs - aMs;
  });
}

function pickClosestBefore(entries: TimelineEntry[], ms: number): TimelineEntry | null {
  let best: TimelineEntry | null = null;
  let bestMs = -Infinity;
  for (const e of entries) {
    const eMs = Date.parse(e.timestamp);
    if (Number.isNaN(eMs)) continue;
    if (eMs <= ms && eMs > bestMs) {
      best = e;
      bestMs = eMs;
    }
  }
  return best;
}

function toCsv(entries: TimelineEntry[]): string {
  const headers = [
    "measurementId",
    "schemaId",
    "schemaName",
    "value",
    "unit",
    "sourceLabel",
    "sourceType",
    "verificationState",
    "timestamp",
    "supersededBy",
    "appendedAt",
  ];
  const rows = entries.map((e) =>
    [
      e.measurementId,
      e.schemaId,
      e.schemaName,
      serializeValue(e.value),
      e.unit,
      e.sourceLabel,
      e.sourceType ?? "",
      e.verificationState,
      e.timestamp,
      e.supersededBy ?? "",
      e.appendedAt,
    ]
      .map(csvEscape)
      .join(","),
  );
  return [headers.join(","), ...rows].join("\n");
}

function serializeValue(v: MeasurementValue): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: TimelineManager | null = null;
export function getTimeline(): TimelineManager {
  if (!_manager) _manager = new TimelineManager();
  return _manager;
}
export function resetTimeline(): void {
  _manager = null;
}

// Re-export commonly used core branded ids / event constants for convenience.
export { HEALTH_EVENTS, asTimelineId };
export type { TimelineId, ProfileId, MeasurementId };
