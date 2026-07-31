/**
 * Eks-Health Program OS — Lifecycle & Registry
 *
 * The complete program lifecycle: create, develop, build, package, sign,
 * validate, upload, publish, review, install, activate, pause, resume,
 * disable, deprecate, archive, transfer, fork, rollback, uninstall.
 *
 * Enforces the state machine: only valid transitions are allowed.
 * The registry is the source of truth for what programs exist.
 */

import "server-only";
import {
  type ProgramId,
  type ProgramVersionId,
  type DeveloperId,
  type SemVer,
  type ProgramState,
  type ProgramLifecycleEvent,
  type ReleaseChannel,
  type ResourceQuota,
  ProgramError,
  asProgramId,
  asProgramVersionId,
  DEFAULT_PROGRAM_QUOTA,
} from "../core";
import { compareSemVer, semVerToString, parseSemVer } from "../core";
import type { ProgramManifest } from "../manifests";
import { manifestFingerprint } from "../manifests";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { PROGRAM_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Program record (registry entry)
// ---------------------------------------------------------------------------

export interface ProgramRecord {
  readonly id: ProgramId;
  readonly slug: string;
  readonly name: string;
  readonly kind: "program" | "extension";
  readonly developerId: DeveloperId;
  readonly category: string;
  readonly state: ProgramState;
  readonly currentVersionId?: ProgramVersionId;
  readonly versions: ProgramVersion[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
  readonly installedCount: number;
  readonly activeInstallCount: number;
  readonly rating?: number;
  readonly reviewCount: number;
  readonly ownershipHistory: OwnershipTransfer[];
  readonly forkedFrom?: ProgramId;
}

export interface ProgramVersion {
  readonly id: ProgramVersionId;
  readonly version: SemVer;
  readonly channel: ReleaseChannel;
  readonly manifest: ProgramManifest;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly certified: boolean;
  readonly certificationId?: string;
  readonly deprecated?: boolean;
  readonly releaseNotes?: string;
}

export interface OwnershipTransfer {
  readonly from: DeveloperId;
  readonly to: DeveloperId;
  readonly at: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<ProgramState, ProgramState[]> = {
  draft: ["built", "archived"],
  built: ["signed", "draft"],
  signed: ["validated", "built"],
  validated: ["uploaded", "signed"],
  uploaded: ["in_review", "archived"],
  in_review: ["certified", "rejected"],
  certified: ["published", "uploaded"],
  rejected: ["draft", "archived"],
  published: ["installed", "deprecated", "archived"],
  installed: ["active", "uninstalled"],
  active: ["paused", "disabled", "uninstalled"],
  paused: ["active", "disabled", "uninstalled"],
  disabled: ["active", "archived", "uninstalled"],
  deprecated: ["archived"],
  archived: [],
  uninstalled: [],
};

export function canTransition(from: ProgramState, to: ProgramState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

function assertTransition(from: ProgramState, to: ProgramState): void {
  if (!canTransition(from, to)) {
    throw new ProgramError({
      code: "eks.program.lifecycle.invalid_transition",
      category: "state_conflict",
      message: `Cannot transition from ${from} to ${to}.`,
      userMessage: `This action is not allowed in the current state (${from}).`,
      metadata: { from, to, allowed: TRANSITIONS[from] },
    });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle manager / registry
// ---------------------------------------------------------------------------

export class ProgramRegistry {
  private readonly programs = new Map<ProgramId, ProgramRecord>();
  private readonly bySlug = new Map<string, ProgramId>();
  private readonly byDeveloper = new Map<DeveloperId, ProgramId[]>();
  private readonly auditLog: LifecycleAuditEntry[] = [];

  /** Register a new program from a manifest (draft state). */
  create(manifest: ProgramManifest, developerId: DeveloperId): ProgramRecord {
    if (this.bySlug.has(manifest.slug)) {
      throw new ProgramError({
        code: "eks.program.duplicate_slug",
        category: "state_conflict",
        message: `Program slug '${manifest.slug}' already exists.`,
        userMessage: "A program with this slug already exists.",
      });
    }
    const now = getClock().iso();
    const record: ProgramRecord = {
      id: manifest.id,
      slug: manifest.slug,
      name: manifest.name,
      kind: manifest.kind,
      developerId,
      category: manifest.category,
      state: "draft",
      versions: [],
      createdAt: now,
      updatedAt: now,
      installedCount: 0,
      activeInstallCount: 0,
      reviewCount: 0,
      ownershipHistory: [],
    };
    this.programs.set(record.id, record);
    this.bySlug.set(record.slug, record.id);
    const dList = this.byDeveloper.get(developerId) ?? [];
    this.byDeveloper.set(developerId, [...dList, record.id]);
    this.recordAudit(record.id, "created", { developerId, name: manifest.name });
    void getEventBus().publish(buildEvent(PROGRAM_EVENTS.created, { programId: record.id, slug: record.slug, developerId }, {}, "domain"));
    return record;
  }

  /** Add a new version (built + signed manifest). */
  addVersion(programId: ProgramId, manifest: ProgramManifest, channel: ReleaseChannel, releaseNotes?: string): ProgramVersion {
    const record = this.require(programId);
    const version: ProgramVersion = {
      id: asProgramVersionId(generateId("ver_")),
      version: manifest.version,
      channel,
      manifest,
      fingerprint: manifestFingerprint(manifest),
      createdAt: getClock().iso(),
      certified: false,
      releaseNotes,
    };
    // Check version doesn't already exist
    if (record.versions.some((v) => compareSemVer(v.version, manifest.version) === 0)) {
      throw new ProgramError({
        code: "eks.program.version.duplicate",
        category: "version_conflict",
        message: `Version ${semVerToString(manifest.version)} already exists.`,
        userMessage: "This version already exists.",
      });
    }
    this.update(programId, (r) => ({
      ...r,
      versions: [...r.versions, version],
      currentVersionId: r.currentVersionId ?? version.id,
      state: r.state === "draft" ? "built" : r.state,
      updatedAt: getClock().iso(),
    }));
    this.recordAudit(programId, "built", { version: semVerToString(manifest.version), channel });
    void getEventBus().publish(buildEvent(PROGRAM_EVENTS.built, { programId, version: semVerToString(manifest.version), channel }, {}, "domain"));
    return version;
  }

  /** Transition a program to a new state. */
  transition(programId: ProgramId, to: ProgramState, metadata?: Record<string, unknown>): ProgramRecord {
    const record = this.require(programId);
    assertTransition(record.state, to);
    const event = this.transitionToEvent(to);
    this.update(programId, (r) => ({
      ...r,
      state: to,
      publishedAt: to === "published" ? getClock().iso() : r.publishedAt,
      updatedAt: getClock().iso(),
    }));
    this.recordAudit(programId, event, metadata);
    if (event) {
      void getEventBus().publish(buildEvent(event, { programId, to, ...metadata }, {}, "domain"));
    }
    return this.programs.get(programId)!;
  }

  /** Roll back to a previous version. */
  rollback(programId: ProgramId, targetVersionId: ProgramVersionId): ProgramRecord {
    const record = this.require(programId);
    const target = record.versions.find((v) => v.id === targetVersionId);
    if (!target) {
      throw new ProgramError({
        code: "eks.program.version.not_found",
        category: "not_found",
        message: `Version ${targetVersionId} not found.`,
        userMessage: "Target version not found.",
      });
    }
    this.update(programId, (r) => ({
      ...r,
      currentVersionId: target.id,
      updatedAt: getClock().iso(),
    }));
    this.recordAudit(programId, "rolled_back", { to: targetVersionId, version: semVerToString(target.version) });
    void getEventBus().publish(buildEvent(PROGRAM_EVENTS.rolledBack, { programId, toVersion: semVerToString(target.version) }, {}, "domain"));
    return this.programs.get(programId)!;
  }

  /** Transfer ownership to a new developer. */
  transferOwnership(programId: ProgramId, to: DeveloperId, reason: string): ProgramRecord {
    const record = this.require(programId);
    const transfer: OwnershipTransfer = { from: record.developerId, to, at: getClock().iso(), reason };
    this.update(programId, (r) => ({
      ...r,
      developerId: to,
      ownershipHistory: [...r.ownershipHistory, transfer],
      updatedAt: getClock().iso(),
    }));
    // Update developer index
    const oldList = this.byDeveloper.get(record.developerId) ?? [];
    this.byDeveloper.set(record.developerId, oldList.filter((id) => id !== programId));
    const newList = this.byDeveloper.get(to) ?? [];
    this.byDeveloper.set(to, [...newList, programId]);
    this.recordAudit(programId, "transferred", { from: transfer.from, to, reason });
    return this.programs.get(programId)!;
  }

  /** Fork a program into a new one (new id, new slug). */
  fork(programId: ProgramId, newSlug: string, developerId: DeveloperId): ProgramRecord {
    const source = this.require(programId);
    if (this.bySlug.has(newSlug)) {
      throw new ProgramError({ code: "eks.program.duplicate_slug", category: "state_conflict", message: `Slug ${newSlug} taken.`, userMessage: "Slug already exists." });
    }
    const now = getClock().iso();
    const forked: ProgramRecord = {
      id: asProgramId(generateId(`prg_${newSlug.replace(/-/g, "_")}`)),
      slug: newSlug,
      name: `${source.name} (fork)`,
      kind: source.kind,
      developerId,
      category: source.category,
      state: "draft",
      versions: [],
      createdAt: now,
      updatedAt: now,
      installedCount: 0,
      activeInstallCount: 0,
      reviewCount: 0,
      ownershipHistory: [],
      forkedFrom: source.id,
    };
    this.programs.set(forked.id, forked);
    this.bySlug.set(newSlug, forked.id);
    const dList = this.byDeveloper.get(developerId) ?? [];
    this.byDeveloper.set(developerId, [...dList, forked.id]);
    this.recordAudit(forked.id, "forked", { from: source.id, slug: newSlug });
    void getEventBus().publish(buildEvent(PROGRAM_EVENTS.created, { programId: forked.id, slug: newSlug, forkedFrom: source.id }, {}, "domain"));
    return forked;
  }

  /** Mark a version as certified. */
  markCertified(programId: ProgramId, versionId: ProgramVersionId, certificationId: string): void {
    this.update(programId, (r) => ({
      ...r,
      versions: r.versions.map((v) => v.id === versionId ? { ...v, certified: true, certificationId } : v),
      state: r.state === "in_review" ? "certified" : r.state,
      updatedAt: getClock().iso(),
    }));
    this.recordAudit(programId, "certified", { versionId, certificationId });
    void getEventBus().publish(buildEvent(PROGRAM_EVENTS.certified, { programId, versionId, certificationId }, {}, "domain"));
  }

  get(id: ProgramId): ProgramRecord | undefined {
    return this.programs.get(id);
  }

  getBySlug(slug: string): ProgramRecord | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.programs.get(id) : undefined;
  }

  list(filter?: { developerId?: DeveloperId; state?: ProgramState; category?: string }): ProgramRecord[] {
    let list = [...this.programs.values()];
    if (filter?.developerId) list = list.filter((p) => p.developerId === filter.developerId);
    if (filter?.state) list = list.filter((p) => p.state === filter.state);
    if (filter?.category) list = list.filter((p) => p.category === filter.category);
    return list;
  }

  listByDeveloper(developerId: DeveloperId): ProgramRecord[] {
    return (this.byDeveloper.get(developerId) ?? []).map((id) => this.programs.get(id)!).filter(Boolean);
  }

  getAuditLog(programId?: ProgramId): readonly LifecycleAuditEntry[] {
    return programId ? this.auditLog.filter((a) => a.programId === programId) : this.auditLog;
  }

  /** Compute the effective quota for a program (manifest limits capped by defaults). */
  getEffectiveQuota(programId: ProgramId): ResourceQuota {
    const record = this.require(programId);
    const version = record.versions.find((v) => v.id === record.currentVersionId);
    const limits = version?.manifest.resourceLimits ?? {};
    return {
      cpuShares: limits.cpuShares ?? DEFAULT_PROGRAM_QUOTA.cpuShares,
      memoryMb: limits.memoryMb ?? DEFAULT_PROGRAM_QUOTA.memoryMb,
      storageMb: limits.storageMb ?? DEFAULT_PROGRAM_QUOTA.storageMb,
      apiRequestsPerMinute: limits.apiRequestsPerMinute ?? DEFAULT_PROGRAM_QUOTA.apiRequestsPerMinute,
      backgroundJobs: limits.backgroundJobs ?? DEFAULT_PROGRAM_QUOTA.backgroundJobs,
      notificationsPerDay: limits.notificationsPerDay ?? DEFAULT_PROGRAM_QUOTA.notificationsPerDay,
      scheduledJobs: limits.scheduledJobs ?? DEFAULT_PROGRAM_QUOTA.scheduledJobs,
      concurrentExecutions: limits.concurrentExecutions ?? DEFAULT_PROGRAM_QUOTA.concurrentExecutions,
      aiRequestsPerDay: limits.aiRequestsPerDay ?? DEFAULT_PROGRAM_QUOTA.aiRequestsPerDay,
      searchIndexingDocs: limits.searchIndexingDocs ?? DEFAULT_PROGRAM_QUOTA.searchIndexingDocs,
      analyticsEventsPerDay: limits.analyticsEventsPerDay ?? DEFAULT_PROGRAM_QUOTA.analyticsEventsPerDay,
    };
  }

  incrementInstall(programId: ProgramId, active: boolean): void {
    this.update(programId, (r) => ({
      ...r,
      installedCount: r.installedCount + 1,
      activeInstallCount: active ? r.activeInstallCount + 1 : r.activeInstallCount,
    }));
  }

  decrementInstall(programId: ProgramId): void {
    this.update(programId, (r) => ({
      ...r,
      activeInstallCount: Math.max(0, r.activeInstallCount - 1),
    }));
  }

  require(id: ProgramId): ProgramRecord {
    const r = this.programs.get(id);
    if (!r) throw new ProgramError({ code: "eks.program.not_found", category: "not_found", message: `Program ${id} not found.`, userMessage: "Program not found." });
    return r;
  }

  private update(id: ProgramId, fn: (r: ProgramRecord) => ProgramRecord): void {
    const existing = this.programs.get(id);
    if (!existing) return;
    this.programs.set(id, fn(existing));
  }

  private recordAudit(programId: ProgramId, event: ProgramLifecycleEvent | undefined, metadata?: Record<string, unknown>): void {
    this.auditLog.push({
      programId,
      event: event ?? "created",
      at: getClock().iso(),
      metadata: metadata ?? {},
    });
  }

  private transitionToEvent(to: ProgramState): ProgramLifecycleEvent | undefined {
    const map: Partial<Record<ProgramState, ProgramLifecycleEvent>> = {
      built: "built",
      signed: "signed",
      validated: "validated",
      uploaded: "uploaded",
      in_review: "review_started",
      certified: "certified",
      rejected: "rejected",
      published: "published",
      installed: "installed",
      active: "activated",
      paused: "paused",
      disabled: "disabled",
      deprecated: "deprecated",
      archived: "archived",
      uninstalled: "uninstalled",
    };
    return map[to];
  }
}

export interface LifecycleAuditEntry {
  readonly programId: ProgramId;
  readonly event: ProgramLifecycleEvent;
  readonly at: string;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: ProgramRegistry | null = null;
export function getRegistry(): ProgramRegistry {
  if (!_registry) _registry = new ProgramRegistry();
  return _registry;
}

// ---------------------------------------------------------------------------
// Canary Release Manager
// ---------------------------------------------------------------------------

export interface CanaryRelease {
  readonly id: string;
  readonly programId: ProgramId;
  readonly versionId: ProgramVersionId;
  readonly rolloutPercent: number; // 0-100
  readonly targetPercent: number;
  readonly status: "initiated" | "rolling" | "completed" | "paused" | "aborted" | "rolled_back";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly abortThreshold: { errorRate: number; crashRate: number };
  readonly metrics: { installs: number; errors: number; crashes: number; positiveFeedback: number };
  readonly history: { at: string; action: string; detail?: string }[];
}

export class CanaryReleaseManager {
  private readonly releases = new Map<string, CanaryRelease>();
  private readonly byProgram = new Map<ProgramId, string[]>();

  initiate(input: {
    programId: ProgramId;
    versionId: ProgramVersionId;
    targetPercent?: number;
    abortErrorRate?: number;
    abortCrashRate?: number;
  }): CanaryRelease {
    const release: CanaryRelease = {
      id: generateId("canary_"),
      programId: input.programId,
      versionId: input.versionId,
      rolloutPercent: 5, // start at 5%
      targetPercent: input.targetPercent ?? 100,
      status: "initiated",
      startedAt: getClock().iso(),
      abortThreshold: { errorRate: input.abortErrorRate ?? 0.05, crashRate: input.abortCrashRate ?? 0.01 },
      metrics: { installs: 0, errors: 0, crashes: 0, positiveFeedback: 0 },
      history: [{ at: getClock().iso(), action: "initiated", detail: `Starting canary at 5% rollout` }],
    };
    this.releases.set(release.id, release);
    const list = this.byProgram.get(input.programId) ?? [];
    this.byProgram.set(input.programId, [...list, release.id]);
    void getEventBus().publish(buildEvent("eks.program.canary.initiated", { releaseId: release.id, programId: input.programId, rolloutPercent: 5 }, {}, "domain"));
    return release;
  }

  ramp(releaseId: string, newPercent: number): CanaryRelease {
    const release = this.releases.get(releaseId);
    if (!release) throw new Error("Canary release not found");
    if (release.status !== "rolling" && release.status !== "initiated") {
      throw new Error(`Cannot ramp a ${release.status} canary`);
    }
    const updated: CanaryRelease = {
      ...release,
      rolloutPercent: Math.min(newPercent, release.targetPercent),
      status: newPercent >= release.targetPercent ? "completed" : "rolling",
      completedAt: newPercent >= release.targetPercent ? getClock().iso() : undefined,
      history: [...release.history, { at: getClock().iso(), action: "ramp", detail: `Ramped to ${newPercent}%` }],
    };
    this.releases.set(releaseId, updated);
    void getEventBus().publish(buildEvent("eks.program.canary.ramped", { releaseId, rolloutPercent: updated.rolloutPercent }, {}, "domain"));
    return updated;
  }

  pause(releaseId: string): CanaryRelease {
    return this.updateStatus(releaseId, "paused", "Canary paused");
  }

  resume(releaseId: string): CanaryRelease {
    return this.updateStatus(releaseId, "rolling", "Canary resumed");
  }

  abort(releaseId: string, reason: string): CanaryRelease {
    const updated = this.updateStatus(releaseId, "aborted", `Aborted: ${reason}`);
    void getEventBus().publish(buildEvent("eks.program.canary.aborted", { releaseId, reason }, {}, "domain"));
    return updated;
  }

  complete(releaseId: string): CanaryRelease {
    return this.updateStatus(releaseId, "completed", "Canary completed — full rollout");
  }

  rollback(releaseId: string): CanaryRelease {
    const updated = this.updateStatus(releaseId, "rolled_back", "Rolled back to previous version");
    void getEventBus().publish(buildEvent("eks.program.rolledBack", { releaseId, reason: "canary_rollback" }, {}, "domain"));
    return updated;
  }

  recordMetrics(releaseId: string, metrics: Partial<CanaryRelease["metrics"]>): CanaryRelease {
    const release = this.releases.get(releaseId);
    if (!release) throw new Error("Not found");
    const updated: CanaryRelease = {
      ...release,
      metrics: { ...release.metrics, ...metrics },
    };
    this.releases.set(releaseId, updated);
    // Auto-abort if thresholds exceeded
    const totalInstalls = updated.metrics.installs;
    if (totalInstalls > 100) {
      const errorRate = updated.metrics.errors / totalInstalls;
      const crashRate = updated.metrics.crashes / totalInstalls;
      if (errorRate > release.abortThreshold.errorRate || crashRate > release.abortThreshold.crashRate) {
        return this.abort(releaseId, `Threshold exceeded: errorRate=${(errorRate * 100).toFixed(1)}%, crashRate=${(crashRate * 100).toFixed(1)}%`);
      }
    }
    return updated;
  }

  get(releaseId: string): CanaryRelease | undefined {
    return this.releases.get(releaseId);
  }

  listByProgram(programId: ProgramId): CanaryRelease[] {
    return (this.byProgram.get(programId) ?? []).map((id) => this.releases.get(id)!).filter(Boolean);
  }

  getActive(programId: ProgramId): CanaryRelease | undefined {
    return this.listByProgram(programId).find((r) => r.status === "rolling" || r.status === "initiated");
  }

  list(): CanaryRelease[] {
    return [...this.releases.values()];
  }

  getStats(): { total: number; active: number; completed: number; aborted: number; rolledBack: number } {
    const list = [...this.releases.values()];
    return {
      total: list.length,
      active: list.filter((r) => r.status === "rolling" || r.status === "initiated").length,
      completed: list.filter((r) => r.status === "completed").length,
      aborted: list.filter((r) => r.status === "aborted").length,
      rolledBack: list.filter((r) => r.status === "rolled_back").length,
    };
  }

  private updateStatus(releaseId: string, status: CanaryRelease["status"], detail: string): CanaryRelease {
    const release = this.releases.get(releaseId);
    if (!release) throw new Error("Not found");
    const updated: CanaryRelease = {
      ...release,
      status,
      completedAt: status === "completed" || status === "aborted" || status === "rolled_back" ? getClock().iso() : undefined,
      history: [...release.history, { at: getClock().iso(), action: status, detail }],
    };
    this.releases.set(releaseId, updated);
    return updated;
  }
}

let _canary: CanaryReleaseManager | null = null;
export function getCanaryManager(): CanaryReleaseManager {
  if (!_canary) _canary = new CanaryReleaseManager();
  return _canary;
}

export { parseSemVer, semVerToString, compareSemVer };
