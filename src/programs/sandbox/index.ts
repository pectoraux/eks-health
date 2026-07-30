/**
 * Eks-Health Program OS — Sandbox Runtime Isolation
 *
 * Every Program executes inside an isolated Sandbox. The Sandbox enforces
 * nine isolation boundaries: memory, storage, network, filesystem, secrets,
 * background jobs, logging, configuration, and caches. Programs can never:
 *   - access another Program's storage / secrets / config / logs,
 *   - execute arbitrary system commands,
 *   - read platform secrets or modify platform configuration,
 *   - exceed their allocated memory / storage / job limits.
 *
 * Each Sandbox owns a unique storage namespace, secret namespace, log ring
 * buffer (last 500 entries), config map, and event subscription set. Resource
 * handles allocated inside a sandbox are tracked and counted against quotas.
 */

import "server-only";
import {
  type ProgramId,
  type SandboxId,
  type ResourceHandleId,
  ProgramError,
  asSandboxId,
  asResourceHandleId,
  PROGRAM_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Sandbox boundaries
// ---------------------------------------------------------------------------

export type SandboxBoundary =
  | "memory"
  | "storage"
  | "network"
  | "fs"
  | "secrets"
  | "jobs"
  | "logging"
  | "config"
  | "caches";

export const SANDBOX_BOUNDARIES: readonly SandboxBoundary[] = [
  "memory", "storage", "network", "fs", "secrets", "jobs", "logging", "config", "caches",
];

// ---------------------------------------------------------------------------
// Sandbox configuration
// ---------------------------------------------------------------------------

export interface SandboxConfig {
  readonly memoryLimitMb?: number;
  readonly storageLimitMb?: number;
  readonly cpuShares?: number;
  readonly networkAllowed?: boolean;
  readonly fsAllowed?: boolean;
  readonly maxBackgroundJobs?: number;
  readonly maxLogEntries?: number; // ring buffer size, default 500
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  memoryLimitMb: 128,
  storageLimitMb: 50,
  cpuShares: 256,
  networkAllowed: false,
  fsAllowed: false,
  maxBackgroundJobs: 5,
  maxLogEntries: 500,
};

// ---------------------------------------------------------------------------
// Resource handles (per-sandbox)
// ---------------------------------------------------------------------------

export type SandboxResourceType = "memory" | "storage" | "jobs" | "cpu" | "network" | "cache";

export interface SandboxResource {
  readonly id: ResourceHandleId;
  readonly sandboxId: SandboxId;
  readonly programId: ProgramId;
  readonly type: SandboxResourceType;
  readonly amount: number;
  readonly unit: "bytes" | "mb" | "count" | "shares";
  readonly allocatedAt: string;
  readonly releasedAt?: string;
  readonly label?: string;
}

export interface SandboxResourceUsage {
  readonly memoryBytes: number;
  readonly storageBytes: number;
  readonly jobs: number;
  readonly cpuShares: number;
  readonly networkSockets: number;
  readonly cacheBytes: number;
  readonly handles: readonly SandboxResource[];
}

// ---------------------------------------------------------------------------
// Log entries (ring buffer per sandbox)
// ---------------------------------------------------------------------------

export interface SandboxLogEntry {
  readonly at: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sandbox record
// ---------------------------------------------------------------------------

export interface Sandbox {
  readonly id: SandboxId;
  readonly programId: ProgramId;
  readonly createdAt: string;
  readonly destroyedAt?: string;
  readonly state: "active" | "destroyed";
  readonly config: SandboxConfig;
  readonly storageNamespace: string; // `program:<programId>:storage:`
  readonly secretNamespace: string; // `program:<programId>:secrets:`
  readonly logNamespace: string; // `program:<programId>:logs:`
  readonly configNamespace: string; // `program:<programId>:config:`
  readonly cacheNamespace: string; // `program:<programId>:caches:`
  readonly logEntries: readonly SandboxLogEntry[];
  readonly configMap: ReadonlyMap<string, unknown>;
  readonly subscriptionIds: readonly string[];
}

/** Internal mutable record. The public `Sandbox` is a snapshot of this. */
interface SandboxRecord {
  id: SandboxId;
  programId: ProgramId;
  createdAt: string;
  destroyedAt?: string;
  state: "active" | "destroyed";
  config: SandboxConfig;
  storageNamespace: string;
  secretNamespace: string;
  logNamespace: string;
  configNamespace: string;
  cacheNamespace: string;
  logBuffer: SandboxLogEntry[];
  configMap: Map<string, unknown>;
  subscriptionIds: Set<string>;
  resources: Map<ResourceHandleId, SandboxResource>;
}

// ---------------------------------------------------------------------------
// Boundary actions & violations
// ---------------------------------------------------------------------------

export interface BoundaryAction {
  /** e.g. "storage.read", "storage.write", "exec.command", "secret.read", "config.write", "network.fetch" */
  readonly kind: string;
  /** The program the action targets (must equal the caller's program unless permitted). */
  readonly targetProgramId?: ProgramId;
  /** Fully-qualified namespace the action targets, e.g. `program:prg_x:storage:users`. */
  readonly targetNamespace?: string;
  /** Free-form resource identifier (e.g. file path, secret name). */
  readonly resource?: string;
  readonly details?: Record<string, unknown>;
}

export interface SandboxViolation {
  readonly type: SandboxBoundary;
  readonly programId: ProgramId;
  readonly attempted: string;
  readonly blocked: string;
  readonly at: string;
  readonly action?: BoundaryAction;
}

export interface BoundaryCheckResult {
  readonly allowed: boolean;
  readonly violation?: SandboxViolation;
}

// ---------------------------------------------------------------------------
// Sandbox manager
// ---------------------------------------------------------------------------

export class SandboxManager {
  private readonly sandboxes = new Map<SandboxId, SandboxRecord>();
  private readonly byProgram = new Map<ProgramId, SandboxId[]>();
  private readonly violationsByProgram = new Map<ProgramId, SandboxViolation[]>();
  private readonly violationLog: SandboxViolation[] = [];

  /** Create an isolated Sandbox for a Program. */
  create(programId: ProgramId, config: SandboxConfig = {}): Sandbox {
    const merged: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    const id = asSandboxId(generateId("snd_"));
    const now = getClock().iso();
    const record: SandboxRecord = {
      id,
      programId,
      createdAt: now,
      state: "active",
      config: merged,
      storageNamespace: `program:${programId}:storage:`,
      secretNamespace: `program:${programId}:secrets:`,
      logNamespace: `program:${programId}:logs:`,
      configNamespace: `program:${programId}:config:`,
      cacheNamespace: `program:${programId}:caches:`,
      logBuffer: [],
      configMap: new Map(),
      subscriptionIds: new Set(),
      resources: new Map(),
    };
    this.sandboxes.set(id, record);
    const list = this.byProgram.get(programId) ?? [];
    this.byProgram.set(programId, [...list, id]);
    this.appendLog(record, "info", `Sandbox ${id} created for program ${programId}`);
    void getEventBus().publish(
      buildEvent(
        "eks.program.sandbox.created",
        { sandboxId: id, programId, config: merged },
        {},
        "domain",
      ),
    );
    return this.toSandbox(record);
  }

  get(id: SandboxId): Sandbox | undefined {
    const r = this.sandboxes.get(id);
    return r ? this.toSandbox(r) : undefined;
  }

  list(): Sandbox[] {
    return [...this.sandboxes.values()].map((r) => this.toSandbox(r));
  }

  listForProgram(programId: ProgramId): Sandbox[] {
    return (this.byProgram.get(programId) ?? [])
      .map((id) => this.sandboxes.get(id)!)
      .filter(Boolean)
      .map((r) => this.toSandbox(r));
  }

  /** Active sandbox for a program (most recently created). */
  activeForProgram(programId: ProgramId): Sandbox | undefined {
    const ids = this.byProgram.get(programId) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const r = this.sandboxes.get(ids[i]);
      if (r && r.state === "active") return this.toSandbox(r);
    }
    return undefined;
  }

  destroy(id: SandboxId): void {
    const r = this.sandboxes.get(id);
    if (!r) return;
    r.state = "destroyed";
    r.destroyedAt = getClock().iso();
    // Release all outstanding resource handles.
    for (const [hid, res] of r.resources) {
      r.resources.set(hid, { ...res, releasedAt: r.destroyedAt });
    }
    this.appendLog(r, "info", `Sandbox ${id} destroyed`);
    void getEventBus().publish(
      buildEvent(
        "eks.program.sandbox.destroyed",
        { sandboxId: id, programId: r.programId },
        {},
        "domain",
      ),
    );
  }

  /**
   * Check whether an action is permitted under the sandbox's boundary.
   * Real enforcement: validates the requested action stays within the
   * program's own namespace and rejects prohibited action kinds.
   */
  checkBoundary(
    programId: ProgramId,
    boundary: SandboxBoundary,
    action: BoundaryAction,
  ): BoundaryCheckResult {
    const violation = this.evaluateBoundary(programId, boundary, action);
    if (violation) {
      this.recordViolation(violation);
      return { allowed: false, violation };
    }
    return { allowed: true };
  }

  private evaluateBoundary(
    programId: ProgramId,
    boundary: SandboxBoundary,
    action: BoundaryAction,
  ): SandboxViolation | undefined {
    const at = getClock().iso();

    // Universally prohibited action kinds.
    if (action.kind === "exec.command" || action.kind === "system.exec" || action.kind === "shell.exec") {
      return {
        type: boundary,
        programId,
        attempted: action.kind,
        blocked: "Arbitrary command execution is not permitted inside a sandbox.",
        at,
        action,
      };
    }
    if (action.kind === "platform.secret.read" || action.kind === "platform.secrets.read") {
      return {
        type: "secrets",
        programId,
        attempted: action.kind,
        blocked: "Platform secrets are not accessible from a program sandbox.",
        at,
        action,
      };
    }
    if (action.kind === "platform.config.write" || action.kind === "platform.config.read") {
      return {
        type: "config",
        programId,
        attempted: action.kind,
        blocked: "Platform configuration is not writable/readable from a program sandbox.",
        at,
        action,
      };
    }

    // Cross-program access checks.
    if (action.targetProgramId !== undefined && action.targetProgramId !== programId) {
      return {
        type: boundary,
        programId,
        attempted: action.kind,
        blocked: `Cross-program access denied (target program: ${action.targetProgramId}).`,
        at,
        action,
      };
    }
    if (action.targetNamespace !== undefined) {
      const expectedPrefix = `program:${programId}:`;
      if (!action.targetNamespace.startsWith(expectedPrefix)) {
        return {
          type: boundary,
          programId,
          attempted: action.kind,
          blocked: `Namespace '${action.targetNamespace}' is outside program '${programId}' scope.`,
          at,
          action,
        };
      }
    }

    // Config-driven checks (network/fs).
    const sandbox = this.findActiveRecordForProgram(programId);
    if (sandbox) {
      if (boundary === "network" && sandbox.config.networkAllowed === false) {
        return {
          type: "network",
          programId,
          attempted: action.kind,
          blocked: "Network access is disabled for this sandbox.",
          at,
          action,
        };
      }
      if (boundary === "fs" && sandbox.config.fsAllowed === false) {
        return {
          type: "fs",
          programId,
          attempted: action.kind,
          blocked: "Filesystem access is disabled for this sandbox.",
          at,
          action,
        };
      }
      // Memory ceiling.
      if (boundary === "memory" && action.details?.bytes !== undefined) {
        const requested = Number(action.details.bytes) || 0;
        const limit = (sandbox.config.memoryLimitMb ?? DEFAULT_SANDBOX_CONFIG.memoryLimitMb!) * 1024 * 1024;
        const used = this.sumByType(sandbox, "memory");
        if (used + requested > limit) {
          return {
            type: "memory",
            programId,
            attempted: action.kind,
            blocked: `Memory allocation would exceed sandbox limit (${sandbox.config.memoryLimitMb}MB).`,
            at,
            action,
          };
        }
      }
      // Storage ceiling.
      if (boundary === "storage" && action.details?.bytes !== undefined) {
        const requested = Number(action.details.bytes) || 0;
        const limit = (sandbox.config.storageLimitMb ?? DEFAULT_SANDBOX_CONFIG.storageLimitMb!) * 1024 * 1024;
        const used = this.sumByType(sandbox, "storage");
        if (used + requested > limit) {
          return {
            type: "storage",
            programId,
            attempted: action.kind,
            blocked: `Storage allocation would exceed sandbox limit (${sandbox.config.storageLimitMb}MB).`,
            at,
            action,
          };
        }
      }
      // Background jobs ceiling.
      if (boundary === "jobs" && sandbox.config.maxBackgroundJobs !== undefined) {
        const activeJobs = this.sumByType(sandbox, "jobs");
        if (activeJobs >= sandbox.config.maxBackgroundJobs) {
          return {
            type: "jobs",
            programId,
            attempted: action.kind,
            blocked: `Background job limit reached (${sandbox.config.maxBackgroundJobs}).`,
            at,
            action,
          };
        }
      }
    }
    return undefined;
  }

  /** Store a violation and emit a sandbox.violation event. */
  recordViolation(violation: SandboxViolation): void {
    const list = this.violationsByProgram.get(violation.programId) ?? [];
    list.push(violation);
    this.violationsByProgram.set(violation.programId, list);
    this.violationLog.push(violation);
    void getEventBus().publish(
      buildEvent(
        PROGRAM_EVENTS.sandboxViolation,
        {
          type: violation.type,
          programId: violation.programId,
          attempted: violation.attempted,
          blocked: violation.blocked,
          at: violation.at,
        },
        {},
        "domain",
      ),
    );
  }

  getViolations(programId?: ProgramId): readonly SandboxViolation[] {
    if (programId) return this.violationsByProgram.get(programId) ?? [];
    return this.violationLog;
  }

  /** Current resource usage for a sandbox. */
  getResources(sandboxId: SandboxId): SandboxResourceUsage {
    const r = this.require(sandboxId);
    const handles = [...r.resources.values()].filter((h) => h.releasedAt === undefined);
    return {
      memoryBytes: this.sumByType(r, "memory"),
      storageBytes: this.sumByType(r, "storage"),
      jobs: this.sumByType(r, "jobs"),
      cpuShares: this.sumByType(r, "cpu"),
      networkSockets: this.sumByType(r, "network"),
      cacheBytes: this.sumByType(r, "cache"),
      handles,
    };
  }

  /**
   * Allocate a resource handle inside the sandbox. Returns the handle id.
   * Allocation is counted against the sandbox ceiling; callers SHOULD call
   * `checkBoundary` first to verify capacity.
   */
  allocateResource(
    sandboxId: SandboxId,
    type: SandboxResourceType,
    amount: number,
    unit: SandboxResource["unit"] = "count",
    label?: string,
  ): ResourceHandleId {
    const r = this.require(sandboxId);
    if (r.state !== "active") {
      throw new ProgramError({
        code: "eks.program.sandbox.not_active",
        category: "state_conflict",
        message: `Sandbox ${sandboxId} is not active.`,
        userMessage: "The sandbox is no longer active.",
      });
    }
    const id = asResourceHandleId(generateId("rh_"));
    const handle: SandboxResource = {
      id,
      sandboxId,
      programId: r.programId,
      type,
      amount,
      unit,
      allocatedAt: getClock().iso(),
      label,
    };
    r.resources.set(id, handle);
    return id;
  }

  /** Release a previously-allocated resource handle. */
  releaseResource(sandboxId: SandboxId, handleId: ResourceHandleId): void {
    const r = this.require(sandboxId);
    const existing = r.resources.get(handleId);
    if (!existing) return;
    r.resources.set(handleId, { ...existing, releasedAt: getClock().iso() });
  }

  // --- Sandbox-owned state helpers -----------------------------------------

  /** Append a log entry to the sandbox's ring buffer. */
  log(sandboxId: SandboxId, level: SandboxLogEntry["level"], message: string, context?: Record<string, unknown>): void {
    const r = this.require(sandboxId);
    this.appendLog(r, level, message, context);
  }

  /** Set a configuration value in the sandbox's isolated config map. */
  setConfig(sandboxId: SandboxId, key: string, value: unknown): void {
    const r = this.require(sandboxId);
    r.configMap.set(key, value);
  }

  getConfig(sandboxId: SandboxId, key: string): unknown {
    const r = this.sandboxes.get(sandboxId);
    return r?.configMap.get(key);
  }

  /** Track a kernel event subscription id owned by this sandbox. */
  registerSubscription(sandboxId: SandboxId, subscriptionId: string): void {
    const r = this.require(sandboxId);
    r.subscriptionIds.add(subscriptionId);
  }

  unregisterSubscription(sandboxId: SandboxId, subscriptionId: string): void {
    const r = this.sandboxes.get(sandboxId);
    r?.subscriptionIds.delete(subscriptionId);
  }

  // --- Internals -----------------------------------------------------------

  private require(id: SandboxId): SandboxRecord {
    const r = this.sandboxes.get(id);
    if (!r) {
      throw new ProgramError({
        code: "eks.program.sandbox.not_found",
        category: "not_found",
        message: `Sandbox ${id} not found.`,
        userMessage: "Sandbox not found.",
      });
    }
    return r;
  }

  private findActiveRecordForProgram(programId: ProgramId): SandboxRecord | undefined {
    const ids = this.byProgram.get(programId) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const r = this.sandboxes.get(ids[i]);
      if (r && r.state === "active") return r;
    }
    return undefined;
  }

  private sumByType(r: SandboxRecord, type: SandboxResourceType): number {
    let total = 0;
    for (const h of r.resources.values()) {
      if (h.releasedAt === undefined && h.type === type) total += h.amount;
    }
    return total;
  }

  private appendLog(r: SandboxRecord, level: SandboxLogEntry["level"], message: string, context?: Record<string, unknown>): void {
    const cap = r.config.maxLogEntries ?? DEFAULT_SANDBOX_CONFIG.maxLogEntries!;
    r.logBuffer.push({ at: getClock().iso(), level, message, context });
    if (r.logBuffer.length > cap) {
      r.logBuffer.splice(0, r.logBuffer.length - cap);
    }
  }

  private toSandbox(r: SandboxRecord): Sandbox {
    return {
      id: r.id,
      programId: r.programId,
      createdAt: r.createdAt,
      destroyedAt: r.destroyedAt,
      state: r.state,
      config: r.config,
      storageNamespace: r.storageNamespace,
      secretNamespace: r.secretNamespace,
      logNamespace: r.logNamespace,
      configNamespace: r.configNamespace,
      cacheNamespace: r.cacheNamespace,
      logEntries: [...r.logBuffer],
      configMap: new Map(r.configMap),
      subscriptionIds: [...r.subscriptionIds],
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: SandboxManager | null = null;
export function getSandboxManager(): SandboxManager {
  if (!_mgr) _mgr = new SandboxManager();
  return _mgr;
}
