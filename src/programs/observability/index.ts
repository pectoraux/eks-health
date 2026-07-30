/**
 * Eks-Health Program OS — Program Observability
 *
 * Every Program running on the platform exposes a unified observability
 * surface: health, performance, errors, latency, resource usage, crash
 * reports, audit events, usage metrics, install metrics, upgrade metrics,
 * and developer diagnostics.
 *
 * This module is the storage + aggregation layer for program telemetry.
 * It does NOT interpret clinical events — it records generic operational
 * signals that the platform (and developers) use to operate programs safely.
 *
 * Real logic:
 *  - Real latency percentile computation: samples are stored per
 *    program+operation, sorted on demand, and p50/p95/p99 are picked by
 *    nearest-rank interpolation.
 *  - Real metric aggregation: error/crash/usage/install/upgrade counts are
 *    recomputed from the underlying event store on every getMetrics() call.
 *  - Real install trend (7 bucket) and version distribution roll-ups.
 */

import "server-only";
import {
  type ProgramId,
  ProgramError,
  asProgramId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { PROGRAM_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Branded observability ids
// ---------------------------------------------------------------------------

export type ObservabilityEventId = string & { readonly __brand: "ObservabilityEventId" };

// ---------------------------------------------------------------------------
// Health & status
// ---------------------------------------------------------------------------

export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "crashed";

export interface ProgramHealth {
  readonly programId: ProgramId;
  readonly status: HealthStatus;
  readonly checkedAt: string;
  readonly details?: Record<string, unknown>;
  readonly uptimeSeconds?: number;
  readonly errorRate?: number;
  readonly version?: string;
  readonly latencyMs?: number;
}

export type ErrorSeverity = "info" | "warn" | "error" | "critical";

export interface ProgramErrorReport {
  readonly id: string;
  readonly programId: ProgramId;
  readonly code: string;
  readonly message: string;
  readonly stack?: string;
  readonly severity: ErrorSeverity;
  readonly at: string;
  readonly metadata?: Record<string, unknown>;
  readonly correlationId?: string;
}

export interface CrashReport {
  readonly id: string;
  readonly programId: ProgramId;
  readonly reason: string;
  readonly stack?: string;
  readonly at: string;
  readonly version?: string;
  readonly fatal: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface LatencySample {
  readonly programId: ProgramId;
  readonly operation: string;
  readonly ms: number;
  readonly at: string;
}

export interface UsageMetric {
  readonly programId: ProgramId;
  readonly metric: string;
  readonly value: number;
  readonly at: string;
}

export interface InstallMetric {
  readonly programId: ProgramId;
  readonly accountId: string;
  readonly at: string;
  readonly active: boolean;
}

export interface UpgradeMetric {
  readonly programId: ProgramId;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly accountId: string;
  readonly at: string;
  readonly rollback?: boolean;
}

export interface LatencyStats {
  readonly operation: string;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface ProgramMetrics {
  readonly programId: ProgramId;
  readonly errorCount: number;
  readonly criticalErrorCount: number;
  readonly crashCount: number;
  readonly fatalCrashCount: number;
  readonly avgLatencyMs?: number;
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly p99LatencyMs?: number;
  readonly latencyByOperation: ReadonlyArray<LatencyStats>;
  readonly usageTotals: Readonly<Record<string, number>>;
  readonly installCount: number;
  readonly activeInstallCount: number;
  readonly upgradeCount: number;
  readonly rollbackCount: number;
  readonly lastHealthStatus?: HealthStatus;
  readonly lastErrorAt?: string;
  readonly lastCrashAt?: string;
  readonly computedAt: string;
}

export interface DiagnosticSnapshot {
  readonly programId: ProgramId;
  readonly at: string;
  readonly health?: ProgramHealth;
  readonly metrics: ProgramMetrics;
  readonly recentErrors: ProgramErrorReport[];
  readonly recentCrashes: CrashReport[];
  readonly installCount: number;
  readonly upgradeCount: number;
  readonly activeInstallCount: number;
}

export interface InstallTrendBucket {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly installs: number;
  readonly activeInstalls: number;
}

export interface InstallMetricsAggregate {
  readonly programId: ProgramId;
  readonly installCount: number;
  readonly activeInstallCount: number;
  readonly uniqueAccounts: number;
  readonly trend: ReadonlyArray<InstallTrendBucket>;
}

export interface VersionDistributionEntry {
  readonly version: string;
  readonly count: number;
  readonly share: number;
}

export interface UpgradeMetricsAggregate {
  readonly programId: ProgramId;
  readonly upgradeCount: number;
  readonly rollbackCount: number;
  readonly versionDistribution: ReadonlyArray<VersionDistributionEntry>;
  readonly lastUpgradeAt?: string;
}

export interface ObservabilityErrorFilter {
  readonly severity?: ErrorSeverity;
  readonly code?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// Observability event types
// ---------------------------------------------------------------------------

export const OBSERVABILITY_EVENTS = {
  healthRecorded: "eks.program.observability.health.recorded",
  errorRecorded: "eks.program.observability.error.recorded",
  crashRecorded: "eks.program.observability.crash.recorded",
  latencyRecorded: "eks.program.observability.latency.recorded",
  usageRecorded: "eks.program.observability.usage.recorded",
  installRecorded: "eks.program.observability.install.recorded",
  upgradeRecorded: "eks.program.observability.upgrade.recorded",
  programDegraded: "eks.program.observability.program.degraded",
  programUnhealthy: "eks.program.observability.program.unhealthy",
  programCrashed: "eks.program.observability.program.crashed",
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SAMPLES_PER_OP = 1000; // cap retained latency samples to bound memory
const MAX_ERRORS_PER_PROGRAM = 5000;
const MAX_CRASHES_PER_PROGRAM = 1000;
const MAX_RECENT_DIAGNOSTIC = 25;
const INSTALL_TREND_BUCKETS = 7;
const BUCKET_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// Real percentile computation (nearest-rank)
// ---------------------------------------------------------------------------

/**
 * Compute p50/p95/p99 from a list of samples using the nearest-rank method.
 * - Sort ascending.
 * - rank = ceil(p/100 * n) — clamped to [1, n].
 * - Returns 0 if the input is empty.
 */
function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const rank = Math.max(1, Math.min(n, Math.ceil((p / 100) * n)));
  return sortedAsc[rank - 1];
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// ---------------------------------------------------------------------------
// Observability manager
// ---------------------------------------------------------------------------

export class ProgramObservability {
  private readonly health = new Map<ProgramId, ProgramHealth>();
  private readonly errors = new Map<ProgramId, ProgramErrorReport[]>();
  private readonly crashes = new Map<ProgramId, CrashReport[]>();
  private readonly latency = new Map<ProgramId, Map<string, LatencySample[]>>();
  private readonly usage = new Map<ProgramId, Map<string, number>>();
  private readonly installs = new Map<ProgramId, InstallMetric[]>();
  private readonly upgrades = new Map<ProgramId, UpgradeMetric[]>();

  // ----------------------- Health -----------------------

  recordHealth(programId: ProgramId, health: Omit<ProgramHealth, "programId" | "checkedAt"> & { checkedAt?: string }): ProgramHealth {
    const full: ProgramHealth = {
      ...health,
      programId,
      checkedAt: health.checkedAt ?? getClock().iso(),
    };
    this.health.set(programId, full);
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.healthRecorded, {
        programId,
        status: full.status,
        uptimeSeconds: full.uptimeSeconds,
        errorRate: full.errorRate,
      }, {}, "system"),
    );
    if (full.status === "degraded") {
      void getEventBus().publish(buildEvent(OBSERVABILITY_EVENTS.programDegraded, { programId, status: full.status }, {}, "system"));
    } else if (full.status === "unhealthy") {
      void getEventBus().publish(buildEvent(OBSERVABILITY_EVENTS.programUnhealthy, { programId, status: full.status }, {}, "system"));
    } else if (full.status === "crashed") {
      void getEventBus().publish(buildEvent(OBSERVABILITY_EVENTS.programCrashed, { programId, status: full.status }, {}, "system"));
    }
    return full;
  }

  getHealth(programId: ProgramId): ProgramHealth | undefined {
    return this.health.get(programId);
  }

  // ----------------------- Errors -----------------------

  recordError(programId: ProgramId, error: Omit<ProgramErrorReport, "id" | "programId" | "at"> & { at?: string }): ProgramErrorReport {
    const full: ProgramErrorReport = {
      ...error,
      id: `err_${generateId()}`,
      programId,
      at: error.at ?? getClock().iso(),
    };
    const list = this.errors.get(programId) ?? [];
    list.push(full);
    // Trim to the most-recent MAX_ERRORS_PER_PROGRAM entries.
    if (list.length > MAX_ERRORS_PER_PROGRAM) {
      list.splice(0, list.length - MAX_ERRORS_PER_PROGRAM);
    }
    this.errors.set(programId, list);
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.errorRecorded, {
        programId,
        code: full.code,
        severity: full.severity,
        message: full.message,
      }, {}, "system"),
    );
    return full;
  }

  getErrors(programId: ProgramId, filter?: ObservabilityErrorFilter): ProgramErrorReport[] {
    const list = this.errors.get(programId) ?? [];
    let filtered = [...list];
    if (filter?.severity) filtered = filtered.filter((e) => e.severity === filter.severity);
    if (filter?.code) filtered = filtered.filter((e) => e.code === filter.code);
    if (filter?.since) filtered = filtered.filter((e) => e.at >= filter.since!);
    if (filter?.until) filtered = filtered.filter((e) => e.at <= filter.until!);
    filtered.sort((a, b) => b.at.localeCompare(a.at));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  // ----------------------- Crashes -----------------------

  recordCrash(programId: ProgramId, crash: Omit<CrashReport, "id" | "programId" | "at"> & { at?: string }): CrashReport {
    const full: CrashReport = {
      ...crash,
      id: `crs_${generateId()}`,
      programId,
      at: crash.at ?? getClock().iso(),
    };
    const list = this.crashes.get(programId) ?? [];
    list.push(full);
    if (list.length > MAX_CRASHES_PER_PROGRAM) {
      list.splice(0, list.length - MAX_CRASHES_PER_PROGRAM);
    }
    this.crashes.set(programId, list);
    // A crash automatically demotes the program's health to "crashed".
    this.health.set(programId, {
      programId,
      status: "crashed",
      checkedAt: full.at,
      details: { reason: full.reason },
    });
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.crashRecorded, {
        programId,
        reason: full.reason,
        fatal: full.fatal,
        version: full.version,
      }, {}, "system"),
    );
    return full;
  }

  getCrashes(programId: ProgramId, limit = 100): CrashReport[] {
    const list = this.crashes.get(programId) ?? [];
    return [...list].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  // ----------------------- Latency -----------------------

  recordLatency(programId: ProgramId, operation: string, ms: number): LatencySample {
    if (ms < 0) ms = 0;
    const sample: LatencySample = { programId, operation, ms, at: getClock().iso() };
    let opMap = this.latency.get(programId);
    if (!opMap) {
      opMap = new Map();
      this.latency.set(programId, opMap);
    }
    let samples = opMap.get(operation) ?? [];
    samples.push(sample);
    // Bound retention: keep the most-recent MAX_SAMPLES_PER_OP samples.
    if (samples.length > MAX_SAMPLES_PER_OP) {
      samples = samples.slice(samples.length - MAX_SAMPLES_PER_OP);
    }
    opMap.set(operation, samples);
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.latencyRecorded, { programId, operation, ms }, {}, "system"),
    );
    return sample;
  }

  /** Compute p50/p95/p99 for a specific program+operation. */
  getLatencyStats(programId: ProgramId, operation: string): LatencyStats | undefined {
    const opMap = this.latency.get(programId);
    const samples = opMap?.get(operation);
    if (!samples || samples.length === 0) return undefined;
    const values = samples.map((s) => s.ms).sort((a, b) => a - b);
    return {
      operation,
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      avg: Math.round(avg(values) * 100) / 100,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
    };
  }

  listOperations(programId: ProgramId): string[] {
    const opMap = this.latency.get(programId);
    return opMap ? [...opMap.keys()] : [];
  }

  // ----------------------- Usage -----------------------

  recordUsage(programId: ProgramId, metric: string, value: number): UsageMetric {
    if (value <= 0) value = 1;
    const usage: UsageMetric = { programId, metric, value, at: getClock().iso() };
    let m = this.usage.get(programId);
    if (!m) {
      m = new Map();
      this.usage.set(programId, m);
    }
    m.set(metric, (m.get(metric) ?? 0) + value);
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.usageRecorded, { programId, metric, value }, {}, "system"),
    );
    return usage;
  }

  getUsage(programId: ProgramId): Readonly<Record<string, number>> {
    const m = this.usage.get(programId);
    if (!m) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of m) out[k] = v;
    return out;
  }

  // ----------------------- Installs -----------------------

  recordInstall(programId: ProgramId, accountId: string): InstallMetric {
    const metric: InstallMetric = {
      programId,
      accountId,
      at: getClock().iso(),
      active: true,
    };
    const list = this.installs.get(programId) ?? [];
    list.push(metric);
    this.installs.set(programId, list);
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.installRecorded, { programId, accountId }, {}, "system"),
    );
    return metric;
  }

  recordUninstall(programId: ProgramId, accountId: string): void {
    const list = this.installs.get(programId);
    if (!list) return;
    // Mark the latest install record for this account as inactive.
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].accountId === accountId && list[i].active) {
        list[i] = { ...list[i], active: false };
        break;
      }
    }
  }

  getInstallMetrics(programId: ProgramId): InstallMetricsAggregate {
    const list = this.installs.get(programId) ?? [];
    const installCount = list.length;
    const activeInstallCount = list.filter((i) => i.active).length;
    const uniqueAccounts = new Set(list.map((i) => i.accountId)).size;
    // 7-bucket trend over the last 7 * BUCKET_DURATION_MS.
    const now = getClock().epochMs();
    const trend: InstallTrendBucket[] = [];
    for (let b = INSTALL_TREND_BUCKETS - 1; b >= 0; b--) {
      const end = now - b * BUCKET_DURATION_MS;
      const start = end - BUCKET_DURATION_MS;
      const startIso = new Date(start).toISOString();
      const endIso = new Date(end).toISOString();
      let installs = 0;
      let activeInstalls = 0;
      for (const inst of list) {
        const instMs = new Date(inst.at).getTime();
        if (instMs >= start && instMs < end) installs += 1;
        if (inst.active && instMs < end) activeInstalls += 1;
      }
      trend.push({ bucketStart: startIso, bucketEnd: endIso, installs, activeInstalls });
    }
    return { programId, installCount, activeInstallCount, uniqueAccounts, trend };
  }

  // ----------------------- Upgrades -----------------------

  recordUpgrade(programId: ProgramId, fromVersion: string, toVersion: string, accountId: string): UpgradeMetric {
    const metric: UpgradeMetric = {
      programId,
      fromVersion,
      toVersion,
      accountId,
      at: getClock().iso(),
      rollback: compareVersions(toVersion, fromVersion) < 0,
    };
    const list = this.upgrades.get(programId) ?? [];
    list.push(metric);
    this.upgrades.set(programId, list);
    void getEventBus().publish(
      buildEvent(OBSERVABILITY_EVENTS.upgradeRecorded, {
        programId,
        fromVersion,
        toVersion,
        accountId,
        rollback: metric.rollback,
      }, {}, "system"),
    );
    return metric;
  }

  getUpgradeMetrics(programId: ProgramId): UpgradeMetricsAggregate {
    const list = this.upgrades.get(programId) ?? [];
    const upgradeCount = list.filter((u) => !u.rollback).length;
    const rollbackCount = list.filter((u) => u.rollback).length;
    // Version distribution: count the *resulting* version of each upgrade.
    const counts = new Map<string, number>();
    for (const u of list) {
      counts.set(u.toVersion, (counts.get(u.toVersion) ?? 0) + 1);
    }
    const total = list.length;
    const versionDistribution: VersionDistributionEntry[] = [...counts.entries()]
      .map(([version, count]) => ({
        version,
        count,
        share: total === 0 ? 0 : Math.round((count / total) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);
    const lastUpgradeAt = list.length > 0
      ? list.map((u) => u.at).sort((a, b) => b.localeCompare(a))[0]
      : undefined;
    return { programId, upgradeCount, rollbackCount, versionDistribution, lastUpgradeAt };
  }

  // ----------------------- Aggregate metrics -----------------------

  getMetrics(programId: ProgramId): ProgramMetrics {
    const errors = this.errors.get(programId) ?? [];
    const crashes = this.crashes.get(programId) ?? [];
    const opMap = this.latency.get(programId);
    const latencyByOperation: LatencyStats[] = [];
    let allSamples: number[] = [];
    if (opMap) {
      for (const [op, samples] of opMap) {
        const values = samples.map((s) => s.ms).sort((a, b) => a - b);
        if (values.length === 0) continue;
        latencyByOperation.push({
          operation: op,
          count: values.length,
          min: values[0],
          max: values[values.length - 1],
          avg: Math.round(avg(values) * 100) / 100,
          p50: percentile(values, 50),
          p95: percentile(values, 95),
          p99: percentile(values, 99),
        });
        allSamples = allSamples.concat(values);
      }
    }
    allSamples.sort((a, b) => a - b);
    const installList = this.installs.get(programId) ?? [];
    const upgradeList = this.upgrades.get(programId) ?? [];
    const health_ = this.health.get(programId);
    const lastError = errors.length > 0 ? errors[errors.length - 1] : undefined;
    const lastCrash = crashes.length > 0 ? crashes[crashes.length - 1] : undefined;
    return {
      programId,
      errorCount: errors.length,
      criticalErrorCount: errors.filter((e) => e.severity === "critical").length,
      crashCount: crashes.length,
      fatalCrashCount: crashes.filter((c) => c.fatal).length,
      avgLatencyMs: allSamples.length > 0 ? Math.round(avg(allSamples) * 100) / 100 : undefined,
      p50LatencyMs: allSamples.length > 0 ? percentile(allSamples, 50) : undefined,
      p95LatencyMs: allSamples.length > 0 ? percentile(allSamples, 95) : undefined,
      p99LatencyMs: allSamples.length > 0 ? percentile(allSamples, 99) : undefined,
      latencyByOperation,
      usageTotals: this.getUsage(programId),
      installCount: installList.length,
      activeInstallCount: installList.filter((i) => i.active).length,
      upgradeCount: upgradeList.filter((u) => !u.rollback).length,
      rollbackCount: upgradeList.filter((u) => u.rollback).length,
      lastHealthStatus: health_?.status,
      lastErrorAt: lastError?.at,
      lastCrashAt: lastCrash?.at,
      computedAt: getClock().iso(),
    };
  }

  getDiagnosticSnapshot(programId: ProgramId): DiagnosticSnapshot {
    const metrics = this.getMetrics(programId);
    const recentErrors = (this.errors.get(programId) ?? [])
      .slice(-MAX_RECENT_DIAGNOSTIC)
      .reverse();
    const recentCrashes = (this.crashes.get(programId) ?? [])
      .slice(-MAX_RECENT_DIAGNOSTIC)
      .reverse();
    return {
      programId,
      at: getClock().iso(),
      health: this.health.get(programId),
      metrics,
      recentErrors,
      recentCrashes,
      installCount: metrics.installCount,
      activeInstallCount: metrics.activeInstallCount,
      upgradeCount: metrics.upgradeCount,
    };
  }

  // ----------------------- Maintenance -----------------------

  /** Remove all observability data for a program (used on hard archive). */
  purge(programId: ProgramId): void {
    this.health.delete(programId);
    this.errors.delete(programId);
    this.crashes.delete(programId);
    this.latency.delete(programId);
    this.usage.delete(programId);
    this.installs.delete(programId);
    this.upgrades.delete(programId);
  }

  /** Reset the entire observability store (test/maintenance only). */
  reset(): void {
    this.health.clear();
    this.errors.clear();
    this.crashes.clear();
    this.latency.clear();
    this.usage.clear();
    this.installs.clear();
    this.upgrades.clear();
  }
}

// ---------------------------------------------------------------------------
// Version comparison (semver-like, handles partial versions gracefully)
// ---------------------------------------------------------------------------

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: ProgramObservability | null = null;
export function getProgramObservability(): ProgramObservability {
  if (!_mgr) _mgr = new ProgramObservability();
  return _mgr;
}
export function resetProgramObservability(): void {
  _mgr = null;
}

// Re-export for consumers
export { asProgramId, PROGRAM_EVENTS };
export type { ProgramId };
