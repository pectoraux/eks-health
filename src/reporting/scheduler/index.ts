/**
 * Eks-Health Reporting Platform — Scheduled Reports
 *
 * Owns recurring report schedules: a cron expression, a template, a list of
 * recipient account ids, and an output format. The scheduler computes
 * `nextRun` from the cron expression, runs due schedules on `sweep()`,
 * generates a real `Report` via the `ReportBuilder`, and records each run.
 *
 * What IS implemented here (real, working, no mocks):
 *   - `schedule(templateId, cronExpression, recipients, format)`: validates
 *     the cron expression, computes `nextRun`, persists the schedule.
 *   - `unschedule`, `list`, `get`.
 *   - `run(scheduleId)`: fetches the template, generates a real report via
 *     `getReportBuilder().generate(...)`, creates an export, "distributes"
 *     it to recipients (records the delivery — a real adapter could email
 *     or post the downloadUrl), and updates lastRun/nextRun.
 *   - `sweep()`: finds all active schedules whose `nextRun <= now`, runs
 *     them, and returns the run results. Designed to be called by the
 *     platform scheduler tick.
 *   - `getStats()`: total schedules, active count, runs completed, avg
 *     generation time.
 *   - REAL cron matching: 5-field UNIX cron parser (minute hour dom month
 *     dow) with `*`, `N`, `N-M`, `N,M,K`, `* / S`, `N-M / S`. Same algorithm as
 *     the kernel scheduler (re-implemented locally because the kernel
 *     parser is not exported).
 *
 * What is NOT here:
 *   - No real email/HTTP delivery. "Distribute to recipients" records the
 *     distribution as a structured event; a real adapter wires the
 *     downloadUrl to an email/SMS/webhook transport.
 */

import "server-only";
import type { AccountId } from "@/identity";
import { generateId, getClock, getEventBus, buildEvent } from "@/kernel";
import type { Report, ReportFormat, ReportId, ReportSchedule, ReportScheduleId, ReportTemplateId } from "../core";
import {
  asReportScheduleId,
  asReportTemplateId,
  ReportError,
  REPORTING_EVENTS,
} from "../core";
import { getReportBuilder } from "../builder";

// ---------------------------------------------------------------------------
// Internal mutable schedule
// ---------------------------------------------------------------------------

interface MutableSchedule {
  id: ReportScheduleId;
  templateId: ReportTemplateId;
  cronExpression: string;
  recipients: AccountId[];
  format: ReportFormat;
  parameters: Record<string, unknown>;
  active: boolean;
  status: "active" | "paused" | "completed" | "failed";
  lastRun?: string;
  nextRun?: string;
  lastReportId?: ReportId;
  lastError?: string;
  runsCompleted: number;
  runsFailed: number;
  createdAt: string;
  createdBy: string;
}

export interface ScheduleRunResult {
  readonly schedule: ReportSchedule;
  readonly report?: Report;
  readonly exportId?: string;
  readonly distributed: boolean;
  readonly error?: string;
  readonly latencyMs: number;
}

export interface SchedulerStats {
  readonly totalSchedules: number;
  readonly active: number;
  readonly paused: number;
  readonly completed: number;
  readonly failed: number;
  readonly runsCompleted: number;
  readonly runsFailed: number;
  readonly avgGenerationMs: number;
  readonly dueNow: number;
}

// ---------------------------------------------------------------------------
// Cron parser (5-field UNIX cron) — re-implemented locally because the
// kernel's `parseCronField` / `nextCronRun` are not exported. Same algorithm.
//   minute hour day-of-month month day-of-week
//   0-59   0-23 1-31           1-12  0-6 (0=Sunday)
// Supports: *, N, N-M, N,M,K, * / S, N-M / S
// ---------------------------------------------------------------------------

function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const raw of field.split(",")) {
    const part = raw.trim();
    if (part === "*") {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }
    const stepStar = /^\/(\d+)$/.exec(part) ?? /^\*\/(\d+)$/.exec(part);
    if (stepStar) {
      const step = parseInt(stepStar[1], 10);
      if (!step || step < 1) throw new Error(`Invalid cron step in "${field}"`);
      for (let i = min; i <= max; i += step) result.add(i);
      continue;
    }
    const rangeWithStep = /^(\d+)-(\d+)\/(\d+)$/.exec(part);
    if (rangeWithStep) {
      const lo = parseInt(rangeWithStep[1], 10);
      const hi = parseInt(rangeWithStep[2], 10);
      const step = parseInt(rangeWithStep[3], 10);
      if (step < 1) throw new Error(`Invalid cron step in "${field}"`);
      for (let i = lo; i <= hi; i += step) result.add(i);
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = parseInt(range[1], 10);
      const hi = parseInt(range[2], 10);
      for (let i = lo; i <= hi; i++) result.add(i);
      continue;
    }
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
  for (let i = 0; i < 525_600; i++) {
    if (cronMatches(compiled, next)) return next.getTime();
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  throw new Error(`No next run within 1 year for cron expression "${expr}"`);
}

/** Returns true if `now` matches the cron expression. */
function cronMatchesNow(expr: string, now: Date): boolean {
  return cronMatches(compileCron(expr), now);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class ReportScheduler {
  private readonly schedules = new Map<ReportScheduleId, MutableSchedule>();
  private totalGenerationMs = 0;
  private totalRuns = 0;

  // ----------------------- CRUD -----------------------

  schedule(input: {
    readonly templateId: ReportTemplateId | string;
    readonly cronExpression: string;
    readonly recipients: readonly AccountId[] | readonly string[];
    readonly format?: ReportFormat;
    readonly parameters?: Readonly<Record<string, unknown>>;
    readonly active?: boolean;
    readonly createdBy?: string;
  }): ReportSchedule {
    const templateId = asReportTemplateId(String(input.templateId));
    // Validate cron by computing the next run eagerly.
    let nextRun: number;
    try {
      nextRun = nextCronRun(input.cronExpression, new Date());
    } catch (e) {
      throw new ReportError({
        code: "eks.reporting.schedule.invalid_cron",
        category: "validation",
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (!input.recipients || input.recipients.length === 0) {
      throw new ReportError({
        code: "eks.reporting.schedule.no_recipients",
        category: "validation",
        message: "At least one recipient is required",
      });
    }
    const id = asReportScheduleId(`rsc_${generateId()}`);
    const now = getClock().iso();
    const schedule: MutableSchedule = {
      id,
      templateId,
      cronExpression: input.cronExpression,
      recipients: [...input.recipients] as AccountId[],
      format: input.format ?? "json",
      parameters: input.parameters ? { ...input.parameters } : {},
      active: input.active ?? true,
      status: "active",
      nextRun: new Date(nextRun).toISOString(),
      runsCompleted: 0,
      runsFailed: 0,
      createdAt: now,
      createdBy: input.createdBy ?? "system",
    };
    this.schedules.set(id, schedule);

    void this.emit(REPORTING_EVENTS.scheduleCreated, {
      scheduleId: id,
      templateId,
      cronExpression: schedule.cronExpression,
      recipientCount: schedule.recipients.length,
      nextRun: schedule.nextRun,
      at: now,
    });

    return this.toSchedule(schedule);
  }

  unschedule(id: ReportScheduleId): boolean {
    const s = this.schedules.get(id);
    if (!s) return false;
    s.active = false;
    s.status = "completed";
    return this.schedules.delete(id);
  }

  pause(id: ReportScheduleId): boolean {
    const s = this.schedules.get(id);
    if (!s) return false;
    s.active = false;
    s.status = "paused";
    return true;
  }

  resume(id: ReportScheduleId): boolean {
    const s = this.schedules.get(id);
    if (!s) return false;
    s.active = true;
    s.status = "active";
    try {
      s.nextRun = new Date(nextCronRun(s.cronExpression, new Date())).toISOString();
    } catch {
      // Leave nextRun unchanged if cron is somehow invalid now.
    }
    return true;
  }

  get(id: ReportScheduleId): ReportSchedule | undefined {
    const s = this.schedules.get(id);
    return s ? this.toSchedule(s) : undefined;
  }

  list(filter?: {
    readonly active?: boolean;
    readonly templateId?: ReportTemplateId;
    readonly status?: "active" | "paused" | "completed" | "failed";
  }): readonly ReportSchedule[] {
    let list = [...this.schedules.values()];
    if (filter?.active !== undefined) list = list.filter((s) => s.active === filter.active);
    if (filter?.templateId) list = list.filter((s) => s.templateId === filter.templateId);
    if (filter?.status) list = list.filter((s) => s.status === filter.status);
    list.sort((a, b) => (a.nextRun ?? "").localeCompare(b.nextRun ?? ""));
    return list.map((s) => this.toSchedule(s));
  }

  // ----------------------- Run -----------------------

  /**
   * Run a schedule: generate a real report from its template, create an
   * export, "distribute" to recipients (record the distribution), and update
   * lastRun/nextRun/runsCompleted.
   */
  async run(scheduleId: ReportScheduleId): Promise<ScheduleRunResult> {
    const s = this.schedules.get(scheduleId);
    if (!s) {
      throw new ReportError({
        code: "eks.reporting.schedule.not_found",
        category: "schedule_not_found",
        message: `Schedule ${scheduleId} not found`,
      });
    }
    const startedAt = Date.now();
    const builder = getReportBuilder();

    try {
      const report = await builder.generate({
        templateId: s.templateId,
        parameters: s.parameters,
        format: s.format,
        generatedBy: `scheduler:${s.id}`,
        title: `Scheduled report — ${s.cronExpression}`,
      });
      const exportRecord = await builder.export(report.id, s.format);

      // Distribute: record the delivery. A real adapter would email/SMS/webhook
      // the downloadUrl to each recipient.
      const distributed = await this.distribute(s, report, exportRecord.downloadUrl);

      s.lastRun = getClock().iso();
      s.lastReportId = report.id;
      s.lastError = undefined;
      s.runsCompleted++;
      s.status = "active";
      try {
        s.nextRun = new Date(nextCronRun(s.cronExpression, new Date())).toISOString();
      } catch {
        // If the cron becomes invalid, leave nextRun unchanged.
      }

      const latencyMs = Date.now() - startedAt;
      this.totalGenerationMs += latencyMs;
      this.totalRuns++;

      void this.emit(REPORTING_EVENTS.scheduleRun, {
        scheduleId: s.id,
        templateId: s.templateId,
        reportId: report.id,
        exportId: exportRecord.id,
        recipientCount: s.recipients.length,
        latencyMs,
        at: s.lastRun,
      });

      return {
        schedule: this.toSchedule(s),
        report,
        exportId: exportRecord.id,
        distributed,
        latencyMs,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      s.lastRun = getClock().iso();
      s.lastError = message;
      s.runsFailed++;
      s.status = "failed";
      try {
        s.nextRun = new Date(nextCronRun(s.cronExpression, new Date())).toISOString();
      } catch {
        // leave unchanged
      }
      const latencyMs = Date.now() - startedAt;
      this.totalRuns++;

      void this.emit(REPORTING_EVENTS.scheduleFailed, {
        scheduleId: s.id,
        templateId: s.templateId,
        error: message,
        latencyMs,
        at: s.lastRun,
      });

      return {
        schedule: this.toSchedule(s),
        distributed: false,
        error: message,
        latencyMs,
      };
    }
  }

  /**
   * Distribute a generated report to recipients. Records the distribution
   * as an event; a real adapter wires the downloadUrl to an email/SMS/
   * webhook transport. Returns true if at least one recipient was notified.
   */
  private async distribute(
    s: MutableSchedule,
    report: Report,
    downloadUrl: string | undefined,
  ): Promise<boolean> {
    if (s.recipients.length === 0 || !downloadUrl) return false;
    void this.emit(REPORTING_EVENTS.scheduleCompleted, {
      scheduleId: s.id,
      reportId: report.id,
      recipients: s.recipients,
      downloadUrl,
      format: s.format,
      at: getClock().iso(),
    });
    return true;
  }

  /**
   * Sweep: find all active schedules whose `nextRun` is due (or whose cron
   * matches now), run them, and return the results. Designed to be called
   * by the platform scheduler on each tick.
   */
  async sweep(now: Date = new Date()): Promise<readonly ScheduleRunResult[]> {
    const due: MutableSchedule[] = [];
    const nowMs = now.getTime();
    for (const s of this.schedules.values()) {
      if (!s.active) continue;
      // Due if nextRun is in the past OR the cron matches the current minute.
      const dueByTime = s.nextRun ? new Date(s.nextRun).getTime() <= nowMs : false;
      const dueByCron = cronMatchesNow(s.cronExpression, now);
      if (dueByTime || dueByCron) {
        due.push(s);
      }
    }
    const results: ScheduleRunResult[] = [];
    for (const s of due) {
      const result = await this.run(s.id);
      results.push(result);
    }
    return results;
  }

  getStats(): SchedulerStats {
    const all = [...this.schedules.values()];
    let active = 0, paused = 0, completed = 0, failed = 0;
    const nowMs = Date.now();
    let dueNow = 0;
    for (const s of all) {
      if (s.status === "active") active++;
      else if (s.status === "paused") paused++;
      else if (s.status === "completed") completed++;
      else if (s.status === "failed") failed++;
      if (s.active && s.nextRun && new Date(s.nextRun).getTime() <= nowMs) dueNow++;
    }
    return {
      totalSchedules: all.length,
      active,
      paused,
      completed,
      failed,
      runsCompleted: all.reduce((sum, s) => sum + s.runsCompleted, 0),
      runsFailed: all.reduce((sum, s) => sum + s.runsFailed, 0),
      avgGenerationMs: this.totalRuns === 0 ? 0 : Math.round(this.totalGenerationMs / this.totalRuns),
      dueNow,
    };
  }

  // ----------------------- Helpers -----------------------

  private toSchedule(s: MutableSchedule): ReportSchedule {
    return {
      id: s.id,
      templateId: s.templateId,
      cronExpression: s.cronExpression,
      recipients: [...s.recipients],
      format: s.format,
      parameters: s.parameters,
      active: s.active,
      status: s.status,
      lastRun: s.lastRun,
      nextRun: s.nextRun,
      lastReportId: s.lastReportId,
      lastError: s.lastError,
      runsCompleted: s.runsCompleted,
      runsFailed: s.runsFailed,
      createdAt: s.createdAt,
      createdBy: s.createdBy,
    };
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const bus = getEventBus();
      await bus.publish(buildEvent(type, payload, { actor: { kind: "service", id: "reporting-scheduler" } }, "scheduled"));
    } catch {
      // EventBus optional.
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _scheduler: ReportScheduler | null = null;

export function getReportScheduler(): ReportScheduler {
  if (!_scheduler) _scheduler = new ReportScheduler();
  return _scheduler;
}

export function resetReportScheduler(): void {
  _scheduler = null;
}
