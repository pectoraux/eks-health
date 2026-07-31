/**
 * Eks-Health Reporting Platform — Core Types
 *
 * The shared vocabulary for the reporting subsystem: branded ids for reports,
 * templates, schedules, and exports; the `Report`, `ReportTemplate`,
 * `ReportSchedule`, `ReportExport`, `ReportSection`, and `ReportFilter`
 * shapes; the canonical `REPORTING_EVENTS` catalog; and the `ReportError`
 * class.
 *
 * Everything here is a pure type/constants declaration — no runtime logic.
 * The scheduler and builder modules implement real behavior on top of these.
 */

import type { Brand } from "@/kernel";
import type { AccountId } from "@/identity";

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

export type ReportId = Brand<string, "ReportId">;
export type ReportTemplateId = Brand<string, "ReportTemplateId">;
export type ReportScheduleId = Brand<string, "ReportScheduleId">;
export type ReportExportId = Brand<string, "ReportExportId">;

export function asReportId(s: string): ReportId {
  return s as ReportId;
}
export function asReportTemplateId(s: string): ReportTemplateId {
  return s as ReportTemplateId;
}
export function asReportScheduleId(s: string): ReportScheduleId {
  return s as ReportScheduleId;
}
export function asReportExportId(s: string): ReportExportId {
  return s as ReportExportId;
}

// ---------------------------------------------------------------------------
// Report types & sections
// ---------------------------------------------------------------------------

export type ReportType =
  | "operational"
  | "program"
  | "developer"
  | "population"
  | "research"
  | "financial"
  | "custom";

export type ReportFormat = "json" | "csv" | "markdown";

export type ReportSectionType = "table" | "chart" | "metric" | "text";

export interface ReportSection {
  readonly title: string;
  readonly type: ReportSectionType;
  readonly data: unknown;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ReportFilter {
  readonly field: string;
  readonly op: "eq" | "ne" | "in" | "gt" | "gte" | "lt" | "lte" | "between" | "exists";
  readonly value?: unknown;
  readonly values?: readonly unknown[];
}

export interface Report {
  readonly id: ReportId;
  readonly title: string;
  readonly description?: string;
  readonly type: ReportType;
  readonly sections: readonly ReportSection[];
  readonly filters: readonly ReportFilter[];
  readonly generatedAt: string;
  readonly generatedBy: string;
  readonly format: ReportFormat;
  readonly data: Readonly<Record<string, unknown>>;
  readonly templateId?: ReportTemplateId;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface ReportTemplate {
  readonly id: ReportTemplateId;
  readonly name: string;
  readonly description?: string;
  readonly type: ReportType;
  readonly sections: readonly ReportTemplateSection[];
  readonly parameters: readonly ReportTemplateParameter[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReportTemplateSection {
  readonly id: string;
  readonly title: string;
  readonly type: ReportSectionType;
  readonly dataSource: string; // "platform.stats" | "programs.list" | etc.
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ReportTemplateParameter {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "date" | "select";
  readonly required?: boolean;
  readonly default?: unknown;
  readonly options?: readonly string[];
  readonly description?: string;
}

export type ReportScheduleStatus = "active" | "paused" | "completed" | "failed";

export interface ReportSchedule {
  readonly id: ReportScheduleId;
  readonly templateId: ReportTemplateId;
  readonly cronExpression: string;
  readonly recipients: readonly AccountId[];
  readonly format: ReportFormat;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly active: boolean;
  readonly status: ReportScheduleStatus;
  readonly lastRun?: string;
  readonly nextRun?: string;
  readonly lastReportId?: ReportId;
  readonly lastError?: string;
  readonly runsCompleted: number;
  readonly runsFailed: number;
  readonly createdAt: string;
  readonly createdBy: string;
}

export type ReportExportStatus = "pending" | "ready" | "failed" | "expired";

export interface ReportExport {
  readonly id: ReportExportId;
  readonly reportId: ReportId;
  readonly format: ReportFormat;
  readonly sizeBytes: number;
  readonly downloadUrl?: string;
  readonly expiresAt?: string;
  readonly status: ReportExportStatus;
  readonly createdAt: string;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReportErrorCategory =
  | "validation"
  | "not_found"
  | "template_not_found"
  | "schedule_not_found"
  | "report_not_found"
  | "export_failed"
  | "generation_failed"
  | "delivery_failed"
  | "configuration";

export class ReportError extends Error {
  readonly code: string;
  readonly category: ReportErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly metadata: Record<string, unknown>;
  readonly timestamp: string;

  constructor(init: {
    code: string;
    category: ReportErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "ReportError";
    this.code = init.code;
    this.category = init.category;
    this.retryable = init.retryable ?? false;
    this.userMessage = init.userMessage ?? init.message;
    this.metadata = init.metadata ?? {};
    this.timestamp = new Date().toISOString();
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      developerMessage: this.message,
      metadata: this.metadata,
      timestamp: this.timestamp,
    };
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const REPORTING_EVENTS = {
  templateCreated: "eks.reporting.template_created",
  templateUpdated: "eks.reporting.template_updated",
  reportGenerated: "eks.reporting.report_generated",
  reportGenerationFailed: "eks.reporting.report_generation_failed",
  exportCreated: "eks.reporting.export_created",
  exportExpired: "eks.reporting.export_expired",
  scheduleCreated: "eks.reporting.schedule_created",
  scheduleRun: "eks.reporting.schedule_run",
  scheduleFailed: "eks.reporting.schedule_failed",
  scheduleCompleted: "eks.reporting.schedule_completed",
} as const;

export type ReportingEventName = (typeof REPORTING_EVENTS)[keyof typeof REPORTING_EVENTS];
