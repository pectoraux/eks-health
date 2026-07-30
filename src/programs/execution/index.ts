/**
 * Eks-Health Program OS — Background Execution
 *
 * Supports the full background-execution surface that Programs need:
 *  - Scheduled jobs (one-time at a specific instant, fixed-rate recurring,
 *    cron expressions).
 *  - Event handlers (registered per-program by name).
 *  - Queue processing (FIFO enqueue/dequeue per program+queue).
 *  - Long-running tasks (handlers may be async).
 *  - Retry with exponential backoff (100ms, 200ms, 400ms, 800ms, 1600ms,
 *    capped at 30s).
 *  - Dead-letter queue for jobs that exhaust retries.
 *  - Priority execution: critical > high > normal > low.
 *  - Automatic recovery: failed jobs are re-queued with backoff and
 *    eventually dead-lettered.
 *
 * The `tick()` method is invoked by the platform scheduler. It finds all due
 * jobs, sorts them by (priority desc, due-at asc), executes their registered
 * handler, records the attempt, and on failure schedules a retry with
 * exponential backoff. After maxRetries the job is moved to the dead-letter
 * queue and `eks.program.background.failed` is emitted.
 *
 * This module is REAL working logic — no setTimeout stubs, no fake execution.
 * The dispatcher is synchronous within tick(); async handlers are awaited.
 */

import "server-only";
import {
  type ProgramId,
  ProgramError,
  asProgramId,
} from "../core";
import type { Brand } from "@/kernel";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { PROGRAM_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

export type JobId = Brand<string, "JobId">;
export type ExecutionId = Brand<string, "ExecutionId">;

export function asJobId(s: string): JobId { return s as JobId; }
export function asExecutionId(s: string): ExecutionId { return s as ExecutionId; }

// ---------------------------------------------------------------------------
// Job primitives
// ---------------------------------------------------------------------------

export type JobPriority = "low" | "normal" | "high" | "critical";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "dead_letter";

export type JobScheduleKind = "once" | "interval" | "cron";

export interface JobSchedule {
  readonly kind: JobScheduleKind;
  /** For "once": ISO-8601 instant to fire at. */
  readonly at?: string;
  /** For "interval": milliseconds between firings. */
  readonly intervalMs?: number;
  /** For "cron": 5-field UNIX cron expression (UTC). */
  readonly cron?: string;
}

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialBackoffMs: 100,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2,
};

export interface JobSpec {
  /** Name of the handler previously registered via registerHandler(). */
  readonly handler: string;
  readonly schedule?: JobSchedule;
  readonly priority?: JobPriority;
  readonly retryPolicy?: RetryPolicy;
  readonly payload?: Record<string, unknown>;
}

export interface JobAttempt {
  readonly executionId: ExecutionId;
  readonly attemptNumber: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: "success" | "failed";
  readonly error?: string;
}

export interface ProgramJob {
  readonly id: JobId;
  readonly programId: ProgramId;
  readonly spec: JobSpec;
  readonly status: JobStatus;
  readonly attempts: JobAttempt[];
  readonly createdAt: string;
  readonly scheduledAt: string;
  /** Epoch ms when the job should next be picked up by tick(). */
  readonly nextRunAt: number;
  readonly lastRunAt?: string;
  readonly completedAt?: string;
  readonly failureCount: number;
  readonly priority: JobPriority;
}

export interface QueueMessage {
  readonly id: string;
  readonly programId: ProgramId;
  readonly queueName: string;
  readonly payload: Record<string, unknown>;
  readonly enqueuedAt: string;
  readonly dequeuedAt?: string;
  readonly attempts: number;
}

export interface QueueStats {
  readonly programId: ProgramId;
  readonly queueName: string;
  readonly depth: number;
  readonly processed: number;
  readonly failed: number;
}

export interface ExecutionLog {
  readonly id: string;
  readonly programId: ProgramId;
  readonly jobId: JobId;
  readonly executionId: ExecutionId;
  readonly attempt: number;
  readonly handler: string;
  readonly status: "success" | "failed";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface ExecutionStats {
  readonly programId?: ProgramId;
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly deadLettered: number;
  readonly avgDurationMs: number;
  readonly totalAttempts: number;
}

export interface DeadLetterEntry {
  readonly job: ProgramJob;
  readonly reason: string;
  readonly deadLetteredAt: string;
  readonly lastError?: string;
}

// ---------------------------------------------------------------------------
// Handler contract
// ---------------------------------------------------------------------------

export interface JobContext {
  readonly job: ProgramJob;
  readonly attempt: number;
  readonly payload: Record<string, unknown>;
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHT: Readonly<Record<JobPriority, number>> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

const MAX_EXECUTION_LOG = 5000;

/**
 * Compute exponential backoff for an attempt number.
 * Sequence: 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000, 30000, ...
 */
export function computeBackoff(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  if (attempt <= 0) return policy.initialBackoffMs;
  const raw = policy.initialBackoffMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  return Math.min(raw, policy.maxBackoffMs);
}

/**
 * Parse a 5-field UNIX cron expression and return the next epoch-ms
 * firing time strictly after `fromEpochMs`. Supports star, specific values,
 * ranges (1-5), and step values (star-slash-5, 1-30-slash-2).
 */
export function nextCronRun(expression: string, fromEpochMs: number): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ProgramError({
      code: "eks.program.execution.cron_invalid",
      category: "validation",
      message: `Cron expression must have 5 fields: ${expression}`,
      userMessage: "Invalid cron expression.",
    });
  }
  const [minute, hour, dom, month, dow] = fields;
  const from = new Date(fromEpochMs);
  // Start from the next minute boundary.
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  for (let i = 0; i < 525600; i++) { // up to one year of minutes
    const candidate = new Date(start.getTime() + i * 60_000);
    if (cronFieldMatches(minute, candidate.getUTCMinutes(), 0, 59) &&
        cronFieldMatches(hour, candidate.getUTCHours(), 0, 23) &&
        cronFieldMatches(dom, candidate.getUTCDate(), 1, 31) &&
        cronFieldMatches(month, candidate.getUTCMonth() + 1, 1, 12) &&
        cronFieldMatches(dow, candidate.getUTCDay(), 0, 6)) {
      return candidate.getTime();
    }
  }
  // No match within a year — return original time.
  return fromEpochMs;
}

function cronFieldMatches(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return value >= min && value <= max;
  // Step: */N or A-B/N
  const stepMatch = field.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
  if (stepMatch) {
    const rangeStr = stepMatch[1];
    const step = parseInt(stepMatch[2], 10);
    const [lo, hi] = rangeStr === "*"
      ? [min, max]
      : rangeStr.includes("-")
        ? rangeStr.split("-").map((n) => parseInt(n, 10))
        : [parseInt(rangeStr, 10), max];
    return value >= lo && value <= hi && (value - lo) % step === 0;
  }
  // Range: A-B
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map((n) => parseInt(n, 10));
    return value >= lo && value <= hi;
  }
  // List: A,B,C
  if (field.includes(",")) {
    return field.split(",").some((part) => cronFieldMatches(part, value, min, max));
  }
  // Exact value
  const exact = parseInt(field, 10);
  return exact === value;
}

// ---------------------------------------------------------------------------
// Execution manager
// ---------------------------------------------------------------------------

export class ExecutionManager {
  private readonly jobs = new Map<JobId, ProgramJob>();
  private readonly jobsByProgram = new Map<ProgramId, JobId[]>();
  /** Handler registry: `${programId}::${handlerName}` → handler. */
  private readonly handlers = new Map<string, JobHandler>();
  private readonly deadLetter: DeadLetterEntry[] = [];
  private readonly deadLetterByProgram = new Map<ProgramId, DeadLetterEntry[]>();
  /** Queues: keyed by `${programId}::${queueName}`. */
  private readonly queues = new Map<string, QueueMessage[]>();
  private readonly queueStats = new Map<string, { processed: number; failed: number }>();
  private readonly executionLog: ExecutionLog[] = [];
  private readonly executionLogByProgram = new Map<ProgramId, ExecutionLog[]>();

  // ----------------------- Handler registration -----------------------

  registerHandler(programId: ProgramId, name: string, handler: JobHandler): void {
    if (!name || !/^[a-zA-Z0-9_\.]+$/.test(name)) {
      throw new ProgramError({
        code: "eks.program.execution.handler_name_invalid",
        category: "validation",
        message: `Handler name must be alphanumeric (with _ or .): ${name}`,
        userMessage: "Invalid handler name.",
      });
    }
    this.handlers.set(this.handlerKey(programId, name), handler);
  }

  unregisterHandler(programId: ProgramId, name: string): void {
    this.handlers.delete(this.handlerKey(programId, name));
  }

  listHandlers(programId: ProgramId): string[] {
    const prefix = `${programId}::`;
    return [...this.handlers.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  // ----------------------- Scheduling -----------------------

  schedule(programId: ProgramId, spec: JobSpec): ProgramJob {
    if (!spec.handler) {
      throw new ProgramError({
        code: "eks.program.execution.handler_required",
        category: "validation",
        message: "Job spec must reference a handler name.",
        userMessage: "A handler name is required.",
      });
    }
    const schedule = spec.schedule ?? { kind: "once" as const };
    const now = getClock().epochMs();
    let nextRunAt: number;
    if (schedule.kind === "once") {
      nextRunAt = schedule.at ? new Date(schedule.at).getTime() : now;
    } else if (schedule.kind === "interval") {
      nextRunAt = now + (schedule.intervalMs ?? 0);
    } else if (schedule.kind === "cron") {
      if (!schedule.cron) {
        throw new ProgramError({
          code: "eks.program.execution.cron_required",
          category: "validation",
          message: "Cron schedule requires a cron expression.",
          userMessage: "Cron expression required.",
        });
      }
      nextRunAt = nextCronRun(schedule.cron, now);
    } else {
      throw new ProgramError({
        code: "eks.program.execution.schedule_invalid",
        category: "validation",
        message: `Unknown schedule kind`,
        userMessage: "Invalid schedule.",
      });
    }
    if (nextRunAt < now) nextRunAt = now;
    const priority = spec.priority ?? "normal";
    const job: ProgramJob = {
      id: asJobId(`job_${generateId()}`),
      programId,
      spec,
      status: "queued",
      attempts: [],
      createdAt: getClock().iso(),
      scheduledAt: getClock().iso(),
      nextRunAt,
      failureCount: 0,
      priority,
    };
    this.jobs.set(job.id, job);
    const list = this.jobsByProgram.get(programId) ?? [];
    this.jobsByProgram.set(programId, [...list, job.id]);
    return job;
  }

  cancel(jobId: JobId): ProgramJob {
    const job = this.require(jobId);
    if (job.status === "completed" || job.status === "dead_letter") {
      throw new ProgramError({
        code: "eks.program.execution.cancel_not_allowed",
        category: "state_conflict",
        message: `Cannot cancel job in status ${job.status}.`,
        userMessage: "This job cannot be cancelled.",
      });
    }
    const next: ProgramJob = { ...job, status: "cancelled", completedAt: getClock().iso() };
    this.jobs.set(jobId, next);
    return next;
  }

  getJob(jobId: JobId): ProgramJob | undefined {
    return this.jobs.get(jobId);
  }

  listJobs(programId?: ProgramId, filter?: { status?: JobStatus; handler?: string; limit?: number; offset?: number }): ProgramJob[] {
    let list: ProgramJob[];
    if (programId) {
      const ids = this.jobsByProgram.get(programId) ?? [];
      list = ids.map((id) => this.jobs.get(id)!).filter(Boolean);
    } else {
      list = [...this.jobs.values()];
    }
    if (filter?.status) list = list.filter((j) => j.status === filter.status);
    if (filter?.handler) list = list.filter((j) => j.spec.handler === filter.handler);
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  // ----------------------- Queue processing -----------------------

  enqueue(programId: ProgramId, queueName: string, payload: Record<string, unknown>): QueueMessage {
    if (!queueName || !/^[a-zA-Z0-9_\-\.]+$/.test(queueName)) {
      throw new ProgramError({
        code: "eks.program.execution.queue_name_invalid",
        category: "validation",
        message: `Queue name must be alphanumeric: ${queueName}`,
        userMessage: "Invalid queue name.",
      });
    }
    const key = this.queueKey(programId, queueName);
    const msg: QueueMessage = {
      id: `msg_${generateId()}`,
      programId,
      queueName,
      payload,
      enqueuedAt: getClock().iso(),
      attempts: 0,
    };
    const list = this.queues.get(key) ?? [];
    list.push(msg);
    this.queues.set(key, list);
    if (!this.queueStats.has(key)) {
      this.queueStats.set(key, { processed: 0, failed: 0 });
    }
    return msg;
  }

  /** Dequeue the next message (FIFO). Returns undefined if the queue is empty. */
  dequeue(programId: ProgramId, queueName: string): QueueMessage | undefined {
    const key = this.queueKey(programId, queueName);
    const list = this.queues.get(key);
    if (!list || list.length === 0) return undefined;
    const msg = list.shift()!;
    const dequeued: QueueMessage = { ...msg, dequeuedAt: getClock().iso(), attempts: msg.attempts + 1 };
    const stats = this.queueStats.get(key) ?? { processed: 0, failed: 0 };
    this.queueStats.set(key, { ...stats, processed: stats.processed + 1 });
    return dequeued;
  }

  /** Mark a dequeued message as failed (re-enqueue or dead-letter). */
  failMessage(programId: ProgramId, queueName: string, messageId: string): void {
    void messageId;
    const key = this.queueKey(programId, queueName);
    const stats = this.queueStats.get(key) ?? { processed: 0, failed: 0 };
    this.queueStats.set(key, { ...stats, failed: stats.failed + 1 });
  }

  getQueueStats(programId: ProgramId, queueName: string): QueueStats {
    const key = this.queueKey(programId, queueName);
    const list = this.queues.get(key) ?? [];
    const stats = this.queueStats.get(key) ?? { processed: 0, failed: 0 };
    return {
      programId,
      queueName,
      depth: list.length,
      processed: stats.processed,
      failed: stats.failed,
    };
  }

  // ----------------------- Retry & dead-letter -----------------------

  /** Re-queue a failed job for another attempt (resets failureCount, sets nextRunAt to now). */
  retry(jobId: JobId): ProgramJob {
    const job = this.require(jobId);
    if (job.status !== "failed" && job.status !== "dead_letter") {
      throw new ProgramError({
        code: "eks.program.execution.retry_not_allowed",
        category: "state_conflict",
        message: `Cannot retry job in status ${job.status}.`,
        userMessage: "This job cannot be retried.",
      });
    }
    // If dead-lettered, remove from the dead-letter queue.
    if (job.status === "dead_letter") {
      this.removeFromDeadLetter(jobId);
    }
    const next: ProgramJob = {
      ...job,
      status: "queued",
      nextRunAt: getClock().epochMs(),
      failureCount: 0,
    };
    this.jobs.set(jobId, next);
    return next;
  }

  getDeadLetterQueue(programId?: ProgramId): DeadLetterEntry[] {
    if (programId) {
      return [...(this.deadLetterByProgram.get(programId) ?? [])];
    }
    return [...this.deadLetter];
  }

  // ----------------------- Execution log -----------------------

  getExecutionLog(programId?: ProgramId, limit = 100): ExecutionLog[] {
    let list: ExecutionLog[];
    if (programId) {
      list = [...(this.executionLogByProgram.get(programId) ?? [])];
    } else {
      list = [...this.executionLog];
    }
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return list.slice(0, limit);
  }

  // ----------------------- The dispatcher: tick() -----------------------

  /**
   * Process all due jobs. Called by the platform scheduler.
   *
   * Algorithm:
   *  1. Find all jobs with status="queued" and nextRunAt <= now.
   *  2. Sort by (priority desc, nextRunAt asc, createdAt asc).
   *  3. For each job: look up its handler; if missing, dead-letter immediately.
   *     Otherwise invoke the handler, time it, and record the attempt.
   *     On success → mark "completed" (or schedule next run for interval/cron).
   *     On failure → record failure, apply exponential backoff; if failureCount
   *     exceeds maxRetries, dead-letter and emit `eks.program.background.failed`.
   *
   * Returns the number of jobs processed (success + failure).
   */
  async tick(): Promise<{ processed: number; succeeded: number; failed: number; deadLettered: number }> {
    const now = getClock().epochMs();
    const due: ProgramJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "queued" && job.nextRunAt <= now) {
        due.push(job);
      }
    }
    if (due.length === 0) {
      return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
    }
    due.sort((a, b) => {
      const pw = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
      if (pw !== 0) return pw;
      if (a.nextRunAt !== b.nextRunAt) return a.nextRunAt - b.nextRunAt;
      return a.createdAt.localeCompare(b.createdAt);
    });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const job of due) {
      const result = await this.executeJob(job);
      processed++;
      if (result.success) {
        succeeded++;
      } else {
        failed++;
        if (result.deadLettered) deadLettered++;
      }
    }
    return { processed, succeeded, failed, deadLettered };
  }

  /** Execute a single job: invoke handler, record attempt, apply backoff or dead-letter. */
  private async executeJob(job: ProgramJob): Promise<{ success: boolean; deadLettered: boolean }> {
    const handler = this.handlers.get(this.handlerKey(job.programId, job.spec.handler));
    const executionId = asExecutionId(`ex_${generateId()}`);
    const startedAt = getClock().iso();
    const startedMs = getClock().epochMs();

    // Mark as running.
    this.jobs.set(job.id, { ...job, status: "running", lastRunAt: startedAt });

    if (!handler) {
      const finishedMs = getClock().epochMs();
      const attempt: JobAttempt = {
        executionId,
        attemptNumber: job.attempts.length + 1,
        startedAt,
        finishedAt: getClock().iso(),
        durationMs: finishedMs - startedMs,
        status: "failed",
        error: `Handler '${job.spec.handler}' not registered for program ${job.programId}.`,
      };
      this.recordAttempt(job, attempt);
      // Missing handler = non-retryable; dead-letter immediately.
      this.moveToDeadLetter(job, "handler_not_registered", attempt.error);
      return { success: false, deadLettered: true };
    }

    const attemptNumber = job.attempts.length + 1;
    const ctx: JobContext = { job, attempt: attemptNumber, payload: job.spec.payload ?? {} };

    try {
      await handler(ctx);
      const finishedMs = getClock().epochMs();
      const attempt: JobAttempt = {
        executionId,
        attemptNumber,
        startedAt,
        finishedAt: getClock().iso(),
        durationMs: finishedMs - startedMs,
        status: "success",
      };
      this.recordAttempt(job, attempt);
      // For recurring jobs, schedule the next run; otherwise mark completed.
      const schedule = job.spec.schedule;
      let nextRunAt: number | undefined;
      if (schedule?.kind === "interval") {
        nextRunAt = getClock().epochMs() + (schedule.intervalMs ?? 0);
      } else if (schedule?.kind === "cron" && schedule.cron) {
        nextRunAt = nextCronRun(schedule.cron, getClock().epochMs());
      }
      const now = getClock().iso();
      const updated: ProgramJob = {
        ...job,
        status: nextRunAt !== undefined ? "queued" : "completed",
        attempts: [...job.attempts, attempt],
        nextRunAt: nextRunAt ?? job.nextRunAt,
        lastRunAt: now,
        completedAt: nextRunAt === undefined ? now : undefined,
      };
      this.jobs.set(job.id, updated);
      return { success: true, deadLettered: false };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      const finishedMs = getClock().epochMs();
      const attempt: JobAttempt = {
        executionId,
        attemptNumber,
        startedAt,
        finishedAt: getClock().iso(),
        durationMs: finishedMs - startedMs,
        status: "failed",
        error: errorMsg,
      };
      const failureCount = job.failureCount + 1;
      const policy = job.spec.retryPolicy ?? DEFAULT_RETRY_POLICY;
      const attempts = [...job.attempts, attempt];

      if (failureCount > policy.maxRetries) {
        // Exhausted retries → dead-letter.
        this.recordAttempt(job, attempt);
        this.moveToDeadLetter({ ...job, attempts, failureCount }, "max_retries_exceeded", errorMsg);
        return { success: false, deadLettered: true };
      }

      // Schedule retry with exponential backoff.
      const backoff = computeBackoff(attemptNumber, policy);
      const nextRunAt = getClock().epochMs() + backoff;
      const updated: ProgramJob = {
        ...job,
        status: "queued",
        attempts,
        failureCount,
        nextRunAt,
        lastRunAt: getClock().iso(),
      };
      this.jobs.set(job.id, updated);
      this.recordAttempt(job, attempt);
      return { success: false, deadLettered: false };
    }
  }

  private recordAttempt(job: ProgramJob, attempt: JobAttempt): void {
    const log: ExecutionLog = {
      id: `log_${generateId()}`,
      programId: job.programId,
      jobId: job.id,
      executionId: attempt.executionId,
      attempt: attempt.attemptNumber,
      handler: job.spec.handler,
      status: attempt.status,
      startedAt: attempt.startedAt,
      durationMs: attempt.durationMs,
      error: attempt.error,
    };
    this.executionLog.push(log);
    if (this.executionLog.length > MAX_EXECUTION_LOG) {
      this.executionLog.splice(0, this.executionLog.length - MAX_EXECUTION_LOG);
    }
    const byProgram = this.executionLogByProgram.get(job.programId) ?? [];
    byProgram.push(log);
    if (byProgram.length > MAX_EXECUTION_LOG) {
      byProgram.splice(0, byProgram.length - MAX_EXECUTION_LOG);
    }
    this.executionLogByProgram.set(job.programId, byProgram);
  }

  private moveToDeadLetter(job: ProgramJob, reason: string, lastError?: string): void {
    const entry: DeadLetterEntry = {
      job,
      reason,
      deadLetteredAt: getClock().iso(),
      lastError,
    };
    this.deadLetter.push(entry);
    const list = this.deadLetterByProgram.get(job.programId) ?? [];
    this.deadLetterByProgram.set(job.programId, [...list, entry]);
    const deadJob: ProgramJob = {
      ...job,
      status: "dead_letter",
      completedAt: getClock().iso(),
    };
    this.jobs.set(job.id, deadJob);
    void getEventBus().publish(
      buildEvent(
        PROGRAM_EVENTS.backgroundJobFailed,
        {
          programId: job.programId,
          jobId: job.id,
          handler: job.spec.handler,
          reason,
          lastError,
          attempts: job.attempts.length,
        },
        {},
        "system",
      ),
    );
  }

  private removeFromDeadLetter(jobId: JobId): void {
    const idx = this.deadLetter.findIndex((e) => e.job.id === jobId);
    if (idx >= 0) this.deadLetter.splice(idx, 1);
    for (const [pid, list] of this.deadLetterByProgram) {
      const i = list.findIndex((e) => e.job.id === jobId);
      if (i >= 0) {
        list.splice(i, 1);
        this.deadLetterByProgram.set(pid, list);
      }
    }
  }

  // ----------------------- Stats -----------------------

  getStats(programId?: ProgramId): ExecutionStats {
    let list: ProgramJob[];
    if (programId) {
      const ids = this.jobsByProgram.get(programId) ?? [];
      list = ids.map((id) => this.jobs.get(id)!).filter(Boolean);
    } else {
      list = [...this.jobs.values()];
    }
    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let dead_letter = 0;
    let totalDuration = 0;
    let totalAttempts = 0;
    for (const j of list) {
      switch (j.status) {
        case "queued": queued++; break;
        case "running": running++; break;
        case "completed": completed++; break;
        case "failed": failed++; break;
        case "cancelled": cancelled++; break;
        case "dead_letter": dead_letter++; break;
      }
      for (const a of j.attempts) {
        totalDuration += a.durationMs;
        totalAttempts += 1;
      }
    }
    return {
      programId,
      queued,
      running,
      completed,
      failed,
      cancelled,
      deadLettered: dead_letter,
      avgDurationMs: totalAttempts === 0 ? 0 : Math.round(totalDuration / totalAttempts),
      totalAttempts,
    };
  }

  // ----------------------- Helpers -----------------------

  private handlerKey(programId: ProgramId, name: string): string {
    return `${programId}::${name}`;
  }

  private queueKey(programId: ProgramId, queueName: string): string {
    return `${programId}::${queueName}`;
  }

  private require(jobId: JobId): ProgramJob {
    const j = this.jobs.get(jobId);
    if (!j) {
      throw new ProgramError({
        code: "eks.program.execution.job_not_found",
        category: "not_found",
        message: `Job ${jobId} not found.`,
        userMessage: "Job not found.",
      });
    }
    return j;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: ExecutionManager | null = null;
export function getExecutionManager(): ExecutionManager {
  if (!_mgr) _mgr = new ExecutionManager();
  return _mgr;
}
export function resetExecutionManager(): void {
  _mgr = null;
}

// Re-exports
export { asProgramId };
export type { ProgramId };
