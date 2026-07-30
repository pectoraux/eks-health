/**
 * Eks-Health Developer Platform — Debugging Platform
 *
 * Developers inspect every aspect of a running Program: events published to
 * the kernel event bus, API calls, permission checks, consent checks,
 * measurements, competition state, mission generation, leaderboard updates,
 * AI executions, workflow steps, errors, warnings, and performance samples.
 *
 * Everything is captured into a DebugSession. Sessions can be filtered by
 * type / source / time range / trace id / correlation id / minimum duration.
 * Sessions can be replayed as a chronological timeline with relative offsets
 * from the session start. Performance samples are aggregated into real
 * avg/p50/p95/min/max statistics.
 *
 * All filtering, sorting, percentile, and replay logic is real — no mocks.
 */

import "server-only";

import {
  type DebugEvent,
  type DebugEventType,
  type DebugFilter,
  type DebugSession,
  type DebugSessionId,
  DeveloperError,
  asDebugSessionId,
  DEVELOPER_EVENTS,
} from "../core";
import type { ProgramId } from "@/programs";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Extended debugger types
// ---------------------------------------------------------------------------

export interface DebugTimelineEntry {
  readonly event: DebugEvent;
  /** Milliseconds from the session start (clamped to >= 0). */
  readonly offsetMs: number;
}

export interface DebugTimeline {
  readonly sessionId: DebugSessionId;
  readonly entries: DebugTimelineEntry[];
  /** Milliseconds between the first and last event. */
  readonly totalDurationMs: number;
  readonly builtAt: string;
}

export interface DebugReplay {
  readonly sessionId: DebugSessionId;
  /** Events in chronological order, post-filter. */
  readonly events: DebugEvent[];
  /** Wall-clock duration between first and last replayed event. */
  readonly totalDurationMs: number;
  readonly replayedAt: string;
  /** Filter applied (if any). */
  readonly filter?: DebugFilter;
}

export interface DebugPerformanceStats {
  readonly count: number;
  readonly avgMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly totalMs: number;
}

export interface DebugSessionStats {
  readonly totalSessions: number;
  readonly totalEvents: number;
  readonly avgEventsPerSession: number;
  /** Fraction of error+warning events over total events (0..1). */
  readonly errorRate: number;
  readonly activeSessions: number;
}

// Re-export core types so consumers can import everything from "./debugger".
export type {
  DebugEvent,
  DebugEventType,
  DebugFilter,
  DebugSession,
  DebugSessionId,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesFilter(event: DebugEvent, filter: DebugFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.sources && filter.sources.length > 0 && !filter.sources.includes(event.source)) {
    return false;
  }
  if (filter.from && event.timestamp < filter.from) return false;
  if (filter.to && event.timestamp > filter.to) return false;
  if (filter.traceId && event.traceId !== filter.traceId) return false;
  if (filter.correlationId && event.correlationId !== filter.correlationId) return false;
  if (filter.minDurationMs !== undefined && (event.durationMs ?? 0) < filter.minDurationMs) {
    return false;
  }
  return true;
}

function chronologicalCompare(a: DebugEvent, b: DebugEvent): number {
  // Stable: timestamp first, then id (which already encodes time + random suffix).
  if (a.timestamp < b.timestamp) return -1;
  if (a.timestamp > b.timestamp) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function parseIsoMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Real percentile via the nearest-rank method (matches the rest of the
 * platform's observability code). Returns 0 for empty inputs.
 */
function percentile(valuesSortedAsc: readonly number[], p: number): number {
  const n = valuesSortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return valuesSortedAsc[0];
  const rank = Math.max(1, Math.min(n, Math.ceil((p / 100) * n)));
  return valuesSortedAsc[rank - 1];
}

function computeDurationMs(events: readonly DebugEvent[]): number {
  if (events.length === 0) return 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const t = parseIsoMs(e.timestamp);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
  return Math.max(0, max - min);
}

// ---------------------------------------------------------------------------
// Debugger
// ---------------------------------------------------------------------------

export class Debugger {
  private readonly sessions = new Map<DebugSessionId, DebugSession>();
  private readonly byProgram = new Map<ProgramId, DebugSessionId[]>();
  /** Active (non-ended) sessions, for fast activeSessions count. */
  private readonly active = new Set<DebugSessionId>();

  /** Start a new debug session for a program (and optionally a participant). */
  startSession(programId: ProgramId, participantId?: string): DebugSession {
    const id = asDebugSessionId(generateId("dbg_"));
    const startedAt = getClock().iso();
    const session: DebugSession = {
      id,
      programId,
      participantId,
      events: [],
      startedAt,
      filters: {},
    };
    this.sessions.set(id, session);
    this.active.add(id);
    const list = this.byProgram.get(programId) ?? [];
    this.byProgram.set(programId, [...list, id]);
    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.debugSessionStarted,
        { sessionId: id, programId, participantId },
        {},
        "domain",
      ),
    );
    return session;
  }

  /** End a debug session. Returns the updated session. Throws if not found. */
  endSession(sessionId: DebugSessionId): DebugSession {
    const session = this.require(sessionId);
    if (session.endedAt) {
      throw new DeveloperError({
        code: "eks.developer.debug.session_already_ended",
        category: "state_conflict",
        message: `Session ${sessionId} has already ended.`,
        userMessage: "This debug session has already ended.",
        metadata: { sessionId },
      });
    }
    const endedAt = getClock().iso();
    const updated: DebugSession = { ...session, endedAt };
    this.sessions.set(sessionId, updated);
    this.active.delete(sessionId);
    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.debugSessionEnded,
        { sessionId, programId: session.programId, endedAt, events: updated.events.length },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /**
   * Record a debug event in a session. The caller supplies the event payload
   * (type, source, data, durationMs, traceId, correlationId). The platform
   * stamps the id and timestamp if missing.
   */
  recordEvent(
    sessionId: DebugSessionId,
    event: Omit<DebugEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
  ): DebugEvent {
    const session = this.require(sessionId);
    const full: DebugEvent = {
      id: event.id ?? generateId("dbe_"),
      type: event.type,
      timestamp: event.timestamp ?? getClock().iso(),
      source: event.source,
      data: event.data,
      durationMs: event.durationMs,
      traceId: event.traceId,
      correlationId: event.correlationId,
    };
    // Sessions are immutable in core (readonly), so we replace the entry.
    const updated: DebugSession = {
      ...session,
      events: [...session.events, full],
    };
    this.sessions.set(sessionId, updated);
    return full;
  }

  /** Returns events for a session, optionally filtered. */
  getEvents(sessionId: DebugSessionId, filter?: DebugFilter): DebugEvent[] {
    const session = this.require(sessionId);
    const filtered = session.events.filter((e) => matchesFilter(e, filter));
    return filtered.slice().sort(chronologicalCompare);
  }

  /**
   * Returns events as a timeline with relative offsets from the session
   * start. Real computation: sort by timestamp, compute offsetMs from the
   * session.startedAt (or the first event's timestamp if earlier).
   */
  getTimeline(sessionId: DebugSessionId): DebugTimeline {
    const session = this.require(sessionId);
    const sorted = session.events.slice().sort(chronologicalCompare);
    const baseMs = parseIsoMs(session.startedAt);
    const entries: DebugTimelineEntry[] = sorted.map((event) => {
      const offset = parseIsoMs(event.timestamp) - baseMs;
      return { event, offsetMs: Math.max(0, offset) };
    });
    return {
      sessionId,
      entries,
      totalDurationMs: computeDurationMs(sorted),
      builtAt: getClock().iso(),
    };
  }

  /**
   * Returns a replay of the session: events in chronological order. If a
   * filter is supplied, only matching events are replayed. The duration is
   * computed from the replayed events (not the whole session).
   */
  replay(sessionId: DebugSessionId, filter?: DebugFilter): DebugReplay {
    const session = this.require(sessionId);
    const filtered = session.events.filter((e) => matchesFilter(e, filter));
    const ordered = filtered.slice().sort(chronologicalCompare);
    return {
      sessionId,
      events: ordered,
      totalDurationMs: computeDurationMs(ordered),
      replayedAt: getClock().iso(),
      filter,
    };
  }

  /** Look up a session by id. */
  getSession(id: DebugSessionId): DebugSession | undefined {
    return this.sessions.get(id);
  }

  /** List sessions, optionally filtered by program. */
  listSessions(programId?: ProgramId): DebugSession[] {
    if (programId) {
      const ids = this.byProgram.get(programId) ?? [];
      return ids.map((id) => this.sessions.get(id)!).filter(Boolean);
    }
    return [...this.sessions.values()];
  }

  /** Returns only error + warning events for a session (chronological). */
  getErrors(sessionId: DebugSessionId): DebugEvent[] {
    return this.getEvents(sessionId, {
      types: ["error", "warning"],
    });
  }

  /**
   * Returns performance statistics for a session. Real aggregation: collect
   * all performance events, sort their durationMs ascending, compute avg /
   * p50 / p95 / min / max / total.
   */
  getPerformance(sessionId: DebugSessionId): DebugPerformanceStats {
    const session = this.require(sessionId);
    const durations = session.events
      .filter((e) => e.type === "performance" && typeof e.durationMs === "number")
      .map((e) => e.durationMs as number)
      .sort((a, b) => a - b);
    if (durations.length === 0) {
      return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, totalMs: 0 };
    }
    let total = 0;
    for (const d of durations) total += d;
    return {
      count: durations.length,
      avgMs: Math.round((total / durations.length) * 1000) / 1000,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      totalMs: total,
    };
  }

  /** Aggregate stats across sessions (optionally scoped to a program). */
  getStats(programId?: ProgramId): DebugSessionStats {
    const sessions = this.listSessions(programId);
    let totalEvents = 0;
    let errorEvents = 0;
    let active = 0;
    for (const s of sessions) {
      totalEvents += s.events.length;
      for (const e of s.events) {
        if (e.type === "error" || e.type === "warning") errorEvents++;
      }
      if (!s.endedAt) active++;
    }
    return {
      totalSessions: sessions.length,
      totalEvents,
      avgEventsPerSession: sessions.length > 0 ? Math.round((totalEvents / sessions.length) * 100) / 100 : 0,
      errorRate: totalEvents > 0 ? Math.round((errorEvents / totalEvents) * 10000) / 10000 : 0,
      activeSessions: active,
    };
  }

  // --- Internal --------------------------------------------------------

  private require(id: DebugSessionId): DebugSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new DeveloperError({
        code: "eks.developer.debug.session_not_found",
        category: "not_found",
        message: `Debug session ${id} not found.`,
        userMessage: "Debug session not found.",
        metadata: { sessionId: id },
      });
    }
    return session;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _debugger: Debugger | null = null;
export function getDebugger(): Debugger {
  if (!_debugger) _debugger = new Debugger();
  return _debugger;
}
export function resetDebugger(): void {
  _debugger = null;
}
