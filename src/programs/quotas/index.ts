/**
 * Eks-Health Program OS — Resource Quotas
 *
 * Every Program receives quotas. No Program monopolizes shared resources.
 * Quotas cover: CPU shares, memory, storage, API requests/minute, background
 * jobs, notifications/day, scheduled jobs, concurrent executions, AI
 * requests/day, search indexing docs, analytics events/day.
 *
 * Enforcement uses a real sliding-window counter: per-minute counters reset
 * every 60s, per-day counters reset every 24h. Usage is tracked per
 * (programId, resource, window) and rolled over automatically when the
 * window elapses. Quota-exceeded events are emitted to the kernel event bus.
 */

import "server-only";
import {
  type ProgramId,
  type ResourceQuota,
  ProgramError,
  DEFAULT_PROGRAM_QUOTA,
  PROGRAM_EVENTS,
} from "../core";
import { getEventBus, buildEvent, getClock } from "@/kernel";

// Re-export core quota primitives so callers can import everything from here.
export { type ResourceQuota, DEFAULT_PROGRAM_QUOTA } from "../core";

// ---------------------------------------------------------------------------
// Quota windows
// ---------------------------------------------------------------------------

export type QuotaWindow = "per-minute" | "per-hour" | "per-day";

export const QUOTA_WINDOW_DURATIONS_MS: Record<QuotaWindow, number> = {
  "per-minute": 60_000,
  "per-hour": 3_600_000,
  "per-day": 86_400_000,
};

/**
 * A resource is either:
 *   - "windowed": a counter that resets when the window elapses
 *     (rate-style: API requests/minute, notifications/day, AI requests/day,
 *     analytics events/day).
 *   - "current": a gauge that tracks live usage (memory, storage, jobs,
 *     scheduled jobs, concurrent executions, search indexing docs, cpu shares).
 */
export type QuotaResourceKind = "windowed" | "current";

export type QuotaResourceKey = keyof ResourceQuota;

interface ResourceDescriptor {
  readonly key: QuotaResourceKey;
  readonly kind: QuotaResourceKind;
  readonly window?: QuotaWindow;
  readonly unit: string;
}

const RESOURCE_DESCRIPTORS: readonly ResourceDescriptor[] = [
  { key: "cpuShares", kind: "current", unit: "shares" },
  { key: "memoryMb", kind: "current", unit: "MB" },
  { key: "storageMb", kind: "current", unit: "MB" },
  { key: "apiRequestsPerMinute", kind: "windowed", window: "per-minute", unit: "requests" },
  { key: "backgroundJobs", kind: "current", unit: "jobs" },
  { key: "notificationsPerDay", kind: "windowed", window: "per-day", unit: "notifications" },
  { key: "scheduledJobs", kind: "current", unit: "jobs" },
  { key: "concurrentExecutions", kind: "current", unit: "executions" },
  { key: "aiRequestsPerDay", kind: "windowed", window: "per-day", unit: "requests" },
  { key: "searchIndexingDocs", kind: "current", unit: "docs" },
  { key: "analyticsEventsPerDay", kind: "windowed", window: "per-day", unit: "events" },
];

const DESCRIPTOR_BY_KEY = new Map<QuotaResourceKey, ResourceDescriptor>(
  RESOURCE_DESCRIPTORS.map((d) => [d.key, d]),
);

// ---------------------------------------------------------------------------
// Usage tracking primitives
// ---------------------------------------------------------------------------

interface WindowedCounter {
  windowStart: number;
  count: number;
}

interface CurrentGauge {
  value: number;
}

interface ProgramQuotaState {
  windowed: Map<QuotaResourceKey, WindowedCounter>;
  current: Map<QuotaResourceKey, CurrentGauge>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QuotaUsage {
  readonly programId: ProgramId;
  readonly at: string;
  readonly resources: ReadonlyArray<{
    readonly key: QuotaResourceKey;
    readonly used: number;
    readonly limit: number;
    readonly window?: QuotaWindow;
    readonly windowResetAt?: string;
    readonly unit: string;
  }>;
}

export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly resource: QuotaResourceKey;
  readonly limit: number;
  readonly requested: number;
  readonly current: number;
  readonly remaining: number;
  readonly resetAt?: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;
}

export interface QuotaExceededDetail {
  readonly programId: ProgramId;
  readonly resource: QuotaResourceKey;
  readonly limit: number;
  readonly requested: number;
  readonly current: number;
  readonly at: string;
  readonly resetAt?: string;
  readonly retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Quota manager
// ---------------------------------------------------------------------------

export class QuotaManager {
  private readonly quotas = new Map<ProgramId, ResourceQuota>();
  private readonly state = new Map<ProgramId, ProgramQuotaState>();
  private readonly exceededLog: QuotaExceededDetail[] = [];
  private readonly exceededByProgram = new Map<ProgramId, QuotaExceededDetail[]>();

  /** Set a custom quota for a Program (overrides defaults). */
  setQuota(programId: ProgramId, quota: ResourceQuota): void {
    this.quotas.set(programId, { ...quota });
  }

  /** Get the effective quota (custom or default). */
  getQuota(programId: ProgramId): ResourceQuota {
    return this.quotas.get(programId) ?? { ...DEFAULT_PROGRAM_QUOTA };
  }

  /**
   * Record usage of a resource for the current window. For windowed
   * resources, increments the counter (rolling over if the window has
   * elapsed). For current/gauge resources, increments the live value.
   */
  recordUsage(programId: ProgramId, resource: QuotaResourceKey, amount: number): void {
    if (amount < 0) {
      throw new ProgramError({
        code: "eks.program.quota.invalid_amount",
        category: "validation",
        message: `Usage amount must be non-negative (got ${amount}).`,
        userMessage: "Invalid usage amount.",
      });
    }
    const desc = this.requireDescriptor(resource);
    const state = this.getOrCreateState(programId);
    if (desc.kind === "windowed" && desc.window) {
      const counter = this.getOrRollWindow(state, resource, desc.window);
      counter.count += amount;
    } else {
      const gauge = state.current.get(resource) ?? { value: 0 };
      gauge.value += amount;
      state.current.set(resource, gauge);
    }
  }

  /**
   * Decrement usage of a current/gauge resource (e.g. when a background job
   * finishes or memory is freed). Windowed counters cannot be decremented.
   */
  releaseUsage(programId: ProgramId, resource: QuotaResourceKey, amount: number): void {
    const desc = this.requireDescriptor(resource);
    if (desc.kind === "windowed") return; // cannot decrement rate counters
    const state = this.state.get(programId);
    if (!state) return;
    const gauge = state.current.get(resource);
    if (!gauge) return;
    gauge.value = Math.max(0, gauge.value - amount);
  }

  /**
   * Check whether `amount` of `resource` fits within the current window's
   * limit. Does NOT increment usage — call `recordUsage` afterwards.
   */
  check(programId: ProgramId, resource: QuotaResourceKey, amount = 1): QuotaCheckResult {
    const desc = this.requireDescriptor(resource);
    const quota = this.getQuota(programId);
    const limit = quota[resource];
    const state = this.getOrCreateState(programId);

    let current: number;
    let resetAt: string | undefined;
    let retryAfterMs: number | undefined;

    if (desc.kind === "windowed" && desc.window) {
      const counter = this.getOrRollWindow(state, resource, desc.window);
      current = counter.count;
      const windowEnd = counter.windowStart + QUOTA_WINDOW_DURATIONS_MS[desc.window];
      resetAt = new Date(windowEnd).toISOString();
      retryAfterMs = Math.max(0, windowEnd - getClock().epochMs());
    } else {
      const gauge = state.current.get(resource) ?? { value: 0 };
      current = gauge.value;
    }

    const remaining = Math.max(0, limit - current);
    const allowed = current + amount <= limit;

    if (!allowed) {
      const detail: QuotaExceededDetail = {
        programId,
        resource,
        limit,
        requested: amount,
        current,
        at: getClock().iso(),
        resetAt,
        retryAfterMs,
      };
      this.recordExceeded(detail);
    }

    return {
      allowed,
      resource,
      limit,
      requested: amount,
      current,
      remaining,
      resetAt,
      retryAfterMs: allowed ? undefined : retryAfterMs,
      reason: allowed ? undefined : `Quota exceeded for ${resource} (limit ${limit}, current ${current}, requested ${amount}).`,
    };
  }

  /**
   * Convenience: check + record atomically. Returns the check result.
   * If the check fails, usage is NOT recorded (caller may retry later).
   */
  consume(programId: ProgramId, resource: QuotaResourceKey, amount = 1): QuotaCheckResult {
    const result = this.check(programId, resource, amount);
    if (result.allowed) {
      this.recordUsage(programId, resource, amount);
    }
    return result;
  }

  /** Snapshot of current usage for a program. */
  getUsage(programId: ProgramId): QuotaUsage {
    const quota = this.getQuota(programId);
    const state = this.getOrCreateState(programId);
    const now = getClock().epochMs();
    const resources = RESOURCE_DESCRIPTORS.map((desc) => {
      let used = 0;
      let windowResetAt: string | undefined;
      if (desc.kind === "windowed" && desc.window) {
        const counter = this.getOrRollWindow(state, desc.key, desc.window);
        used = counter.count;
        windowResetAt = new Date(counter.windowStart + QUOTA_WINDOW_DURATIONS_MS[desc.window]).toISOString();
      } else {
        used = state.current.get(desc.key)?.value ?? 0;
      }
      return {
        key: desc.key,
        used,
        limit: quota[desc.key],
        window: desc.window,
        windowResetAt,
        unit: desc.unit,
      };
    });
    return { programId, at: getClock().iso(), resources };
  }

  /** Reset all counters for a program (admin operation). */
  reset(programId: ProgramId, resource?: QuotaResourceKey): void {
    const state = this.state.get(programId);
    if (!state) return;
    if (resource) {
      state.windowed.delete(resource);
      state.current.delete(resource);
    } else {
      state.windowed.clear();
      state.current.clear();
    }
  }

  /** Recorded quota-exceeded events (optionally filtered by program). */
  getQuotaExceededEvents(programId?: ProgramId): readonly QuotaExceededDetail[] {
    if (programId) return this.exceededByProgram.get(programId) ?? [];
    return this.exceededLog;
  }

  // --- Internals ------------------------------------------------------------

  private requireDescriptor(resource: QuotaResourceKey): ResourceDescriptor {
    const desc = DESCRIPTOR_BY_KEY.get(resource);
    if (!desc) {
      throw new ProgramError({
        code: "eks.program.quota.unknown_resource",
        category: "validation",
        message: `Unknown quota resource: ${resource}`,
        userMessage: "Unknown quota resource.",
      });
    }
    return desc;
  }

  private getOrCreateState(programId: ProgramId): ProgramQuotaState {
    let s = this.state.get(programId);
    if (!s) {
      s = { windowed: new Map(), current: new Map() };
      this.state.set(programId, s);
    }
    return s;
  }

  /**
   * Return the windowed counter for a resource, rolling it over (resetting
   * count to 0 and windowStart to now) if the window has elapsed.
   */
  private getOrRollWindow(state: ProgramQuotaState, resource: QuotaResourceKey, window: QuotaWindow): WindowedCounter {
    const now = getClock().epochMs();
    const duration = QUOTA_WINDOW_DURATIONS_MS[window];
    let counter = state.windowed.get(resource);
    if (!counter || now - counter.windowStart >= duration) {
      counter = { windowStart: now, count: 0 };
      state.windowed.set(resource, counter);
    }
    return counter;
  }

  private recordExceeded(detail: QuotaExceededDetail): void {
    this.exceededLog.push(detail);
    const list = this.exceededByProgram.get(detail.programId) ?? [];
    list.push(detail);
    this.exceededByProgram.set(detail.programId, list);
    void getEventBus().publish(
      buildEvent(
        PROGRAM_EVENTS.quotaExceeded,
        {
          programId: detail.programId,
          resource: detail.resource,
          limit: detail.limit,
          requested: detail.requested,
          current: detail.current,
          resetAt: detail.resetAt,
          retryAfterMs: detail.retryAfterMs,
        },
        {},
        "domain",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: QuotaManager | null = null;
export function getQuotas(): QuotaManager {
  if (!_mgr) _mgr = new QuotaManager();
  return _mgr;
}

export { RESOURCE_DESCRIPTORS };
