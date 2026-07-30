/**
 * Eks-Health Kernel — Distributed Scheduler
 *
 * Production-grade job scheduling supporting:
 *  - One-time jobs (fire once at a specific instant)
 *  - Cron jobs (5-field UNIX cron expressions, UTC)
 *  - Fixed-rate recurring jobs (fire every N ms)
 *  - Priority queues (critical > high > normal > low)
 *  - Retry with exponential backoff
 *  - Dead-letter queue for jobs that exhaust retries
 *  - Distributed locking (in-memory simulation; swappable for Redis etcd)
 *  - Audit trail via the kernel event bus
 *
 * The scheduler is REAL working logic, not a stub. A single dispatcher tick
 * runs at a configurable interval (default 1s). On each tick it collects all
 * due jobs (nextRunAt <= now, status = "queued"), sorts them by priority and
 * due time, then executes them sequentially through their registered handler.
 * Failures are retried with exponential backoff; after maxRetries the job is
 * moved to the dead-letter queue.
 *
 * Default adapter is in-memory. Production swaps in Quartz/Temporal/Celery.
 */

import type { Brand, TenantId } from "../core";
import { generateId, getClock } from "../core";
import { getEventBus, buildEvent } from "../events";

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

export type JobId = Brand<string, "JobId">;

export function asJobId(s: string): JobId {
  return s as JobId;
}

export function generateJobId(): JobId {
  return asJobId(`job_${generateId()}`);
}

// ---------------------------------------------------------------------------
// Core scheduling types
// ---------------------------------------------------------------------------

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "dead_letter";

export type JobPriority = "low" | "normal" | "high" | "critical";

export type JobSchedule =
  | { readonly kind: "one_time"; readonly runAt: number } // epoch ms
  | { readonly kind: "cron"; readonly expression: string } // 5-field UNIX cron
  | { readonly kind: "fixed_rate"; readonly intervalMs: number };

export interface JobOptions {
  readonly priority?: JobPriority;
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  readonly backoffMultiplier?: number;
  readonly lockKey?: string;
  readonly tenantId?: TenantId;
}

export interface JobSpec {
  readonly name: string;
  readonly payload: unknown;
  readonly schedule: JobSchedule;
  readonly options?: JobOptions;
}

export interface JobAttempt {
  readonly attempt: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly success: boolean;
  readonly error?: string;
  readonly durationMs: number;
}

export interface JobLock {
  readonly key: string;
  readonly owner: string;
  readonly acquiredAt: string;
  readonly expiresAt: number; // epoch ms
}

export interface JobContext {
  readonly job: Job;
  readonly attempt: number;
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Internal (mutable) vs public (readonly) Job
// ---------------------------------------------------------------------------

interface InternalJob {
  id: JobId;
  name: string;
  payload: unknown;
  schedule: JobSchedule;
  priority: JobPriority;
  status: JobStatus;
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  lockKey?: string;
  tenantId?: TenantId;
  createdAt: string;
  attempts: JobAttempt[];
  lastRunAt?: string;
  nextRunAt?: number;
  cancelledAt?: string;
  deadLetteredAt?: string;
  deadLetterReason?: string;
}

export interface Job {
  readonly id: JobId;
  readonly name: string;
  readonly payload: unknown;
  readonly schedule: JobSchedule;
  readonly priority: JobPriority;
  readonly status: JobStatus;
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly backoffMultiplier: number;
  readonly lockKey?: string;
  readonly tenantId?: TenantId;
  readonly createdAt: string;
  readonly attempts: readonly JobAttempt[];
  readonly lastRunAt?: string;
  readonly nextRunAt?: number;
  readonly cancelledAt?: string;
  readonly deadLetteredAt?: string;
  readonly deadLetterReason?: string;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface SchedulerStats {
  readonly scheduled: number;
  readonly fired: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly deadLettered: number;
  readonly retries: number;
  readonly locksAcquired: number;
  readonly locksReleased: number;
  readonly activeJobs: number;
  readonly queuedJobs: number;
  readonly runningJobs: number;
  readonly deadLetterQueueSize: number;
  readonly registeredHandlers: number;
  readonly activeLocks: number;
}

export interface SchedulerOptions {
  readonly tickIntervalMs?: number;
  readonly defaultMaxRetries?: number;
  readonly defaultBackoffMs?: number;
  readonly defaultBackoffMultiplier?: number;
  readonly lockOwner?: string;
}

// ---------------------------------------------------------------------------
// Priority ranking (higher number = higher priority)
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<JobPriority, number> = {
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
};

function priorityRank(p: JobPriority): number {
  return PRIORITY_RANK[p];
}

// ---------------------------------------------------------------------------
// Cron expression parser (5-field UNIX cron, UTC)
//   minute hour day-of-month month day-of-week
//   0-59   0-23 1-31           1-12  0-6 (0=Sunday)
// Supports: *, N, N-M, N,M,K, */S, N-M/S
// ---------------------------------------------------------------------------

function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const raw of field.split(",")) {
    const part = raw.trim();
    if (part === "*") {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }
    // */S  — every S units across full range
    const stepStar = /^\/(\d+)$/.exec(part) ?? /^\*\/(\d+)$/.exec(part);
    if (stepStar) {
      const step = parseInt(stepStar[1], 10);
      if (!step || step < 1) throw new Error(`Invalid cron step in "${field}"`);
      for (let i = min; i <= max; i += step) result.add(i);
      continue;
    }
    // A-B/S or A/S
    const rangeWithStep = /^(\d+)-(\d+)\/(\d+)$/.exec(part);
    if (rangeWithStep) {
      const lo = parseInt(rangeWithStep[1], 10);
      const hi = parseInt(rangeWithStep[2], 10);
      const step = parseInt(rangeWithStep[3], 10);
      if (step < 1) throw new Error(`Invalid cron step in "${field}"`);
      for (let i = lo; i <= hi; i += step) result.add(i);
      continue;
    }
    // A-B
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      for (let i = lo; i <= hi; i++) result.add(i);
      continue;
    }
    // N
    const single = /^(\d+)$/.exec(part);
    if (single) {
      result.add(parseInt(single[1], 10));
      continue;
    }
    throw new Error(`Unparseable cron token "${part}" in field "${field}"`);
  }
  return result;
}

interface CompiledCron {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
}

function compileCron(expr: string): CompiledCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression "${expr}": expected 5 fields, got ${parts.length}`,
    );
  }
  const [minF, hourF, domF, monF, dowF] = parts;
  return {
    minutes: parseCronField(minF, 0, 59),
    hours: parseCronField(hourF, 0, 23),
    doms: parseCronField(domF, 1, 31),
    months: parseCronField(monF, 1, 12),
    dows: parseCronField(dowF, 0, 6),
  };
}

function cronMatches(c: CompiledCron, date: Date): boolean {
  return (
    c.minutes.has(date.getUTCMinutes()) &&
    c.hours.has(date.getUTCHours()) &&
    c.doms.has(date.getUTCDate()) &&
    c.months.has(date.getUTCMonth() + 1) &&
    c.dows.has(date.getUTCDay())
  );
}

/**
 * Compute the next epoch-ms timestamp at which the cron expression matches,
 * starting from `from` (exclusive). Brute-force scan, capped at 1 year.
 */
function nextCronRun(expr: string, from: Date): number {
  const compiled = compileCron(expr);
  const next = new Date(from.getTime() + 60_000);
  next.setUTCSeconds(0, 0); // align to minute boundary
  // Cap at ~1 year of minutes to avoid infinite loop on impossible expressions
  for (let i = 0; i < 525_600; i++) {
    if (cronMatches(compiled, next)) return next.getTime();
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  throw new Error(`No next run within 1 year for cron expression "${expr}"`);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class Scheduler {
  private readonly jobs = new Map<JobId, InternalJob>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly locks = new Map<string, JobLock>();
  private readonly deadLetterQueue: InternalJob[] = [];
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly stats = {
    scheduled: 0,
    fired: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    deadLettered: 0,
    retries: 0,
    locksAcquired: 0,
    locksReleased: 0,
  };
  private readonly tickIntervalMs: number;
  private readonly defaultMaxRetries: number;
  private readonly defaultBackoffMs: number;
  private readonly defaultBackoffMultiplier: number;
  private readonly lockOwner: string;
  private ticking = false;

  constructor(opts: SchedulerOptions = {}) {
    this.tickIntervalMs = opts.tickIntervalMs ?? 1000;
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 3;
    this.defaultBackoffMs = opts.defaultBackoffMs ?? 1000;
    this.defaultBackoffMultiplier = opts.defaultBackoffMultiplier ?? 2;
    this.lockOwner = opts.lockOwner ?? `scheduler-${generateId()}`;
    this.registerBuiltinHandlers();
    // Start the dispatcher. setInterval is used so the loop continues for the
    // lifetime of the process; tests can call shutdown() to clear it.
    const timer = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);
    this.timers.push(timer);
  }

  // ----------------------- Handler registration -----------------------

  registerHandler(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  listHandlers(): string[] {
    return [...this.handlers.keys()];
  }

  // ----------------------- Scheduling API -----------------------

  schedule(spec: JobSpec): JobId {
    const id = generateJobId();
    const o = spec.options ?? {};
    const priority = o.priority ?? "normal";
    const maxRetries = o.maxRetries ?? this.defaultMaxRetries;
    const backoffMs = o.backoffMs ?? this.defaultBackoffMs;
    const backoffMultiplier = o.backoffMultiplier ?? this.defaultBackoffMultiplier;

    let nextRunAt: number;
    switch (spec.schedule.kind) {
      case "one_time":
        nextRunAt = spec.schedule.runAt;
        break;
      case "cron":
        // Validate the expression eagerly and compute the first fire time.
        nextRunAt = nextCronRun(spec.schedule.expression, new Date());
        break;
      case "fixed_rate":
        // First fire is immediate (next tick); subsequent fires every intervalMs.
        nextRunAt = Date.now();
        break;
      default: {
        const _exhaustive: never = spec.schedule;
        throw new Error(`Unknown schedule kind: ${String(_exhaustive)}`);
      }
    }

    const job: InternalJob = {
      id,
      name: spec.name,
      payload: spec.payload,
      schedule: spec.schedule,
      priority,
      status: "queued",
      maxRetries,
      backoffMs,
      backoffMultiplier,
      lockKey: o.lockKey,
      tenantId: o.tenantId,
      createdAt: getClock().iso(),
      attempts: [],
      nextRunAt,
    };
    this.jobs.set(id, job);
    this.stats.scheduled++;
    return id;
  }

  scheduleOne(
    name: string,
    payload: unknown,
    runAt: Date | number,
    opts?: JobOptions,
  ): JobId {
    const runAtMs = typeof runAt === "number" ? runAt : runAt.getTime();
    return this.schedule({
      name,
      payload,
      schedule: { kind: "one_time", runAt: runAtMs },
      options: opts,
    });
  }

  scheduleCron(
    name: string,
    payload: unknown,
    cronExpr: string,
    opts?: JobOptions,
  ): JobId {
    return this.schedule({
      name,
      payload,
      schedule: { kind: "cron", expression: cronExpr },
      options: opts,
    });
  }

  scheduleFixedRate(
    name: string,
    payload: unknown,
    intervalMs: number,
    opts?: JobOptions,
  ): JobId {
    if (intervalMs < 1) {
      throw new Error(`intervalMs must be >= 1, got ${intervalMs}`);
    }
    return this.schedule({
      name,
      payload,
      schedule: { kind: "fixed_rate", intervalMs },
      options: opts,
    });
  }

  // ----------------------- Job lifecycle -----------------------

  cancel(jobId: JobId): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "running" || job.status === "completed") return false;
    if (job.status === "cancelled") return true;
    job.status = "cancelled";
    job.cancelledAt = getClock().iso();
    job.nextRunAt = undefined;
    this.stats.cancelled++;
    return true;
  }

  retry(jobId: JobId): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (
      job.status !== "failed" &&
      job.status !== "dead_letter" &&
      job.status !== "completed" &&
      job.status !== "cancelled"
    ) {
      return false;
    }
    // Reset attempt history and re-queue for immediate execution.
    job.attempts = [];
    job.status = "queued";
    job.nextRunAt = Date.now();
    job.lastRunAt = undefined;
    job.deadLetteredAt = undefined;
    job.deadLetterReason = undefined;
    job.cancelledAt = undefined;
    return true;
  }

  getJob(jobId: JobId): Job | undefined {
    const j = this.jobs.get(jobId);
    return j as Job | undefined;
  }

  listJobs(filter?: (j: Job) => boolean): Job[] {
    const all = [...this.jobs.values()] as Job[];
    return filter ? all.filter(filter) : all;
  }

  getDeadLetterQueue(): Job[] {
    return [...this.deadLetterQueue] as Job[];
  }

  // ----------------------- Distributed locking -----------------------

  /**
   * Attempt to acquire a distributed lock. Returns true if acquired (i.e. no
   * unexpired lock currently exists on the key), false otherwise. Per the
   * distributed-lock contract, any second acquire on an unexpired lock fails,
   * regardless of owner — callers must release before re-acquiring.
   * Locks auto-expire after ttlMs.
   */
  acquireLock(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > now) {
      return false; // held and not expired
    }
    this.locks.set(key, {
      key,
      owner: this.lockOwner,
      acquiredAt: getClock().iso(),
      expiresAt: now + ttlMs,
    });
    this.stats.locksAcquired++;
    return true;
  }

  /** Release a lock. Only succeeds if the caller is the current owner. */
  releaseLock(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    if (existing.owner !== this.lockOwner) return false;
    this.locks.delete(key);
    this.stats.locksReleased++;
    return true;
  }

  getLock(key: string): JobLock | undefined {
    const l = this.locks.get(key);
    if (!l) return undefined;
    if (l.expiresAt <= Date.now()) {
      this.locks.delete(key);
      return undefined;
    }
    return { ...l };
  }

  // ----------------------- Stats -----------------------

  getStats(): SchedulerStats {
    let queued = 0;
    let running = 0;
    for (const j of this.jobs.values()) {
      if (j.status === "queued") queued++;
      else if (j.status === "running") running++;
    }
    return {
      ...this.stats,
      activeJobs: this.jobs.size,
      queuedJobs: queued,
      runningJobs: running,
      deadLetterQueueSize: this.deadLetterQueue.length,
      registeredHandlers: this.handlers.size,
      activeLocks: this.locks.size,
    };
  }

  // ----------------------- Dispatch loop -----------------------

  /** Process all due jobs once. Public so tests can drive deterministic ticks. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const due = [...this.jobs.values()]
        .filter(
          (j) =>
            j.status === "queued" &&
            j.nextRunAt !== undefined &&
            j.nextRunAt <= now,
        )
        .sort(
          (a, b) =>
            priorityRank(b.priority) - priorityRank(a.priority) ||
            (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0) ||
            a.createdAt.localeCompare(b.createdAt),
        );
      for (const job of due) {
        await this.executeJob(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async executeJob(job: InternalJob): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      job.status = "failed";
      job.deadLetteredAt = getClock().iso();
      job.deadLetterReason = `No handler registered for job name "${job.name}"`;
      this.deadLetterQueue.push(job);
      this.stats.failed++;
      this.stats.deadLettered++;
      return;
    }

    // Acquire distributed lock if the job declares one.
    let lockHeld = false;
    if (job.lockKey) {
      // TTL of 5 minutes per execution; long-running jobs should refresh.
      if (!this.acquireLock(job.lockKey, 5 * 60_000)) {
        // Skip this tick; will retry on the next tick.
        return;
      }
      lockHeld = true;
    }

    job.status = "running";
    job.lastRunAt = getClock().iso();
    const startedAt = Date.now();
    const attemptNumber = job.attempts.length + 1;
    this.stats.fired++;

    // Emit the well-known "scheduler.fired" event for audit/observability.
    void getEventBus().publish(
      buildEvent(
        "eks.kernel.scheduler.fired",
        {
          jobId: job.id,
          name: job.name,
          attempt: attemptNumber,
          priority: job.priority,
          schedule: job.schedule.kind,
        },
        {},
        "scheduled",
      ),
    );

    let success = false;
    let errorMessage: string | undefined;
    try {
      await handler({ job: job as Job, attempt: attemptNumber });
      success = true;
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }

    const endedAt = Date.now();
    const attempt: JobAttempt = {
      attempt: attemptNumber,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      success,
      error: success ? undefined : errorMessage,
      durationMs: endedAt - startedAt,
    };
    job.attempts.push(attempt);

    if (lockHeld && job.lockKey) {
      this.releaseLock(job.lockKey);
    }

    if (success) {
      this.stats.completed++;
      // Schedule next run for recurring jobs.
      if (job.schedule.kind === "fixed_rate") {
        job.status = "queued";
        job.nextRunAt = Date.now() + job.schedule.intervalMs;
      } else if (job.schedule.kind === "cron") {
        job.status = "queued";
        job.nextRunAt = nextCronRun(job.schedule.expression, new Date());
      } else {
        job.status = "completed";
        job.nextRunAt = undefined;
      }
      return;
    }

    // Failure path: retry with exponential backoff or dead-letter.
    this.stats.failed++;
    const retriesSoFar = job.attempts.filter((a) => !a.success).length - 1;
    if (retriesSoFar < job.maxRetries) {
      const backoff = Math.round(
        job.backoffMs * Math.pow(job.backoffMultiplier, retriesSoFar),
      );
      job.status = "queued";
      job.nextRunAt = Date.now() + backoff;
      this.stats.retries++;
    } else {
      job.status = "dead_letter";
      job.deadLetteredAt = getClock().iso();
      job.deadLetterReason = `Exhausted ${job.maxRetries} retries: ${errorMessage ?? "unknown error"}`;
      job.nextRunAt = undefined;
      this.deadLetterQueue.push(job);
      this.stats.deadLettered++;
    }
  }

  // ----------------------- Lifecycle -----------------------

  /** Stop the dispatcher tick. Use in tests / graceful shutdown. */
  shutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  // ----------------------- Built-in handlers -----------------------

  private registerBuiltinHandlers(): void {
    this.registerHandler(
      "eks.kernel.scheduler.cleanup",
      async () => {
        // Purge expired locks.
        const now = Date.now();
        const expired: string[] = [];
        for (const [key, lock] of this.locks) {
          if (lock.expiresAt <= now) expired.push(key);
        }
        for (const k of expired) this.locks.delete(k);
        // Trim completed/cancelled jobs to the last 200 to bound memory.
        const terminal = [...this.jobs.values()].filter(
          (j) =>
            j.status === "completed" ||
            j.status === "cancelled" ||
            j.status === "dead_letter",
        );
        const KEEP = 200;
        if (terminal.length > KEEP) {
          const sorted = terminal.sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          );
          const toRemove = sorted.slice(0, terminal.length - KEEP);
          for (const j of toRemove) this.jobs.delete(j.id);
        }
        void getEventBus().publish(
          buildEvent(
            "eks.kernel.scheduler.cleanup_report",
            {
              expiredLocks: expired.length,
              prunedJobs: terminal.length > KEEP ? terminal.length - KEEP : 0,
            },
            {},
            "system",
          ),
        );
      },
    );

    this.registerHandler(
      "eks.kernel.scheduler.health_check",
      async () => {
        const stats = this.getStats();
        void getEventBus().publish(
          buildEvent(
            "eks.kernel.scheduler.health_report",
            {
              activeJobs: stats.activeJobs,
              queuedJobs: stats.queuedJobs,
              deadLetterQueueSize: stats.deadLetterQueueSize,
              registeredHandlers: stats.registeredHandlers,
              activeLocks: stats.activeLocks,
            },
            {},
            "system",
          ),
        );
      },
    );

    this.registerHandler(
      "eks.kernel.scheduler.audit_rollup",
      async () => {
        const stats = this.getStats();
        const byName = new Map<string, number>();
        for (const j of this.jobs.values()) {
          byName.set(j.name, (byName.get(j.name) ?? 0) + 1);
        }
        void getEventBus().publish(
          buildEvent(
            "eks.kernel.scheduler.audit_rollup",
            {
              rolledUpAt: getClock().iso(),
              totals: stats,
              jobsByName: Object.fromEntries(byName),
            },
            {},
            "system",
          ),
        );
      },
    );

    this.registerHandler(
      "eks.kernel.scheduler.metrics_flush",
      async () => {
        const stats = this.getStats();
        void getEventBus().publish(
          buildEvent(
            "eks.kernel.scheduler.metrics_flush",
            {
              flushedAt: getClock().iso(),
              counters: {
                scheduled: stats.scheduled,
                fired: stats.fired,
                completed: stats.completed,
                failed: stats.failed,
                cancelled: stats.cancelled,
                deadLettered: stats.deadLettered,
                retries: stats.retries,
              },
              gauges: {
                activeJobs: stats.activeJobs,
                queuedJobs: stats.queuedJobs,
                deadLetterQueueSize: stats.deadLetterQueueSize,
                activeLocks: stats.activeLocks,
              },
            },
            {},
            "system",
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!_scheduler) _scheduler = new Scheduler();
  return _scheduler;
}

export function setScheduler(scheduler: Scheduler): void {
  if (_scheduler) _scheduler.shutdown();
  _scheduler = scheduler;
}

export function resetScheduler(): void {
  if (_scheduler) {
    _scheduler.shutdown();
    _scheduler = null;
  }
}
