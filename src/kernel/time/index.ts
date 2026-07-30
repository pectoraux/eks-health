/**
 * Eks-Health Kernel — Time Platform
 *
 * The single source of truth for "what time is it?" across the platform.
 *
 * Capabilities:
 *  - Re-exports the Clock abstraction (Clock / getClock / setClock / resetClock)
 *    so the entire platform — and all tests — can be made deterministic.
 *  - Curated registry of ~24 major IANA timezones with human labels and
 *    UTC offset strings (computed live, so DST is reflected automatically).
 *  - Immutable Timestamp branded type (epoch ms, always UTC under the hood).
 *  - Wall-clock formatting via Intl.DateTimeFormat (no external deps).
 *  - DST detection for any IANA timezone.
 *  - Duration arithmetic (add / diff) and startOfDay / endOfDay per tz.
 *
 * Design notes:
 *  - A Timestamp is just a branded epoch-ms number. Internals are always UTC;
 *    timezones only matter at the formatting / boundary layer.
 *  - Everything routes through the global Clock so tests can freeze time by
 *    calling setClock(new FixedClock(...)).
 */

import type { Brand } from "../core";
import { getClock } from "../core";

// Re-export the clock surface so consumers can `import { getClock } from "../time"`.
export type { Clock } from "../core";
export { getClock, setClock, resetClock } from "../core";

// ---------------------------------------------------------------------------
// Branded Timestamp & Duration
// ---------------------------------------------------------------------------

/** Epoch-milliseconds, always UTC. Use `TimeService.now()` to obtain one. */
export type Timestamp = Brand<number, "Timestamp">;

/** Helper to cast a number into a Timestamp (does not validate). */
export function asTimestamp(ms: number): Timestamp {
  return ms as Timestamp;
}

/**
 * Duration in milliseconds. Use DURATIONS constants or duration() builder.
 * Negative durations represent "into the past".
 */
export interface Duration {
  readonly ms: number;
}

/** Build a duration from a numeric amount and a unit. */
export function duration(
  amount: number,
  unit: "ms" | "s" | "m" | "h" | "d" | "w" = "ms",
): Duration {
  const factors: Record<typeof unit, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return { ms: amount * factors[unit] };
}

/** Common durations as constants. */
export const DURATIONS = {
  SECOND: { ms: 1_000 } as Duration,
  MINUTE: { ms: 60_000 } as Duration,
  HOUR: { ms: 3_600_000 } as Duration,
  DAY: { ms: 86_400_000 } as Duration,
  WEEK: { ms: 604_800_000 } as Duration,
} as const;

// ---------------------------------------------------------------------------
// Timezone & Locale
// ---------------------------------------------------------------------------

export interface Timezone {
  readonly id: string; // IANA tz id, e.g. "America/New_York"
  readonly label: string; // human label, e.g. "New York"
  readonly region: string; // continent / region, e.g. "Americas"
  /** UTC offset string, e.g. "-05:00" or "+00:00" (live, DST-aware). */
  readonly offset: string;
}

/** BCP-47 locale tag, e.g. "en-US", "fr-FR", "ar-EG". */
export type Locale = Brand<string, "Locale">;

export function asLocale(s: string): Locale {
  return s as Locale;
}

// ---------------------------------------------------------------------------
// Curated timezone registry (~24 major zones across every continent)
// ---------------------------------------------------------------------------

interface TimezoneSeed {
  readonly id: string;
  readonly label: string;
  readonly region: string;
}

const TIMEZONE_SEEDS: readonly TimezoneSeed[] = [
  { id: "UTC", label: "UTC (Coordinated Universal Time)", region: "Universal" },
  { id: "Africa/Accra", label: "Accra", region: "Africa" },
  { id: "Africa/Lagos", label: "Lagos", region: "Africa" },
  { id: "Africa/Nairobi", label: "Nairobi", region: "Africa" },
  { id: "Africa/Johannesburg", label: "Johannesburg", region: "Africa" },
  { id: "Africa/Cairo", label: "Cairo", region: "Africa" },
  { id: "Europe/London", label: "London", region: "Europe" },
  { id: "Europe/Paris", label: "Paris", region: "Europe" },
  { id: "Europe/Berlin", label: "Berlin", region: "Europe" },
  { id: "Europe/Moscow", label: "Moscow", region: "Europe" },
  { id: "America/New_York", label: "New York", region: "Americas" },
  { id: "America/Chicago", label: "Chicago", region: "Americas" },
  { id: "America/Denver", label: "Denver", region: "Americas" },
  { id: "America/Los_Angeles", label: "Los Angeles", region: "Americas" },
  { id: "America/Sao_Paulo", label: "São Paulo", region: "Americas" },
  { id: "America/Toronto", label: "Toronto", region: "Americas" },
  { id: "Asia/Dubai", label: "Dubai", region: "Asia" },
  { id: "Asia/Kolkata", label: "Kolkata", region: "Asia" },
  { id: "Asia/Shanghai", label: "Shanghai", region: "Asia" },
  { id: "Asia/Singapore", label: "Singapore", region: "Asia" },
  { id: "Asia/Tokyo", label: "Tokyo", region: "Asia" },
  { id: "Asia/Karachi", label: "Karachi", region: "Asia" },
  { id: "Australia/Sydney", label: "Sydney", region: "Oceania" },
  { id: "Pacific/Auckland", label: "Auckland", region: "Oceania" },
];

// ---------------------------------------------------------------------------
// TimeService
// ---------------------------------------------------------------------------

export interface FormatOptions {
  readonly dateStyle?: "full" | "long" | "medium" | "short";
  readonly timeStyle?: "full" | "long" | "medium" | "short";
  readonly timeZone?: string;
  readonly hour12?: boolean;
}

export class TimeService {
  /** Current instant as an immutable Timestamp (epoch ms UTC). */
  now(): Timestamp {
    return asTimestamp(getClock().epochMs());
  }

  /** Current instant plus wall-clock metadata for the given timezone. */
  nowIn(tz: string): {
    ts: Timestamp;
    tz: string;
    isoUtc: string;
    wallClock: string;
    offset: string;
  } {
    const ts = this.now();
    return {
      ts,
      tz,
      isoUtc: this.toUTC(ts),
      wallClock: this.format(ts, asLocale("en-US"), { timeZone: tz, dateStyle: "long", timeStyle: "long" }),
      offset: this.offsetFor(tz, ts),
    };
  }

  /** Format a timestamp using Intl.DateTimeFormat. */
  format(ts: Timestamp, locale: Locale, opts: FormatOptions = {}): string {
    const fmt = new Intl.DateTimeFormat(locale, {
      dateStyle: opts.dateStyle,
      timeStyle: opts.timeStyle,
      timeZone: opts.timeZone,
      hour12: opts.hour12,
    });
    return fmt.format(new Date(ts));
  }

  /** Parse an ISO-8601 string into a Timestamp. Throws on invalid input. */
  parse(s: string): Timestamp {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      throw new RangeError(`Cannot parse "${s}" as an ISO-8601 timestamp`);
    }
    return asTimestamp(d.getTime());
  }

  /** ISO-8601 UTC string for a timestamp. */
  toUTC(ts: Timestamp): string {
    return new Date(ts).toISOString();
  }

  /**
   * Format a UTC timestamp as wall-clock in the given timezone.
   * Returns a localized string; use `format()` if you need finer control.
   */
  fromUTC(ts: Timestamp, tz: string, locale: Locale = asLocale("en-US")): string {
    return this.format(ts, locale, { timeZone: tz, dateStyle: "long", timeStyle: "long" });
  }

  /** Add a duration to a timestamp, returning a new Timestamp. */
  addDuration(ts: Timestamp, d: Duration): Timestamp {
    return asTimestamp(ts + d.ms);
  }

  /** Signed difference b - a, as a Duration. */
  diff(a: Timestamp, b: Timestamp): Duration {
    return { ms: b - a };
  }

  /**
   * Determine whether the given timezone is currently observing DST.
   * Strategy: compare the offset at `ts` against the offset at January 1
   * (Northern winter) and July 1 (Northern summer) of the same year. If
   * `ts`'s offset is greater than the minimum of those two, DST is active.
   */
  isDST(tz: string, ts: Timestamp = this.now()): boolean {
    if (tz === "UTC") return false;
    const date = new Date(ts);
    const year = date.getUTCFullYear();
    const jan = asTimestamp(Date.UTC(year, 0, 1, 12));
    const jul = asTimestamp(Date.UTC(year, 6, 1, 12));
    const offTs = this.offsetMinutes(tz, ts);
    const offJan = this.offsetMinutes(tz, jan);
    const offJul = this.offsetMinutes(tz, jul);
    const stdOffset = Math.min(offJan, offJul);
    return offTs > stdOffset;
  }

  /** All curated timezones with live offsets. */
  listTimezones(ts: Timestamp = this.now()): Timezone[] {
    return TIMEZONE_SEEDS.map((s) => ({
      id: s.id,
      label: s.label,
      region: s.region,
      offset: this.offsetFor(s.id, ts),
    }));
  }

  /** UTC instant at 00:00:00.000 of the day containing `ts` in `tz`. */
  startOfDay(ts: Timestamp, tz: string): Timestamp {
    const parts = this.wallClockParts(ts, tz);
    const y = Number(parts.year);
    const m = Number(parts.month) - 1;
    const d = Number(parts.day);
    const wallMidnightUtc = Date.UTC(y, m, d, 0, 0, 0, 0);
    const offsetMs = this.offsetMinutes(tz, ts) * 60_000;
    // wall-clock midnight in tz === UTC midnight + offset → subtract offset.
    return asTimestamp(wallMidnightUtc - offsetMs);
  }

  /** UTC instant at 23:59:59.999 of the day containing `ts` in `tz`. */
  endOfDay(ts: Timestamp, tz: string): Timestamp {
    const start = this.startOfDay(ts, tz);
    return asTimestamp(start + DURATIONS.DAY.ms - 1);
  }

  // --- private helpers ----------------------------------------------------

  /**
   * Live UTC offset string for a tz, e.g. "-05:00" or "+00:00".
   * Uses Intl.DateTimeFormat's formatToParts which yields a `timeZoneName`
   * of "GMT+5" / "GMT-5:30" etc. — we normalize to ±HH:MM.
   */
  offsetFor(tz: string, ts: Timestamp = this.now()): string {
    const minutes = this.offsetMinutes(tz, ts);
    return minutesToOffsetString(minutes);
  }

  /** Signed offset in minutes for a tz at a given instant. */
  private offsetMinutes(tz: string, ts: Timestamp): number {
    const date = new Date(ts);
    // Format the same instant in both UTC and the target tz, then diff.
    const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = date.toLocaleString("en-US", { timeZone: tz });
    const utcMs = new Date(utcStr + " UTC").getTime();
    const tzMs = new Date(tzStr + " UTC").getTime();
    if (Number.isNaN(utcMs) || Number.isNaN(tzMs)) {
      throw new RangeError(`Unknown or invalid timezone: ${tz}`);
    }
    return Math.round((tzMs - utcMs) / 60_000);
  }

  /** Extract {year, month, day, hour, minute, second} for ts in tz. */
  private wallClockParts(
    ts: Timestamp,
    tz: string,
  ): { year: string; month: string; day: string; hour: string; minute: string; second: string } {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const out: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ts))) {
      if (p.type !== "literal") out[p.type] = p.value;
    }
    // `hour` can be "24" at midnight on some engines; normalize to "00".
    if (out.hour === "24") out.hour = "00";
    return {
      year: out.year,
      month: out.month,
      day: out.day,
      hour: out.hour,
      minute: out.minute,
      second: out.second,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minutesToOffsetString(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _svc: TimeService | null = null;
export function getTime(): TimeService {
  if (!_svc) _svc = new TimeService();
  return _svc;
}
export function setTime(svc: TimeService): void {
  _svc = svc;
}
