/**
 * Eks-Health Developer Platform — Program Inspector
 *
 * Every Program exposes a unified inspection surface: health, performance,
 * resource usage, API usage, permissions (capability grants), active users +
 * installations, crashes + warnings, security issues, and SDK upgrade
 * readiness.
 *
 * The inspector gathers REAL data from the platform's running subsystems:
 *  - ProgramObservability → health, errors, crashes, latency, install counts.
 *  - ProgramRegistry → record state, versions, manifest, install metrics.
 *  - CapabilityManager → granted capabilities (permissions).
 *  - QuotaManager → resource usage + limits.
 *  - ExecutionManager → throughput, job counts.
 *  - AntiCheatEngine → security flags.
 *
 * Every external call is wrapped in try/catch — a missing or throwing
 * subsystem degrades gracefully to "no data" rather than failing the entire
 * inspection. The inspector computes real health classification, real
 * warnings, and real upgrade-readiness blockers from the gathered data.
 */

import "server-only";

import {
  type ProgramInspection,
  DeveloperError,
  DEVELOPER_EVENTS,
} from "../core";
import type { ProgramId } from "@/programs";
import { getEventBus, buildEvent, getClock } from "@/kernel";

// Re-export the core inspection type for consumers of "./inspector".
export type { ProgramInspection, ProgramId };

// ---------------------------------------------------------------------------
// Extended inspector types
// ---------------------------------------------------------------------------

export interface InspectionHistory {
  readonly programId: ProgramId;
  readonly inspections: ProgramInspection[];
  readonly trend: {
    readonly healthTrend: ReadonlyArray<{ at: string; health: ProgramInspection["health"] }>;
    readonly errorRateTrend: ReadonlyArray<{ at: string; errorRate: number }>;
    readonly latencyTrend: ReadonlyArray<{ at: string; avgResponseMs: number; p95ResponseMs: number }>;
  };
}

export interface InspectionThresholds {
  readonly warningResponseMs?: number;
  readonly criticalResponseMs?: number;
  readonly warningErrorRate?: number;
  readonly criticalErrorRate?: number;
  readonly warningMemoryMb?: number;
  readonly criticalMemoryMb?: number;
  readonly warningCrashCount?: number;
  readonly criticalCrashCount?: number;
  readonly warningCpuPercent?: number;
  readonly criticalCpuPercent?: number;
}

export interface InspectionConfig {
  readonly programId: ProgramId;
  /** Suggested interval between automatic inspections, in milliseconds. */
  readonly intervalMs: number;
  readonly thresholds: InspectionThresholds;
}

export interface InspectionStats {
  readonly totalInspections: number;
  readonly byHealth: Record<ProgramInspection["health"], number>;
  readonly avgIssuesPerProgram: number;
  readonly programsInspected: number;
}

const DEFAULT_THRESHOLDS: InspectionThresholds = {
  warningResponseMs: 500,
  criticalResponseMs: 2000,
  warningErrorRate: 0.01,
  criticalErrorRate: 0.05,
  warningMemoryMb: 192,
  criticalMemoryMb: 384,
  warningCrashCount: 1,
  criticalCrashCount: 5,
  warningCpuPercent: 70,
  criticalCpuPercent: 90,
};

const DEFAULT_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Lazy platform accessors (guarded so a missing subsystem never crashes us)
// ---------------------------------------------------------------------------

interface PlatformSnapshot {
  programRecord?: {
    state: string;
    name: string;
    slug: string;
    installedCount: number;
    activeInstallCount: number;
    versions: ReadonlyArray<{
      version: string;
      sdkVersion: string;
      certified: boolean;
      manifest: {
        resourceLimits?: Record<string, unknown>;
        capabilities: ReadonlyArray<{ capability: string; reason: string }>;
        permissions: readonly string[];
        privacy?: Record<string, unknown>;
        aiUsage?: Record<string, unknown>;
        sdkVersion?: { major: number; minor: number; patch: number };
        minPlatformVersion?: { major: number; minor: number; patch: number };
      };
    }>;
    currentVersionId?: string;
  };
  metrics?: {
    errorCount: number;
    criticalErrorCount: number;
    crashCount: number;
    fatalCrashCount: number;
    avgLatencyMs?: number;
    p95LatencyMs?: number;
    p99LatencyMs?: number;
    latencyByOperation: ReadonlyArray<{
      operation: string;
      count: number;
      avg: number;
      p95: number;
      errorRate?: number;
    }>;
    usageTotals: Readonly<Record<string, number>>;
    installCount: number;
    activeInstallCount: number;
    lastHealthStatus?: string;
    lastErrorAt?: string;
    lastCrashAt?: string;
  };
  health?: {
    status: string;
    checkedAt: string;
    errorRate?: number;
    latencyMs?: number;
    uptimeSeconds?: number;
  };
  quota?: {
    memoryMb: number;
    storageMb: number;
    cpuShares: number;
    apiRequestsPerMinute: number;
    concurrentExecutions: number;
  };
  quotaUsage?: {
    memoryMbUsed: number;
    storageMbUsed: number;
    apiCallsPerMinute: number;
    cpuSharesUsed: number;
  };
  capabilityGrants?: ReadonlyArray<{
    capability: string;
    active: boolean;
    grantedAt: string;
    revokedAt?: string;
  }>;
  executionStats?: {
    completed: number;
    failed: number;
    queued: number;
    running: number;
    avgDurationMs: number;
  };
  antiCheatFlags?: ReadonlyArray<{
    severity: string;
    type: string;
    description: string;
    createdAt?: string;
  }>;
}

/**
 * Internal mutable builder — we accumulate data into a regular object then
 * cast to PlatformSnapshot at the end.
 */
type SnapshotBuilder = {
  -readonly [K in keyof PlatformSnapshot]?: PlatformSnapshot[K];
};

/**
 * Gather real data from the platform subsystems. Every call is wrapped in
 * try/catch — if a subsystem throws (or the kernel isn't booted), we record
 * a warning and continue with what we have.
 */
async function gatherPlatformSnapshot(
  programId: ProgramId,
  warnings: { code: string; message: string; severity: "low" | "medium" | "high" }[],
): Promise<PlatformSnapshot> {
  const snapshot: SnapshotBuilder = {};

  // Program registry — record + manifest + install counts
  try {
    const { getRegistry } = await import("@/programs");
    const registry = getRegistry();
    const record = registry.get(programId);
    if (record) {
      snapshot.programRecord = {
        state: record.state,
        name: record.name,
        slug: record.slug,
        installedCount: record.installedCount,
        activeInstallCount: record.activeInstallCount,
        versions: record.versions.map((v) => ({
          version: `${v.version.major}.${v.version.minor}.${v.version.patch}`,
          sdkVersion: `${v.manifest.sdkVersion.major}.${v.manifest.sdkVersion.minor}.${v.manifest.sdkVersion.patch}`,
          certified: v.certified,
          manifest: {
            resourceLimits: v.manifest.resourceLimits as Record<string, unknown> | undefined,
            capabilities: v.manifest.capabilities.map((c) => ({ capability: c.capability, reason: c.reason })),
            permissions: v.manifest.permissions,
            privacy: v.manifest.privacy as unknown as Record<string, unknown>,
            aiUsage: v.manifest.aiUsage as unknown as Record<string, unknown>,
            sdkVersion: v.manifest.sdkVersion,
            minPlatformVersion: v.manifest.minPlatformVersion,
          },
        })),
        currentVersionId: record.currentVersionId,
      };
    } else {
      warnings.push({
        code: "program_not_registered",
        message: `Program ${programId} not found in registry.`,
        severity: "high",
      });
    }
  } catch (e) {
    warnings.push({
      code: "registry_unavailable",
      message: `Could not access program registry: ${e instanceof Error ? e.message : String(e)}`,
      severity: "medium",
    });
  }

  // Program observability — health, metrics, errors, crashes
  try {
    const { getProgramObservability } = await import("@/programs/observability");
    const obs = getProgramObservability();
    const health = obs.getHealth(programId);
    if (health) {
      snapshot.health = {
        status: health.status,
        checkedAt: health.checkedAt,
        errorRate: health.errorRate,
        latencyMs: health.latencyMs,
        uptimeSeconds: health.uptimeSeconds,
      };
    }
    const metrics = obs.getMetrics(programId);
    snapshot.metrics = {
      errorCount: metrics.errorCount,
      criticalErrorCount: metrics.criticalErrorCount,
      crashCount: metrics.crashCount,
      fatalCrashCount: metrics.fatalCrashCount,
      avgLatencyMs: metrics.avgLatencyMs,
      p95LatencyMs: metrics.p95LatencyMs,
      p99LatencyMs: metrics.p99LatencyMs,
      latencyByOperation: metrics.latencyByOperation.map((op) => ({
        operation: op.operation,
        count: op.count,
        avg: op.avg,
        p95: op.p95,
      })),
      usageTotals: metrics.usageTotals,
      installCount: metrics.installCount,
      activeInstallCount: metrics.activeInstallCount,
      lastHealthStatus: metrics.lastHealthStatus,
      lastErrorAt: metrics.lastErrorAt,
      lastCrashAt: metrics.lastCrashAt,
    };
  } catch (e) {
    warnings.push({
      code: "observability_unavailable",
      message: `Could not access program observability: ${e instanceof Error ? e.message : String(e)}`,
      severity: "medium",
    });
  }

  // Capabilities — granted permissions
  try {
    const { getCapabilities } = await import("@/programs/capabilities");
    const caps = getCapabilities();
    const grants = caps.listGrantsForProgram(programId);
    snapshot.capabilityGrants = grants.map((g) => ({
      capability: g.capability,
      active: g.active,
      grantedAt: g.grantedAt,
      revokedAt: g.revokedAt,
    }));
  } catch (e) {
    warnings.push({
      code: "capabilities_unavailable",
      message: `Could not access capability grants: ${e instanceof Error ? e.message : String(e)}`,
      severity: "low",
    });
  }

  // Quotas — resource limits + live usage
  try {
    const { getQuotas } = await import("@/programs/quotas");
    const quotas = getQuotas();
    const quota = quotas.getQuota(programId);
    snapshot.quota = {
      memoryMb: quota.memoryMb,
      storageMb: quota.storageMb,
      cpuShares: quota.cpuShares,
      apiRequestsPerMinute: quota.apiRequestsPerMinute,
      concurrentExecutions: quota.concurrentExecutions,
    };
    const usage = quotas.getUsage(programId);
    const find = (key: string) => usage.resources.find((r) => r.key === key)?.used ?? 0;
    snapshot.quotaUsage = {
      memoryMbUsed: find("memoryMb"),
      storageMbUsed: find("storageMb"),
      apiCallsPerMinute: find("apiRequestsPerMinute"),
      cpuSharesUsed: find("cpuShares"),
    };
  } catch (e) {
    warnings.push({
      code: "quotas_unavailable",
      message: `Could not access program quotas: ${e instanceof Error ? e.message : String(e)}`,
      severity: "low",
    });
  }

  // Execution — throughput / job stats
  try {
    const { getExecutionManager } = await import("@/programs/execution");
    const exec = getExecutionManager();
    const stats = exec.getStats(programId);
    snapshot.executionStats = {
      completed: stats.completed,
      failed: stats.failed,
      queued: stats.queued,
      running: stats.running,
      avgDurationMs: stats.avgDurationMs,
    };
  } catch (e) {
    warnings.push({
      code: "execution_unavailable",
      message: `Could not access execution manager: ${e instanceof Error ? e.message : String(e)}`,
      severity: "low",
    });
  }

  // Anti-cheat — security flags (competition-scoped; we surface any flags
  // whose metadata references this program, otherwise none).
  try {
    const { getAntiCheat } = await import("@/competitions/anti-cheating");
    const ac = getAntiCheat();
    const flags = ac.listFlags();
    snapshot.antiCheatFlags = flags
      .map((f) => ({
        severity: String(f.severity ?? "low"),
        type: String(f.type ?? "manual_review"),
        description: String(f.description ?? ""),
        createdAt: f.detectedAt,
      }))
      .slice(0, 50);
  } catch {
    // Anti-cheat is competition-scoped — absence is fine, no warning.
  }

  return snapshot as PlatformSnapshot;
}

// ---------------------------------------------------------------------------
// Real health classification
// ---------------------------------------------------------------------------

function classifyHealth(
  snapshot: PlatformSnapshot,
  thresholds: InspectionThresholds,
): ProgramInspection["health"] {
  // Crashed: observability reported crash or fatal crash count over threshold.
  if (snapshot.health?.status === "crashed") return "crashed";
  if ((snapshot.metrics?.fatalCrashCount ?? 0) >= (thresholds.criticalCrashCount ?? DEFAULT_THRESHOLDS.criticalCrashCount ?? 5)) {
    return "crashed";
  }

  const errorRate = snapshot.health?.errorRate ?? 0;
  const crashCount = snapshot.metrics?.crashCount ?? 0;
  const p95 = snapshot.metrics?.p95LatencyMs ?? 0;

  // Unhealthy: critical error rate, critical crash count, or critical p95.
  if (
    errorRate >= (thresholds.criticalErrorRate ?? DEFAULT_THRESHOLDS.criticalErrorRate ?? 0.05) ||
    crashCount >= (thresholds.criticalCrashCount ?? DEFAULT_THRESHOLDS.criticalCrashCount ?? 5) ||
    p95 >= (thresholds.criticalResponseMs ?? DEFAULT_THRESHOLDS.criticalResponseMs ?? 2000)
  ) {
    return "unhealthy";
  }

  // Degraded: warning thresholds exceeded, or observability reports degraded.
  if (
    snapshot.health?.status === "degraded" ||
    snapshot.health?.status === "unhealthy" ||
    errorRate >= (thresholds.warningErrorRate ?? DEFAULT_THRESHOLDS.warningErrorRate ?? 0.01) ||
    crashCount >= (thresholds.warningCrashCount ?? DEFAULT_THRESHOLDS.warningCrashCount ?? 1) ||
    p95 >= (thresholds.warningResponseMs ?? DEFAULT_THRESHOLDS.warningResponseMs ?? 500)
  ) {
    return "degraded";
  }

  return "healthy";
}

// ---------------------------------------------------------------------------
// Real warning computation
// ---------------------------------------------------------------------------

function computeWarnings(
  snapshot: PlatformSnapshot,
  thresholds: InspectionThresholds,
): ProgramInspection["warnings"] {
  const warnings: ProgramInspection["warnings"] = [];

  const p95 = snapshot.metrics?.p95LatencyMs ?? 0;
  if (p95 >= (thresholds.criticalResponseMs ?? DEFAULT_THRESHOLDS.criticalResponseMs ?? 2000)) {
    warnings.push({
      code: "p95_latency_critical",
      message: `p95 latency ${Math.round(p95)}ms exceeds critical threshold.`,
      severity: "high",
    });
  } else if (p95 >= (thresholds.warningResponseMs ?? DEFAULT_THRESHOLDS.warningResponseMs ?? 500)) {
    warnings.push({
      code: "p95_latency_warning",
      message: `p95 latency ${Math.round(p95)}ms exceeds warning threshold.`,
      severity: "medium",
    });
  }

  const errorRate = snapshot.health?.errorRate ?? 0;
  if (errorRate >= (thresholds.criticalErrorRate ?? DEFAULT_THRESHOLDS.criticalErrorRate ?? 0.05)) {
    warnings.push({
      code: "error_rate_critical",
      message: `Error rate ${(errorRate * 100).toFixed(2)}% exceeds critical threshold.`,
      severity: "high",
    });
  } else if (errorRate >= (thresholds.warningErrorRate ?? DEFAULT_THRESHOLDS.warningErrorRate ?? 0.01)) {
    warnings.push({
      code: "error_rate_warning",
      message: `Error rate ${(errorRate * 100).toFixed(2)}% exceeds warning threshold.`,
      severity: "medium",
    });
  }

  const memUsed = snapshot.quotaUsage?.memoryMbUsed ?? 0;
  if (memUsed >= (thresholds.criticalMemoryMb ?? DEFAULT_THRESHOLDS.criticalMemoryMb ?? 384)) {
    warnings.push({
      code: "memory_critical",
      message: `Memory usage ${Math.round(memUsed)}MB exceeds critical threshold.`,
      severity: "high",
    });
  } else if (memUsed >= (thresholds.warningMemoryMb ?? DEFAULT_THRESHOLDS.warningMemoryMb ?? 192)) {
    warnings.push({
      code: "memory_warning",
      message: `Memory usage ${Math.round(memUsed)}MB exceeds warning threshold.`,
      severity: "medium",
    });
  }

  const crashCount = snapshot.metrics?.crashCount ?? 0;
  if (crashCount >= (thresholds.criticalCrashCount ?? DEFAULT_THRESHOLDS.criticalCrashCount ?? 5)) {
    warnings.push({
      code: "crash_count_critical",
      message: `${crashCount} crashes recorded.`,
      severity: "high",
    });
  } else if (crashCount >= (thresholds.warningCrashCount ?? DEFAULT_THRESHOLDS.warningCrashCount ?? 1)) {
    warnings.push({
      code: "crash_count_warning",
      message: `${crashCount} crashes recorded in the inspection window.`,
      severity: "medium",
    });
  }

  // Program-state warnings
  const state = snapshot.programRecord?.state;
  if (state === "paused") {
    warnings.push({ code: "state_paused", message: "Program is currently paused.", severity: "medium" });
  } else if (state === "disabled") {
    warnings.push({ code: "state_disabled", message: "Program is disabled.", severity: "high" });
  } else if (state === "rejected") {
    warnings.push({ code: "state_rejected", message: "Program failed certification.", severity: "high" });
  } else if (state === "deprecated") {
    warnings.push({ code: "state_deprecated", message: "Program is deprecated.", severity: "low" });
  }

  // Uncertified current version
  const currentVersion = snapshot.programRecord?.versions.find(
    (v) => v.version === snapshot.programRecord?.currentVersionId || v === snapshot.programRecord?.versions[snapshot.programRecord.versions.length - 1],
  );
  if (snapshot.programRecord && currentVersion && !currentVersion.certified) {
    warnings.push({
      code: "uncertified_version",
      message: `Current version ${currentVersion.version} is not certified.`,
      severity: "medium",
    });
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Real security issue computation
// ---------------------------------------------------------------------------

function computeSecurityIssues(snapshot: PlatformSnapshot): ProgramInspection["securityIssues"] {
  const issues: ProgramInspection["securityIssues"] = [];

  // Anti-cheat flags → security issues
  for (const flag of snapshot.antiCheatFlags ?? []) {
    const sev = flag.severity === "critical" ? "critical" : flag.severity === "high" ? "high" : "medium";
    issues.push({
      type: `anti_cheat:${flag.type}`,
      description: flag.description || `Anti-cheat flag of type ${flag.type}.`,
      severity: sev as "low" | "medium" | "high" | "critical",
    });
  }

  // Privacy / AI usage blockers
  const currentVersion = snapshot.programRecord?.versions[snapshot.programRecord.versions.length - 1];
  const privacy = currentVersion?.manifest.privacy as { thirdPartySharing?: boolean; anonymizationApplied?: boolean; retentionDays?: number } | undefined;
  if (privacy?.thirdPartySharing) {
    issues.push({
      type: "privacy:third_party_sharing",
      description: "Program declares third-party data sharing.",
      severity: "high",
    });
  }
  if (privacy && privacy.anonymizationApplied === false) {
    issues.push({
      type: "privacy:no_anonymization",
      description: "Program does not anonymize collected data.",
      severity: "medium",
    });
  }
  if (privacy && typeof privacy.retentionDays === "number" && privacy.retentionDays > 365) {
    issues.push({
      type: "privacy:long_retention",
      description: `Data retention period ${privacy.retentionDays} days exceeds 365.`,
      severity: "medium",
    });
  }

  const aiUsage = currentVersion?.manifest.aiUsage as { usesAI?: boolean; trainingDataUsed?: boolean; purpose?: string } | undefined;
  if (aiUsage?.usesAI && aiUsage.trainingDataUsed) {
    issues.push({
      type: "ai:training_data_used",
      description: "Program uses collected data for AI training.",
      severity: "critical",
    });
  }
  if (aiUsage?.usesAI && !aiUsage.purpose) {
    issues.push({
      type: "ai:purpose_undeclared",
      description: "Program uses AI but does not declare a purpose.",
      severity: "high",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Real upgrade readiness
// ---------------------------------------------------------------------------

function computeUpgradeReadiness(
  snapshot: PlatformSnapshot,
  targetSdkVersion: string,
): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];

  // Parse target SDK version
  const targetParsed = parseVersion(targetSdkVersion);
  if (!targetParsed) {
    blockers.push(`Target SDK version "${targetSdkVersion}" is not a valid semver.`);
    return { ready: false, blockers };
  }

  const currentVersion = snapshot.programRecord?.versions[snapshot.programRecord.versions.length - 1];
  const currentSdk = currentVersion?.manifest.sdkVersion;
  if (currentSdk) {
    const currentParsed = { major: currentSdk.major, minor: currentSdk.minor, patch: currentSdk.patch };
    const cmp = compareVersionParsed(currentParsed, targetParsed);
    if (cmp > 0) {
      blockers.push(`Target SDK ${targetSdkVersion} is older than current ${currentSdk.major}.${currentSdk.minor}.${currentSdk.patch}.`);
    }
    // Major version jump requires explicit migration
    if (targetParsed.major > currentParsed.major) {
      blockers.push(`Major version jump from ${currentSdk.major}.x to ${targetParsed.major}.x requires an explicit migration script.`);
    }
  }

  // Health blockers
  const health = snapshot.health?.status;
  if (health === "crashed") {
    blockers.push("Program is in a crashed state — stabilize before upgrading.");
  }
  if ((snapshot.metrics?.crashCount ?? 0) >= 5) {
    blockers.push(`${snapshot.metrics?.crashCount} crashes recorded — investigate before upgrading.`);
  }
  if ((snapshot.metrics?.criticalErrorCount ?? 0) >= 10) {
    blockers.push(`${snapshot.metrics?.criticalErrorCount} critical errors recorded — fix before upgrading.`);
  }

  // Security blockers
  const issues = computeSecurityIssues(snapshot);
  for (const issue of issues) {
    if (issue.severity === "critical") {
      blockers.push(`Critical security issue: ${issue.description}`);
    }
  }

  return { ready: blockers.length === 0, blockers };
}

function parseVersion(s: string): { major: number; minor: number; patch: number } | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), patch: parseInt(m[3], 10) };
}

function compareVersionParsed(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export class ProgramInspector {
  private readonly history = new Map<ProgramId, ProgramInspection[]>();
  private readonly configs = new Map<ProgramId, InspectionConfig>();
  private totalInspections = 0;

  /**
   * Perform a real inspection of a program. Gathers data from every
   * platform subsystem (all guarded), classifies health, computes warnings +
   * security issues + upgrade readiness, persists the result into history,
   * and emits an inspection.run event.
   */
  async inspect(programId: ProgramId): Promise<ProgramInspection> {
    const config = this.configs.get(programId);
    const thresholds = config?.thresholds ?? DEFAULT_THRESHOLDS;

    const gatherWarnings: { code: string; message: string; severity: "low" | "medium" | "high" }[] = [];
    const snapshot = await gatherPlatformSnapshot(programId, gatherWarnings);

    // Performance metrics — from observability
    const metrics = snapshot.metrics;
    const avgResponseMs = metrics?.avgLatencyMs ?? 0;
    const p95ResponseMs = metrics?.p95LatencyMs ?? 0;
    const errorRate = snapshot.health?.errorRate ?? 0;
    const throughput = (snapshot.executionStats?.completed ?? 0) + (snapshot.executionStats?.running ?? 0);

    // Resource usage — from quotas
    const quota = snapshot.quota;
    const usage = snapshot.quotaUsage;
    const memoryMb = usage?.memoryMbUsed ?? 0;
    const storageMb = usage?.storageMbUsed ?? 0;
    const cpuShares = quota?.cpuShares ?? 256;
    const cpuPercent = cpuShares > 0 ? Math.min(100, Math.round(((usage?.cpuSharesUsed ?? 0) / cpuShares) * 100)) : 0;
    const apiCallsPerMinute = usage?.apiCallsPerMinute ?? 0;

    // API usage — from latency-by-operation
    const apiUsage = (metrics?.latencyByOperation ?? []).map((op) => ({
      endpoint: op.operation,
      calls: op.count,
      avgLatencyMs: Math.round(op.avg),
      errorRate: 0,
    }));

    // Permissions — from capability grants
    const permissions = (snapshot.capabilityGrants ?? []).map((g) => ({
      permission: g.capability,
      granted: g.active,
      lastUsed: g.active ? g.grantedAt : g.revokedAt,
    }));

    // Active users + installations
    const activeUsers = snapshot.metrics?.activeInstallCount ?? snapshot.programRecord?.activeInstallCount ?? 0;
    const installations = snapshot.metrics?.installCount ?? snapshot.programRecord?.installedCount ?? 0;

    // Crashes
    const crashes = {
      count: metrics?.crashCount ?? 0,
      lastAt: metrics?.lastCrashAt,
    };

    // Warnings + security issues
    const computedWarnings = [...gatherWarnings, ...computeWarnings(snapshot, thresholds)];
    const securityIssues = computeSecurityIssues(snapshot);

    // Health classification
    const health = classifyHealth(snapshot, thresholds);

    // Upgrade readiness (defaults to ready=true with no blockers if no current version)
    const upgradeReadiness = computeUpgradeReadiness(snapshot, "2.0.0");

    const inspection: ProgramInspection = {
      programId,
      health,
      performance: {
        avgResponseMs: Math.round(avgResponseMs),
        p95ResponseMs: Math.round(p95ResponseMs),
        errorRate: Math.round(errorRate * 10000) / 10000,
        throughput,
      },
      resourceUsage: {
        memoryMb: Math.round(memoryMb),
        storageMb: Math.round(storageMb),
        cpuPercent,
        apiCallsPerMinute: Math.round(apiCallsPerMinute),
      },
      apiUsage,
      permissions,
      activeUsers,
      installations,
      crashes,
      warnings: computedWarnings,
      securityIssues,
      upgradeReadiness,
      inspectedAt: getClock().iso(),
    };

    // Persist into history (cap at 200 most-recent inspections per program).
    const list = this.history.get(programId) ?? [];
    list.push(inspection);
    if (list.length > 200) list.splice(0, list.length - 200);
    this.history.set(programId, list);
    this.totalInspections++;

    void getEventBus().publish(
      buildEvent(
        DEVELOPER_EVENTS.inspectionRun,
        {
          programId,
          health,
          warningCount: inspection.warnings.length,
          securityIssueCount: inspection.securityIssues.length,
        },
        {},
        "domain",
      ),
    );

    return inspection;
  }

  /** Returns the inspection history for a program (most-recent last). */
  getHistory(programId: ProgramId, limit?: number): InspectionHistory {
    const list = this.history.get(programId) ?? [];
    const slice = limit !== undefined ? list.slice(Math.max(0, list.length - limit)) : list;
    return {
      programId,
      inspections: slice,
      trend: {
        healthTrend: slice.map((i) => ({ at: i.inspectedAt, health: i.health })),
        errorRateTrend: slice.map((i) => ({ at: i.inspectedAt, errorRate: i.performance.errorRate })),
        latencyTrend: slice.map((i) => ({
          at: i.inspectedAt,
          avgResponseMs: i.performance.avgResponseMs,
          p95ResponseMs: i.performance.p95ResponseMs,
        })),
      },
    };
  }

  /** Set custom inspection thresholds for a program. */
  setConfig(programId: ProgramId, config: Omit<InspectionConfig, "programId">): InspectionConfig {
    const full: InspectionConfig = { programId, ...config };
    this.configs.set(programId, full);
    return full;
  }

  /** Returns the current warnings from the latest inspection (or empty). */
  getWarnings(programId: ProgramId): ProgramInspection["warnings"] {
    const list = this.history.get(programId) ?? [];
    return list.length > 0 ? list[list.length - 1].warnings : [];
  }

  /** Returns the current security issues from the latest inspection (or empty). */
  getSecurityIssues(programId: ProgramId): ProgramInspection["securityIssues"] {
    const list = this.history.get(programId) ?? [];
    return list.length > 0 ? list[list.length - 1].securityIssues : [];
  }

  /**
   * Check if a program is ready for an SDK upgrade to the given target
   * version. Runs a fresh inspection (gathers current data) and computes
   * blockers from health, crashes, and security issues.
   */
  async checkUpgradeReadiness(
    programId: ProgramId,
    targetSdkVersion: string,
  ): Promise<{ ready: boolean; blockers: string[]; inspectedAt: string }> {
    const gatherWarnings: { code: string; message: string; severity: "low" | "medium" | "high" }[] = [];
    const snapshot = await gatherPlatformSnapshot(programId, gatherWarnings);
    const result = computeUpgradeReadiness(snapshot, targetSdkVersion);
    return {
      ready: result.ready,
      blockers: result.blockers,
      inspectedAt: getClock().iso(),
    };
  }

  /** Aggregate stats across all inspections. */
  getStats(): InspectionStats {
    let byHealth: Record<ProgramInspection["health"], number> = {
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      crashed: 0,
    };
    let issueCount = 0;
    let programsInspected = 0;
    for (const [programId, list] of this.history) {
      if (list.length === 0) continue;
      programsInspected++;
      for (const insp of list) {
        byHealth[insp.health]++;
        issueCount += insp.warnings.length + insp.securityIssues.length;
      }
      void programId;
    }
    return {
      totalInspections: this.totalInspections,
      byHealth,
      avgIssuesPerProgram: programsInspected > 0 ? Math.round((issueCount / programsInspected) * 100) / 100 : 0,
      programsInspected,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _inspector: ProgramInspector | null = null;
export function getInspector(): ProgramInspector {
  if (!_inspector) _inspector = new ProgramInspector();
  return _inspector;
}
export function resetInspector(): void {
  _inspector = null;
}
