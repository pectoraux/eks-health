/**
 * Eks-Health Reporting Platform — Custom Report Builder
 *
 * Real report generation from platform data. The builder owns:
 *   - A template registry (pre-seeded with 6 platform templates).
 *   - A generated-report registry.
 *   - A real section-resolver that maps a section's `dataSource` string
 *     (e.g. `"platform.stats"`, `"programs.list"`, `"marketplace.listings"`)
 *     to a function that fetches the underlying data from the matching
 *     subsystem (each call guarded with try/catch).
 *   - Real formatters for JSON, CSV, and Markdown output.
 *
 * What IS implemented here (real, working, no mocks):
 *   - `createTemplate`, `getTemplate`, `listTemplates`.
 *   - `generate(templateId, parameters, format)`: resolves each section,
 *     fetches real data, assembles a `Report`, persists it, and emits
 *     `reportGenerated`.
 *   - `export(reportId, format)`: serializes the report to JSON / CSV /
 *     Markdown and creates a `ReportExport` with the byte size + a
 *     synthetic `downloadUrl` (a real URL the platform can serve the
 *     export from).
 *   - `getReport`, `listReports`, `getExport`, `listExports`.
 *   - 6 pre-registered templates covering operational, program, developer,
 *     population, research, and financial report types.
 *
 * What is NOT here:
 *   - No real HTTP serving of `downloadUrl`. The URL is well-formed
 *     (`/api/reporting/exports/{id}`) and a route handler can resolve it
 *     to the serialized bytes via `getExport(id)`.
 */

import "server-only";
import type { AccountId } from "@/identity";
import { generateId, getClock, getEventBus, buildEvent } from "@/kernel";
import type {
  Report,
  ReportExport,
  ReportExportId,
  ReportFilter,
  ReportFormat,
  ReportId,
  ReportSection,
  ReportTemplate,
  ReportTemplateId,
  ReportTemplateParameter,
  ReportTemplateSection,
  ReportType,
} from "../core";
import {
  asReportExportId,
  asReportId,
  asReportTemplateId,
  ReportError,
  REPORTING_EVENTS,
} from "../core";

// ---------------------------------------------------------------------------
// Internal mutable records
// ---------------------------------------------------------------------------

interface MutableReport {
  id: ReportId;
  title: string;
  description?: string;
  type: ReportType;
  sections: ReportSection[];
  filters: ReportFilter[];
  generatedAt: string;
  generatedBy: string;
  format: ReportFormat;
  data: Record<string, unknown>;
  templateId?: ReportTemplateId;
  parameters?: Record<string, unknown>;
}

interface MutableTemplate {
  id: ReportTemplateId;
  name: string;
  description?: string;
  type: ReportType;
  sections: ReportTemplateSection[];
  parameters: ReportTemplateParameter[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface MutableExport {
  id: ReportExportId;
  reportId: ReportId;
  format: ReportFormat;
  sizeBytes: number;
  downloadUrl?: string;
  expiresAt?: string;
  status: "pending" | "ready" | "failed" | "expired";
  createdAt: string;
  error?: string;
  content: string; // serialized bytes (kept in memory)
}

// ---------------------------------------------------------------------------
// Section data sources — REAL fetchers from platform subsystems.
// Each fetcher is guarded so a missing subsystem returns `[]` / `null` rather
// than throwing. The fetcher receives the section config + report parameters.
// ---------------------------------------------------------------------------

type SectionFetcher = (
  config: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

function safeFetch<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  return Promise.resolve()
    .then(() => fn())
    .catch(() => undefined);
}

const SECTION_FETCHERS: Record<string, SectionFetcher> = {
  "platform.stats": async () => {
    return safeFetch(async () => {
      const k = await import("@/kernel");
      return k.kernelSnapshot();
    });
  },

  "platform.info": async () => {
    return safeFetch(async () => {
      const k = await import("@/kernel");
      return k.kernelInfo();
    });
  },

  "programs.list": async (_config, params) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    return safeFetch(async () => {
      const p = await import("@/programs");
      return p.getRegistry().list().slice(0, limit).map((pr) => ({
        id: pr.id,
        name: pr.name,
        slug: pr.slug,
        kind: pr.kind,
        state: pr.state,
        category: pr.category,
        developerId: pr.developerId,
        installedCount: pr.installedCount,
        activeInstallCount: pr.activeInstallCount,
        rating: pr.rating,
      }));
    });
  },

  "programs.stats": async () => {
    return safeFetch(async () => {
      const p = await import("@/programs");
      const all = p.getRegistry().list();
      const byState: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      for (const pr of all) {
        byState[pr.state] = (byState[pr.state] ?? 0) + 1;
        byCategory[pr.category] = (byCategory[pr.category] ?? 0) + 1;
      }
      return {
        total: all.length,
        byState,
        byCategory,
        totalInstalled: all.reduce((s, p) => s + p.installedCount, 0),
        totalActiveInstalled: all.reduce((s, p) => s + p.activeInstallCount, 0),
      };
    });
  },

  "accounts.list": async (_config, params) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    return safeFetch(async () => {
      const id = await import("@/identity");
      return id.getAccounts().list().slice(0, limit).map((a) => ({
        id: a.id,
        email: a.email,
        displayName: a.displayName,
        state: a.state,
        activePersona: a.activePersona,
        createdAt: a.createdAt,
      }));
    });
  },

  "accounts.stats": async () => {
    return safeFetch(async () => {
      const id = await import("@/identity");
      const all = id.getAccounts().list();
      const byState: Record<string, number> = {};
      const byPersona: Record<string, number> = {};
      for (const a of all) {
        byState[a.state] = (byState[a.state] ?? 0) + 1;
        byPersona[a.activePersona] = (byPersona[a.activePersona] ?? 0) + 1;
      }
      return { total: all.length, byState, byPersona };
    });
  },

  "organizations.list": async (_config, params) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    return safeFetch(async () => {
      const id = await import("@/identity");
      return id.getOrganizations().list().slice(0, limit).map((o) => ({
        id: o.id,
        name: o.name,
        slug: o.slug,
        type: o.type,
        status: o.status,
        dataClassification: o.dataClassification,
      }));
    });
  },

  "organizations.stats": async () => {
    return safeFetch(async () => {
      const id = await import("@/identity");
      const all = id.getOrganizations().list();
      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const o of all) {
        byType[o.type] = (byType[o.type] ?? 0) + 1;
        byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
      }
      return { total: all.length, byType, byStatus };
    });
  },

  "marketplace.listings": async (_config, params) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    return safeFetch(async () => {
      const mp = await import("@/marketplace");
      return mp.getProfiles().list().slice(0, limit).map((l) => ({
        id: l.id,
        name: l.solution.name,
        category: l.solution.category,
        status: l.status,
        developerId: l.developerId,
        developerName: l.developerName,
        installCount: l.installCount,
        activeInstallCount: l.activeInstallCount,
      }));
    });
  },

  "marketplace.stats": async () => {
    return safeFetch(async () => {
      const mp = await import("@/marketplace");
      const all = mp.getProfiles().list();
      return {
        total: all.length,
        totalInstalls: all.reduce((s, l) => s + l.installCount, 0),
        totalActiveInstalls: all.reduce((s, l) => s + l.activeInstallCount, 0),
        byCategory: all.reduce<Record<string, number>>((acc, l) => {
          const c = l.solution.category;
          acc[c] = (acc[c] ?? 0) + 1;
          return acc;
        }, {}),
      };
    });
  },

  "marketplace.revenue": async () => {
    return safeFetch(async () => {
      const mp = await import("@/marketplace");
      return mp.getRevenue().getStats();
    });
  },

  "measurements.stats": async () => {
    return safeFetch(async () => {
      const h = await import("@/health");
      const all = h.getMeasurements().list();
      const schemas = h.getSchemas().list();
      return {
        total: all.length,
        totalSchemas: schemas.length,
        byVerification: all.reduce<Record<string, number>>((acc, m) => {
          const s = String(m.verificationState);
          acc[s] = (acc[s] ?? 0) + 1;
          return acc;
        }, {}),
      };
    });
  },

  "competitions.stats": async () => {
    return safeFetch(async () => {
      const c = await import("@/competitions");
      const all = c.getCompetitions().list();
      return {
        total: all.length,
        totalParticipants: all.reduce((s, c) => s + c.currentParticipants, 0),
        byState: all.reduce<Record<string, number>>((acc, c) => {
          acc[c.state] = (acc[c.state] ?? 0) + 1;
          return acc;
        }, {}),
      };
    });
  },

  "missions.stats": async () => {
    return safeFetch(async () => {
      const m = await import("@/missions");
      const all = m.getMissions().list();
      return {
        total: all.length,
        byState: all.reduce<Record<string, number>>((acc, mi) => {
          acc[mi.state] = (acc[mi.state] ?? 0) + 1;
          return acc;
        }, {}),
        byCategory: all.reduce<Record<string, number>>((acc, mi) => {
          acc[mi.category] = (acc[mi.category] ?? 0) + 1;
          return acc;
        }, {}),
      };
    });
  },

  "research.evidence": async (_config, params) => {
    const limit = typeof params.limit === "number" ? params.limit : 10;
    return safeFetch(async () => {
      const r = await import("@/research");
      return r.getEvidenceEngine().getTopEvidence(limit).map((e) => ({
        programId: e.programId,
        confidenceScore: e.confidenceScore,
        evidenceLevel: e.evidenceLevel,
        totalParticipants: e.totalParticipants,
        averageImprovement: e.averageImprovement,
      }));
    });
  },

  "research.stats": async () => {
    return safeFetch(async () => {
      const r = await import("@/research");
      const pubs = r.getPublications().list();
      const evidenceStats = r.getEvidenceEngine().getStats();
      return {
        totalPublications: pubs.length,
        peerReviewed: pubs.filter((p) => p.peerReviewed).length,
        evidenceStats,
      };
    });
  },

  "population.stats": async () => {
    return safeFetch(async () => {
      const pop = await import("@/population");
      return {
        hierarchy: pop.getHierarchy().getStats(),
        memberships: pop.getMemberships().getStats(),
        analytics: pop.getPopulationAnalytics().getStats(),
      };
    });
  },

  "developer.profiles": async (_config, params) => {
    const limit = typeof params.limit === "number" ? params.limit : 50;
    return safeFetch(async () => {
      const p = await import("@/programs");
      return p.getDeveloperManager().listProfiles().slice(0, limit).map((d) => ({
        id: d.id,
        name: d.name,
        email: d.email,
        status: d.status,
        verificationStatus: d.verification.status,
        organization: d.organization,
      }));
    });
  },
};

// ---------------------------------------------------------------------------
// Formatters — REAL JSON / CSV / Markdown serialization
// ---------------------------------------------------------------------------

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatCsv(value: unknown): string {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
    const rows = value as readonly Record<string, unknown>[];
    const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => escape(row[h])).join(","));
    }
    return lines.join("\n");
  }
  // Single object or primitive — fall back to a two-column key,value CSV.
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const lines = ["key,value"];
    for (const [k, v] of entries) {
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      const esc = /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      lines.push(`${k},${esc}`);
    }
    return lines.join("\n");
  }
  return String(value ?? "");
}

function formatMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push(`# ${report.title}`);
  lines.push("");
  if (report.description) {
    lines.push(report.description);
    lines.push("");
  }
  lines.push(`**Type:** ${report.type}`);
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Generated By:** ${report.generatedBy}`);
  lines.push(`**Format:** ${report.format}`);
  lines.push("");
  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    switch (section.type) {
      case "table": {
        const data = section.data;
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
          const rows = data as readonly Record<string, unknown>[];
          const headers = Object.keys(rows[0]);
          lines.push(`| ${headers.join(" | ")} |`);
          lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
          for (const row of rows) {
            lines.push(`| ${headers.map((h) => String(row[h] ?? "")).join(" | ")} |`);
          }
        } else {
          lines.push("*(no rows)*");
        }
        lines.push("");
        break;
      }
      case "metric": {
        const data = section.data as Record<string, unknown> | undefined;
        if (data) {
          for (const [k, v] of Object.entries(data)) {
            lines.push(`- **${k}:** ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
          }
        }
        lines.push("");
        break;
      }
      case "chart": {
        lines.push("```json");
        lines.push(JSON.stringify(section.data, null, 2));
        lines.push("```");
        lines.push("");
        break;
      }
      case "text": {
        lines.push(String(section.data ?? ""));
        lines.push("");
        break;
      }
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class ReportBuilder {
  private readonly templates = new Map<ReportTemplateId, MutableTemplate>();
  private readonly reports = new Map<ReportId, MutableReport>();
  private readonly exports = new Map<ReportExportId, MutableExport>();

  constructor() {
    this.seedDefaultTemplates();
  }

  // ----------------------- Templates -----------------------

  createTemplate(input: {
    readonly name: string;
    readonly type: ReportType;
    readonly sections: readonly ReportTemplateSection[];
    readonly parameters?: readonly ReportTemplateParameter[];
    readonly description?: string;
    readonly createdBy?: string;
  }): ReportTemplate {
    if (!input.name) throw new ReportError({
      code: "eks.reporting.template.invalid",
      category: "validation",
      message: "Template name is required",
    });
    const id = asReportTemplateId(`rpt_${generateId()}`);
    const now = getClock().iso();
    const tpl: MutableTemplate = {
      id,
      name: input.name,
      description: input.description,
      type: input.type,
      sections: [...input.sections],
      parameters: input.parameters ? [...input.parameters] : [],
      createdBy: input.createdBy ?? "system",
      createdAt: now,
      updatedAt: now,
    };
    this.templates.set(id, tpl);
    void this.emit(REPORTING_EVENTS.templateCreated, { templateId: id, name: tpl.name, type: tpl.type, at: now });
    return this.toTemplate(tpl);
  }

  getTemplate(id: ReportTemplateId): ReportTemplate | undefined {
    const t = this.templates.get(id);
    return t ? this.toTemplate(t) : undefined;
  }

  listTemplates(type?: ReportType): readonly ReportTemplate[] {
    let list = [...this.templates.values()];
    if (type) list = list.filter((t) => t.type === type);
    return list.map((t) => this.toTemplate(t));
  }

  // ----------------------- Generation -----------------------

  async generate(input: {
    readonly templateId: ReportTemplateId;
    readonly parameters?: Readonly<Record<string, unknown>>;
    readonly format?: ReportFormat;
    readonly generatedBy?: string;
    readonly filters?: readonly ReportFilter[];
    readonly title?: string;
  }): Promise<Report> {
    const tpl = this.templates.get(input.templateId);
    if (!tpl) {
      throw new ReportError({
        code: "eks.reporting.template.not_found",
        category: "template_not_found",
        message: `Template ${input.templateId} not found`,
      });
    }
    const params = input.parameters ?? {};
    const format = input.format ?? "json";
    const startedAt = Date.now();

    // Resolve each section via its data source fetcher.
    const sections: ReportSection[] = [];
    const data: Record<string, unknown> = {};
    for (const def of tpl.sections) {
      const fetcher = SECTION_FETCHERS[def.dataSource];
      let sectionData: unknown;
      if (!fetcher) {
        sectionData = { error: `Unknown data source: ${def.dataSource}` };
      } else {
        try {
          sectionData = await fetcher(def.config ?? {}, params);
        } catch (e) {
          sectionData = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      sections.push({
        title: def.title,
        type: def.type,
        data: sectionData,
        config: def.config,
      });
      data[def.id] = sectionData;
    }

    const id = asReportId(`rep_${generateId()}`);
    const generatedAt = getClock().iso();
    const report: MutableReport = {
      id,
      title: input.title ?? tpl.name,
      description: tpl.description,
      type: tpl.type,
      sections,
      filters: input.filters ? [...input.filters] : [],
      generatedAt,
      generatedBy: input.generatedBy ?? "system",
      format,
      data,
      templateId: tpl.id,
      parameters: params,
    };
    this.reports.set(id, report);

    const latencyMs = Date.now() - startedAt;
    void this.emit(REPORTING_EVENTS.reportGenerated, {
      reportId: id,
      templateId: tpl.id,
      type: tpl.type,
      format,
      sectionCount: sections.length,
      latencyMs,
      at: generatedAt,
    });

    return this.toReport(report);
  }

  // ----------------------- Exports -----------------------

  async export(reportId: ReportId, format: ReportFormat): Promise<ReportExport> {
    const report = this.reports.get(reportId);
    if (!report) {
      throw new ReportError({
        code: "eks.reporting.report.not_found",
        category: "report_not_found",
        message: `Report ${reportId} not found`,
      });
    }
    let content: string;
    try {
      switch (format) {
        case "json":
          content = formatJson(this.toReport(report));
          break;
        case "csv":
          // CSV is best for tabular sections; pick the first table section,
          // else fall back to the whole report's data object as key,value.
          content = formatCsv(this.pickCsvData(report));
          break;
        case "markdown":
          content = formatMarkdown(this.toReport(report));
          break;
        default: {
          const _exhaustive: never = format;
          throw new ReportError({
            code: "eks.reporting.export.format_unsupported",
            category: "validation",
            message: `Unsupported export format: ${String(_exhaustive)}`,
          });
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const exportId = asReportExportId(`rpx_${generateId()}`);
      const failed: MutableExport = {
        id: exportId,
        reportId,
        format,
        sizeBytes: 0,
        status: "failed",
        createdAt: getClock().iso(),
        error: err.message,
        content: "",
      };
      this.exports.set(exportId, failed);
      void this.emit(REPORTING_EVENTS.exportExpired, { exportId, reportId, error: err.message, at: failed.createdAt });
      throw new ReportError({
        code: "eks.reporting.export.failed",
        category: "export_failed",
        message: err.message,
        cause: err,
      });
    }

    const exportId = asReportExportId(`rpx_${generateId()}`);
    const createdAt = getClock().iso();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    const exportRecord: MutableExport = {
      id: exportId,
      reportId,
      format,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      downloadUrl: `/api/reporting/exports/${exportId}`,
      expiresAt,
      status: "ready",
      createdAt,
      content,
    };
    this.exports.set(exportId, exportRecord);

    void this.emit(REPORTING_EVENTS.exportCreated, {
      exportId,
      reportId,
      format,
      sizeBytes: exportRecord.sizeBytes,
      at: createdAt,
    });

    return this.toExport(exportRecord);
  }

  /** Return the in-memory serialized content of an export (for HTTP serving). */
  getExportContent(id: ReportExportId): string | undefined {
    const e = this.exports.get(id);
    return e?.content;
  }

  getReport(id: ReportId): Report | undefined {
    const r = this.reports.get(id);
    return r ? this.toReport(r) : undefined;
  }

  listReports(filter?: { readonly type?: ReportType; readonly templateId?: ReportTemplateId }): readonly Report[] {
    let list = [...this.reports.values()];
    if (filter?.type) list = list.filter((r) => r.type === filter.type);
    if (filter?.templateId) list = list.filter((r) => r.templateId === filter.templateId);
    list.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    return list.map((r) => this.toReport(r));
  }

  getExport(id: ReportExportId): ReportExport | undefined {
    const e = this.exports.get(id);
    return e ? this.toExport(e) : undefined;
  }

  listExports(filter?: { readonly reportId?: ReportId; readonly format?: ReportFormat }): readonly ReportExport[] {
    let list = [...this.exports.values()];
    if (filter?.reportId) list = list.filter((e) => e.reportId === filter.reportId);
    if (filter?.format) list = list.filter((e) => e.format === filter.format);
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return list.map((e) => this.toExport(e));
  }

  getStats(): {
    readonly totalTemplates: number;
    readonly totalReports: number;
    readonly totalExports: number;
    readonly byType: Readonly<Record<string, number>>;
    readonly byFormat: Readonly<Record<string, number>>;
  } {
    const byType: Record<string, number> = {};
    const byFormat: Record<string, number> = {};
    for (const r of this.reports.values()) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      byFormat[r.format] = (byFormat[r.format] ?? 0) + 1;
    }
    return {
      totalTemplates: this.templates.size,
      totalReports: this.reports.size,
      totalExports: this.exports.size,
      byType,
      byFormat,
    };
  }

  // ----------------------- Helpers -----------------------

  private pickCsvData(report: MutableReport): unknown {
    const table = report.sections.find((s) => s.type === "table");
    if (table) return table.data;
    // Fall back to the first section's data.
    return report.sections[0]?.data ?? report.data;
  }

  private toTemplate(t: MutableTemplate): ReportTemplate {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      type: t.type,
      sections: [...t.sections],
      parameters: [...t.parameters],
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private toReport(r: MutableReport): Report {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      type: r.type,
      sections: [...r.sections],
      filters: [...r.filters],
      generatedAt: r.generatedAt,
      generatedBy: r.generatedBy,
      format: r.format,
      data: r.data,
      templateId: r.templateId,
      parameters: r.parameters,
    };
  }

  private toExport(e: MutableExport): ReportExport {
    return {
      id: e.id,
      reportId: e.reportId,
      format: e.format,
      sizeBytes: e.sizeBytes,
      downloadUrl: e.downloadUrl,
      expiresAt: e.expiresAt,
      status: e.status,
      createdAt: e.createdAt,
      error: e.error,
    };
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const bus = getEventBus();
      await bus.publish(buildEvent(type, payload, { actor: { kind: "service", id: "reporting-builder" } }, "domain"));
    } catch {
      // EventBus optional.
    }
  }

  // ----------------------- Default templates -----------------------

  private seedDefaultTemplates(): void {
    const now = getClock().iso();

    // 1) Operational Dashboard
    this.templates.set(asReportTemplateId("tpl_operational_dashboard"), {
      id: asReportTemplateId("tpl_operational_dashboard"),
      name: "Operational Dashboard",
      description: "Platform-wide operational health snapshot: accounts, programs, measurements, competitions, missions.",
      type: "operational",
      sections: [
        { id: "platform", title: "Platform Info", type: "metric", dataSource: "platform.info" },
        { id: "accounts", title: "Account Statistics", type: "metric", dataSource: "accounts.stats" },
        { id: "programs", title: "Program Statistics", type: "metric", dataSource: "programs.stats" },
        { id: "measurements", title: "Measurement Statistics", type: "metric", dataSource: "measurements.stats" },
        { id: "competitions", title: "Competition Statistics", type: "metric", dataSource: "competitions.stats" },
        { id: "missions", title: "Mission Statistics", type: "metric", dataSource: "missions.stats" },
      ],
      parameters: [],
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });

    // 2) Program Performance
    this.templates.set(asReportTemplateId("tpl_program_performance"), {
      id: asReportTemplateId("tpl_program_performance"),
      name: "Program Performance",
      description: "Catalog of all programs with install counts, ratings, and lifecycle state.",
      type: "program",
      sections: [
        { id: "summary", title: "Program Summary", type: "metric", dataSource: "programs.stats" },
        { id: "list", title: "Program Catalog", type: "table", dataSource: "programs.list", config: {} },
        { id: "marketplace", title: "Marketplace Listings", type: "table", dataSource: "marketplace.listings" },
      ],
      parameters: [
        { name: "limit", type: "number", default: 50, description: "Maximum rows per section" },
      ],
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });

    // 3) Developer Revenue
    this.templates.set(asReportTemplateId("tpl_developer_revenue"), {
      id: asReportTemplateId("tpl_developer_revenue"),
      name: "Developer Revenue",
      description: "Developer profiles, marketplace installs, and revenue share statistics.",
      type: "developer",
      sections: [
        { id: "developers", title: "Developer Profiles", type: "table", dataSource: "developer.profiles" },
        { id: "marketplace", title: "Marketplace Stats", type: "metric", dataSource: "marketplace.stats" },
        { id: "revenue", title: "Revenue Share", type: "metric", dataSource: "marketplace.revenue" },
      ],
      parameters: [
        { name: "limit", type: "number", default: 50, description: "Maximum developer rows" },
      ],
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });

    // 4) Population Health
    this.templates.set(asReportTemplateId("tpl_population_health"), {
      id: asReportTemplateId("tpl_population_health"),
      name: "Population Health",
      description: "Organizations, memberships, and population analytics.",
      type: "population",
      sections: [
        { id: "orgs", title: "Organizations", type: "table", dataSource: "organizations.list" },
        { id: "orgStats", title: "Organization Statistics", type: "metric", dataSource: "organizations.stats" },
        { id: "population", title: "Population Statistics", type: "metric", dataSource: "population.stats" },
      ],
      parameters: [
        { name: "limit", type: "number", default: 50, description: "Maximum organization rows" },
      ],
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });

    // 5) Research Summary
    this.templates.set(asReportTemplateId("tpl_research_summary"), {
      id: asReportTemplateId("tpl_research_summary"),
      name: "Research Summary",
      description: "Top research evidence and publication statistics.",
      type: "research",
      sections: [
        { id: "evidence", title: "Top Evidence", type: "table", dataSource: "research.evidence" },
        { id: "stats", title: "Research Statistics", type: "metric", dataSource: "research.stats" },
      ],
      parameters: [
        { name: "limit", type: "number", default: 10, description: "Maximum evidence rows" },
      ],
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });

    // 6) Financial Overview
    this.templates.set(asReportTemplateId("tpl_financial_overview"), {
      id: asReportTemplateId("tpl_financial_overview"),
      name: "Financial Overview",
      description: "Marketplace revenue share, install counts, and program catalog value.",
      type: "financial",
      sections: [
        { id: "revenue", title: "Revenue Share Statistics", type: "metric", dataSource: "marketplace.revenue" },
        { id: "marketplace", title: "Marketplace Statistics", type: "metric", dataSource: "marketplace.stats" },
        { id: "listings", title: "Marketplace Listings", type: "table", dataSource: "marketplace.listings" },
        { id: "programs", title: "Program Catalog", type: "table", dataSource: "programs.list" },
      ],
      parameters: [
        { name: "limit", type: "number", default: 50, description: "Maximum rows per section" },
      ],
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _builder: ReportBuilder | null = null;

export function getReportBuilder(): ReportBuilder {
  if (!_builder) _builder = new ReportBuilder();
  return _builder;
}

export function resetReportBuilder(): void {
  _builder = null;
}

// ---------------------------------------------------------------------------
// Helpers for external callers
// ---------------------------------------------------------------------------

export function asAccountIdList(ids: readonly string[]): readonly AccountId[] {
  return ids as readonly AccountId[];
}
