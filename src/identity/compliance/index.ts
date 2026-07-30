/**
 * Eks-Health Identity — Compliance Readiness
 *
 * Design the platform to support GDPR, HIPAA, SOC 2, ISO 27001, CCPA, PIPEDA
 * and regional privacy laws — WITHOUT hardcoding compliance rules into
 * business logic. Compliance is purely declarative: each framework declares
 * its controls; each control maps to a platform feature (e.g. GDPR "right to
 * erasure" → privacy.requestDeletion). Readiness is computed from control
 * status, not from ad-hoc checks.
 *
 * Data Subject Requests (DSRs / DSARs) are routed to the privacy engine.
 * Breach notifications track the regulatory timeline (e.g. GDPR 72h).
 *
 * No external deps beyond node:crypto.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type AccountId,
  IdentityError,
  IDENTITY_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import type { Brand } from "@/kernel";
import { getPrivacy } from "../privacy";

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

export type FrameworkId = Brand<string, "FrameworkId">;
export type ControlId = Brand<string, "ControlId">;
export type DsrId = Brand<string, "DsrId">;
export type BreachId = Brand<string, "BreachId">;

function asFrameworkId(s: string): FrameworkId { return s as FrameworkId; }
function asControlId(s: string): ControlId { return s as ControlId; }
function asDsrId(s: string): DsrId { return s as DsrId; }
function asBreachId(s: string): BreachId { return s as BreachId; }

// ---------------------------------------------------------------------------
// Frameworks & controls
// ---------------------------------------------------------------------------

export type ComplianceFrameworkKind =
  | "gdpr"
  | "hipaa"
  | "soc2"
  | "iso27001"
  | "ccpa"
  | "pipeda"
  | "local";

export type ControlStatus =
  | "implemented"
  | "partial"
  | "planned"
  | "not_applicable";

export interface ComplianceControl {
  readonly id: ControlId;
  readonly frameworkId: FrameworkId;
  readonly code: string; // e.g. "GDPR-15.1", "HIPAA-164.312(a)(1)"
  readonly title: string;
  readonly description: string;
  readonly status: ControlStatus;
  readonly mapsTo?: string; // platform feature, e.g. "privacy.requestDeletion"
  readonly evidence?: string;
  readonly assessedAt?: string;
  readonly assessedBy?: string;
}

export interface ComplianceMapping {
  readonly controlId: ControlId;
  readonly feature: string;
  readonly notes?: string;
}

export interface ComplianceAssessment {
  readonly controlId: ControlId;
  readonly status: ControlStatus;
  readonly evidence: string;
  readonly assessedAt: string;
  readonly assessedBy: string;
}

export interface ComplianceFramework {
  readonly id: FrameworkId;
  readonly kind: ComplianceFrameworkKind;
  readonly name: string;
  readonly description: string;
  readonly region?: string; // e.g. "EU", "US", "CA", "GLOBAL"
  readonly regulator?: string;
  readonly controls: ComplianceControl[];
  readonly notificationWindowHours?: number; // breach notification deadline
}

// ---------------------------------------------------------------------------
// Data Subject Requests (GDPR DSARs)
// ---------------------------------------------------------------------------

export type DsrType =
  | "access"
  | "rectification"
  | "erasure"
  | "portability"
  | "restriction"
  | "objection";

export type DsrStatus =
  | "received"
  | "in_progress"
  | "completed"
  | "denied"
  | "cancelled";

export interface DataSubjectRequest {
  readonly id: DsrId;
  readonly accountId: AccountId;
  readonly type: DsrType;
  readonly status: DsrStatus;
  readonly receivedAt: string;
  readonly dueBy: string; // GDPR: 1 month default
  readonly completedAt?: string;
  readonly denialReason?: string;
  readonly requestorId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Breach notifications
// ---------------------------------------------------------------------------

export type BreachSeverity = "low" | "medium" | "high" | "critical";

export interface BreachNotification {
  readonly id: BreachId;
  readonly frameworkId?: FrameworkId;
  readonly title: string;
  readonly description: string;
  readonly severity: BreachSeverity;
  readonly discoveredAt: string;
  readonly reportedAt?: string;
  readonly reportedBy?: string;
  readonly affectedAccounts: AccountId[];
  readonly affectedRecords?: number;
  readonly notificationDeadline: string; // computed from framework
  readonly notificationsSent: Array<{
    readonly recipient: string; // "regulator" | "data_subjects" | "dpo"
    readonly sentAt: string;
    readonly channel: "email" | "letter" | "portal" | "phone";
  }>;
  readonly contained: boolean;
  readonly containedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Compliance report
// ---------------------------------------------------------------------------

export interface ComplianceReport {
  readonly frameworkId: FrameworkId;
  readonly frameworkName: string;
  readonly generatedAt: string;
  readonly totalControls: number;
  readonly byStatus: Record<ControlStatus, number>;
  readonly readinessPercent: number;
  readonly gaps: Array<{ controlId: ControlId; code: string; title: string; status: ControlStatus }>;
  readonly mappings: ComplianceMapping[];
  readonly controls: Array<{
    readonly id: ControlId;
    readonly code: string;
    readonly title: string;
    readonly status: ControlStatus;
    readonly mapsTo?: string;
    readonly evidence?: string;
    readonly assessedAt?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Framework catalog (5 frameworks, declarative)
// ---------------------------------------------------------------------------

function ctl(frameworkId: string, code: string, title: string, description: string, status: ControlStatus, mapsTo?: string): ComplianceControl {
  return {
    id: asControlId(`${frameworkId}:${code}`),
    frameworkId: asFrameworkId(frameworkId),
    code,
    title,
    description,
    status,
    mapsTo,
  };
}

export const FRAMEWORKS: Record<ComplianceFrameworkKind, ComplianceFramework> = {
  gdpr: {
    id: asFrameworkId("gdpr"),
    kind: "gdpr",
    name: "General Data Protection Regulation",
    description: "EU regulation on data protection and privacy for all individuals within the European Union and the European Economic Area.",
    region: "EU",
    regulator: "European Data Protection Board",
    notificationWindowHours: 72,
    controls: [
      ctl("gdpr", "Art.6", "Lawfulness of processing", "Processing must have a lawful basis (consent, contract, legal obligation, vital interests, public task, legitimate interests).", "implemented", "consent.platform"),
      ctl("gdpr", "Art.7", "Conditions for consent", "Consent must be freely given, specific, informed, and unambiguous; withdrawable at any time.", "implemented", "consent.platform"),
      ctl("gdpr", "Art.9", "Special categories of data", "Health data requires explicit consent and additional safeguards.", "implemented", "data_gateway.field_policy"),
      ctl("gdpr", "Art.12", "Transparent information", "Privacy notices must be concise, intelligible, and easily accessible.", "implemented", "consent.receipts"),
      ctl("gdpr", "Art.15", "Right of access", "Data subjects can obtain confirmation of processing and a copy of their data.", "implemented", "privacy.requestExport"),
      ctl("gdpr", "Art.16", "Right to rectification", "Data subjects can correct inaccurate personal data.", "implemented", "privacy.requestCorrection"),
      ctl("gdpr", "Art.17", "Right to erasure", "Data subjects can request deletion of their personal data ('right to be forgotten').", "implemented", "privacy.requestDeletion"),
      ctl("gdpr", "Art.18", "Right to restriction", "Data subjects can restrict processing in certain circumstances.", "partial", "consent.restrict"),
      ctl("gdpr", "Art.20", "Right to data portability", "Data subjects can receive their data in a structured, machine-readable format.", "implemented", "privacy.requestExport"),
      ctl("gdpr", "Art.21", "Right to object", "Data subjects can object to processing based on legitimate interests or direct marketing.", "implemented", "consent.revoke"),
      ctl("gdpr", "Art.25", "Data protection by design and by default", "Privacy-by-design: minimize collection, default to least permissive settings.", "implemented", "privacy.minimize"),
      ctl("gdpr", "Art.33", "Breach notification", "Notify the supervisory authority within 72 hours of becoming aware of a breach.", "implemented", "compliance.recordBreach"),
      ctl("gdpr", "Art.34", "Communication of breach to data subject", "Notify affected data subjects without undue delay when high risk.", "partial", "notification.breach_alert"),
      ctl("gdpr", "Art.35", "Data Protection Impact Assessment", "Conduct DPIAs for high-risk processing.", "partial", "compliance.assessControl"),
    ],
  },
  hipaa: {
    id: asFrameworkId("hipaa"),
    kind: "hipaa",
    name: "Health Insurance Portability and Accountability Act",
    description: "US federal law providing data privacy and security provisions for safeguarding medical information.",
    region: "US",
    regulator: "HHS Office for Civil Rights",
    notificationWindowHours: 24 * 60, // 60 days for individual notification
    controls: [
      ctl("hipaa", "164.312(a)(1)", "Access Control", "Unique user identification; emergency access; automatic logoff; encryption/decryption.", "implemented", "authorization.evaluate"),
      ctl("hipaa", "164.312(b)", "Audit Controls", "Hardware, software, and procedural mechanisms that record and examine activity.", "implemented", "audit.platform"),
      ctl("hipaa", "164.312(c)(1)", "Integrity", "Mechanisms to authenticate electronic protected health information.", "implemented", "data.integrity"),
      ctl("hipaa", "164.312(d)", "Person or Entity Authentication", "Verify the identity of a person or entity seeking access.", "implemented", "auth.platform"),
      ctl("hipaa", "164.312(e)(1)", "Transmission Security", "Guard against unauthorized access during electronic transmission.", "implemented", "security.encryption"),
      ctl("hipaa", "164.312(a)(2)(iv)", "Encryption and Decryption", "Encrypt ePHI at rest where appropriate.", "implemented", "security.storage"),
      ctl("hipaa", "164.308(a)(5)(ii)(C)", "Automatic Logoff", "End sessions after a defined period of inactivity.", "implemented", "sessions.idle_timeout"),
      ctl("hipaa", "164.308(a)(1)", "Risk Analysis", "Conduct an accurate and thorough assessment of risks to ePHI.", "partial", "monitoring.riskScore"),
      ctl("hipaa", "164.308(a)(2)", "Risk Management", "Implement measures sufficient to reduce risks to a reasonable level.", "implemented", "policies.manager"),
      ctl("hipaa", "164.308(a)(1)(ii)(C)", "Sanction Policy", "Apply sanctions against workforce members who violate policies.", "partial", "compliance.manager"),
    ],
  },
  soc2: {
    id: asFrameworkId("soc2"),
    kind: "soc2",
    name: "SOC 2 (Trust Services Criteria)",
    description: "Audit framework for service organizations based on five Trust Service Principles: Security, Availability, Processing Integrity, Confidentiality, Privacy.",
    region: "GLOBAL",
    regulator: "AICPA",
    controls: [
      ctl("soc2", "CC6.1", "Logical and Physical Access Controls", "Controls restrict access to authorized users.", "implemented", "authorization.evaluate"),
      ctl("soc2", "CC6.6", "Logical Access Security", "Authentication mechanisms protect against unauthorized access.", "implemented", "auth.platform"),
      ctl("soc2", "CC7.2", "System Operations Monitoring", "Monitor system components for anomalies.", "implemented", "monitoring.platform"),
      ctl("soc2", "CC7.3", "Security Incident Detection", "Detect incidents and respond.", "implemented", "monitoring.detect"),
      ctl("soc2", "CC7.4", "Incident Response", "Incident response procedures are in place.", "implemented", "monitoring.incident"),
      ctl("soc2", "A1.2", "Availability", "Environmental protections, software, and infrastructure backups maintain availability.", "partial", "observability.health"),
      ctl("soc2", "C1.1", "Confidentiality", "Confidential information is protected to meet objectives.", "implemented", "security.encryption"),
      ctl("soc2", "P5.1", "Privacy Notice", "Privacy notices communicate the entity's practices.", "implemented", "consent.platform"),
      ctl("soc2", "P6.1", "Consent", "Consent is obtained for collection, use, and retention.", "implemented", "consent.platform"),
    ],
  },
  iso27001: {
    id: asFrameworkId("iso27001"),
    kind: "iso27001",
    name: "ISO/IEC 27001 Information Security Management",
    description: "International standard for establishing, implementing, maintaining, and continually improving an information security management system.",
    region: "GLOBAL",
    regulator: "ISO/IEC",
    notificationWindowHours: 72,
    controls: [
      ctl("iso27001", "A.5.1", "Information security policies", "Policies for information security are approved and published.", "implemented", "policies.manager"),
      ctl("iso27001", "A.5.10", "Acceptable use of assets", "Rules for acceptable use of information and assets are identified, documented, and implemented.", "implemented", "authorization.evaluate"),
      ctl("iso27001", "A.6.1", "Organizational roles and responsibilities", "Roles and responsibilities for information security are allocated.", "implemented", "roles.manager"),
      ctl("iso27001", "A.6.3", "Information security awareness, education, and training", "Workforce is appropriately trained.", "partial", "compliance.training"),
      ctl("iso27001", "A.5.9", "Inventory of assets", "Assets are identified and an inventory maintained.", "implemented", "storage.manager"),
      ctl("iso27001", "A.5.15", "Access control", "Rules for access are established.", "implemented", "authorization.evaluate"),
      ctl("iso27001", "A.8.24", "Cryptography", "Rules for the effective use of cryptography, including key management, are defined.", "implemented", "security.encryption"),
      ctl("iso27001", "A.8.16", "Monitoring activities", "Networks, systems, and applications are monitored.", "implemented", "monitoring.platform"),
      ctl("iso27001", "A.5.24", "Information security incident management planning", "Plans are defined to respond to information security incidents.", "implemented", "monitoring.incident"),
      ctl("iso27001", "A.5.34", "Privacy and protection of PII", "Privacy and protection of PII is ensured as required by relevant legislation and regulations.", "implemented", "privacy.platform"),
      ctl("iso27001", "A.5.30", "ICT readiness for business continuity", "ICT readiness supports business continuity during disruptions.", "partial", "observability.health"),
    ],
  },
  ccpa: {
    id: asFrameworkId("ccpa"),
    kind: "ccpa",
    name: "California Consumer Privacy Act",
    description: "California state law enhancing privacy rights and consumer protection for residents of California.",
    region: "US-CA",
    regulator: "California Attorney General",
    notificationWindowHours: 72,
    controls: [
      ctl("ccpa", "1798.100", "Right to know", "Consumers can request disclosure of personal information collected.", "implemented", "privacy.requestExport"),
      ctl("ccpa", "1798.105", "Right to delete", "Consumers can request deletion of personal information.", "implemented", "privacy.requestDeletion"),
      ctl("ccpa", "1798.120", "Right to opt-out", "Consumers can opt out of the sale or sharing of their personal information.", "implemented", "consent.revoke"),
      ctl("ccpa", "1798.125", "Right to non-discrimination", "Businesses may not discriminate against consumers for exercising rights.", "implemented", "policies.evaluate"),
      ctl("ccpa", "1798.130", "Methods for submitting requests", "Provide at least two methods for submitting requests (toll-free number, internet website, etc.).", "implemented", "compliance.dsr"),
      ctl("ccpa", "1798.135", "Privacy notice", "Privacy notice must be clear and conspicuous.", "implemented", "consent.receipts"),
    ],
  },
  pipeda: {
    id: asFrameworkId("pipeda"),
    kind: "pipeda",
    name: "Personal Information Protection and Electronic Documents Act",
    description: "Canadian federal privacy law governing the collection, use, and disclosure of personal information by private-sector organizations.",
    region: "CA",
    regulator: "Office of the Privacy Commissioner of Canada",
    notificationWindowHours: 24 * 30, // "as soon as feasible" — 30 days default
    controls: [
      ctl("pipeda", "Principle-1", "Accountability", "Organizations are responsible for personal information under their control.", "implemented", "compliance.manager"),
      ctl("pipeda", "Principle-3", "Consent", "Knowledge and consent are required for collection, use, or disclosure.", "implemented", "consent.platform"),
      ctl("pipeda", "Principle-4", "Limiting Collection", "Limit collection to what is necessary.", "implemented", "privacy.minimize"),
      ctl("pipeda", "Principle-5", "Limiting Use, Disclosure, and Retention", "Use only for the purpose disclosed.", "implemented", "consent.platform"),
      ctl("pipeda", "Principle-9", "Individual Access", "Upon request, inform individuals of the existence, use, and disclosure of their information.", "implemented", "privacy.requestExport"),
      ctl("pipeda", "Principle-10", "Challenging Compliance", "Procedures for receiving and responding to complaints.", "partial", "compliance.dsr"),
    ],
  },
  local: {
    id: asFrameworkId("local"),
    kind: "local",
    name: "Local / Regional Privacy Law",
    description: "Placeholder framework for local or regional privacy regulations not covered by the primary frameworks. Register controls as needed.",
    region: "LOCAL",
    regulator: "Local authority",
    controls: [],
  },
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const COMPLIANCE_EVENTS = {
  dsrCreated: "eks.identity.compliance.dsr_created",
  dsrCompleted: "eks.identity.compliance.dsr_completed",
  breachRecorded: "eks.identity.compliance.breach_recorded",
  reportGenerated: "eks.identity.compliance.report_generated",
  controlAssessed: "eks.identity.compliance.control_assessed",
} as const;

// ---------------------------------------------------------------------------
// Compliance manager
// ---------------------------------------------------------------------------

const CONTROL_STATUS_WEIGHT: Record<ControlStatus, number> = {
  implemented: 1,
  partial: 0.5,
  planned: 0,
  not_applicable: 1, // not applicable doesn't count against readiness
};

const DSR_DUE_DAYS = 30; // GDPR Art.12(3) — 1 month

export class ComplianceManager {
  private readonly frameworks = new Map<FrameworkId, ComplianceFramework>();
  private readonly assessments = new Map<ControlId, ComplianceAssessment>();
  private readonly mappings = new Map<ControlId, ComplianceMapping>();
  private readonly dsrs = new Map<DsrId, DataSubjectRequest>();
  private readonly dsrsByAccount = new Map<AccountId, DsrId[]>();
  private readonly breaches = new Map<BreachId, BreachNotification>();

  constructor() {
    // Auto-register all built-in frameworks.
    for (const f of Object.values(FRAMEWORKS)) this.frameworks.set(f.id, f);
  }

  /** Register a custom framework (extends built-ins). */
  registerFramework(framework: ComplianceFramework): ComplianceFramework {
    this.frameworks.set(framework.id, framework);
    return framework;
  }

  listFrameworks(): ComplianceFramework[] {
    return [...this.frameworks.values()];
  }

  getFramework(id: FrameworkId): ComplianceFramework | undefined {
    return this.frameworks.get(id);
  }

  getFrameworkByKind(kind: ComplianceFrameworkKind): ComplianceFramework | undefined {
    for (const f of this.frameworks.values()) {
      if (f.kind === kind) return f;
    }
    return undefined;
  }

  /** Find a control across all frameworks by id. */
  getControl(controlId: ControlId): ComplianceControl | undefined {
    for (const f of this.frameworks.values()) {
      const c = f.controls.find((c) => c.id === controlId);
      if (c) return c;
    }
    return undefined;
  }

  /** Assess a control's status (records evidence + assessor + timestamp). */
  assessControl(controlId: ControlId, evidence: string, status: ControlStatus, assessedBy: string): ComplianceAssessment {
    const control = this.getControl(controlId);
    if (!control) {
      throw new IdentityError({
        code: "eks.identity.compliance.control_not_found",
        category: "not_found",
        message: `Control ${controlId} not found in any framework.`,
      });
    }
    const assessment: ComplianceAssessment = {
      controlId,
      status,
      evidence,
      assessedAt: getClock().iso(),
      assessedBy,
    };
    this.assessments.set(controlId, assessment);
    void getEventBus().publish(
      buildEvent(
        COMPLIANCE_EVENTS.controlAssessed,
        { controlId, frameworkId: control.frameworkId, status, assessedBy, evidenceSummary: evidence.slice(0, 200) },
        {},
        "domain",
      ),
    );
    return assessment;
  }

  /** Map a control to a platform feature (declarative linkage). */
  mapControlToFeature(controlId: ControlId, feature: string, notes?: string): ComplianceMapping {
    const control = this.getControl(controlId);
    if (!control) {
      throw new IdentityError({
        code: "eks.identity.compliance.control_not_found",
        category: "not_found",
        message: `Control ${controlId} not found.`,
      });
    }
    const mapping: ComplianceMapping = { controlId, feature, notes };
    this.mappings.set(controlId, mapping);
    return mapping;
  }

  /** Get the assessment for a control (or the framework's default). */
  getAssessment(controlId: ControlId): ComplianceAssessment | undefined {
    return this.assessments.get(controlId);
  }

  /** Get the mapping for a control (or the framework's default). */
  getMapping(controlId: ControlId): ComplianceMapping | undefined {
    const explicit = this.mappings.get(controlId);
    if (explicit) return explicit;
    const control = this.getControl(controlId);
    if (control?.mapsTo) return { controlId, feature: control.mapsTo };
    return undefined;
  }

  /**
   * Generate a compliance report for a framework. Includes per-control
   * status, mapping, evidence, and an overall readiness percentage.
   */
  generateReport(frameworkId: FrameworkId): ComplianceReport {
    const framework = this.frameworks.get(frameworkId);
    if (!framework) {
      throw new IdentityError({
        code: "eks.identity.compliance.framework_not_found",
        category: "not_found",
        message: `Framework ${frameworkId} not found.`,
      });
    }
    const byStatus: Record<ControlStatus, number> = {
      implemented: 0,
      partial: 0,
      planned: 0,
      not_applicable: 0,
    };
    let totalWeight = 0;
    let totalControls = 0;
    const gaps: Array<{ controlId: ControlId; code: string; title: string; status: ControlStatus }> = [];
    const controls: ComplianceReport["controls"] = [];
    const mappings: ComplianceMapping[] = [];

    for (const control of framework.controls) {
      const assessment = this.assessments.get(control.id);
      const status = assessment?.status ?? control.status;
      byStatus[status] += 1;
      totalWeight += CONTROL_STATUS_WEIGHT[status];
      totalControls += 1;
      if (status === "planned" || status === "partial") {
        gaps.push({ controlId: control.id, code: control.code, title: control.title, status });
      }
      const mapping = this.getMapping(control.id);
      if (mapping) mappings.push(mapping);
      controls.push({
        id: control.id,
        code: control.code,
        title: control.title,
        status,
        mapsTo: mapping?.feature ?? control.mapsTo,
        evidence: assessment?.evidence ?? control.evidence,
        assessedAt: assessment?.assessedAt ?? control.assessedAt,
      });
    }
    const readinessPercent = totalControls === 0 ? 100 : Math.round((totalWeight / totalControls) * 100);
    const report: ComplianceReport = {
      frameworkId,
      frameworkName: framework.name,
      generatedAt: getClock().iso(),
      totalControls,
      byStatus,
      readinessPercent,
      gaps,
      mappings,
      controls,
    };
    void getEventBus().publish(
      buildEvent(
        COMPLIANCE_EVENTS.reportGenerated,
        { frameworkId, frameworkName: framework.name, readinessPercent, totalControls, gaps: gaps.length },
        {},
        "domain",
      ),
    );
    return report;
  }

  /**
   * Create a Data Subject Request and route it to the privacy engine.
   * Delegation map (GDPR Art. 15-21):
   *   - access / portability → privacy.requestExport(accountId)
   *   - erasure              → privacy.requestDeletion(accountId, requestedBy, reason)
   *   - rectification        → privacy.requestCorrection(accountId, field, currentValue, newValue, reason)
   *   - restriction          → consent.restrict (record only)
   *   - objection            → consent.revoke (record only)
   */
  createDataSubjectRequest(
    accountId: AccountId,
    type: DsrType,
    opts: {
      readonly requestedBy?: AccountId;
      readonly reason?: string;
      readonly field?: string;
      readonly currentValue?: unknown;
      readonly newValue?: unknown;
      readonly requestorId?: string;
      readonly metadata?: Record<string, unknown>;
    } = {},
  ): DataSubjectRequest {
    const now = getClock().iso();
    const dueBy = new Date(Date.now() + DSR_DUE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const requestedBy = opts.requestedBy ?? accountId;
    const reason = opts.reason ?? `dsar:${type}`;
    const requestorId = opts.requestorId;
    const metadata = opts.metadata;
    const dsr: DataSubjectRequest = {
      id: asDsrId(generateId("dsr_")),
      accountId,
      type,
      status: "received",
      receivedAt: now,
      dueBy,
      requestorId,
      metadata,
    };
    this.dsrs.set(dsr.id, dsr);
    const list = this.dsrsByAccount.get(accountId) ?? [];
    list.push(dsr.id);
    this.dsrsByAccount.set(accountId, list);

    void getEventBus().publish(
      buildEvent(
        COMPLIANCE_EVENTS.dsrCreated,
        { dsrId: dsr.id, accountId, type, dueBy, requestorId },
        {},
        "domain",
      ),
    );

    // Route to the privacy engine — real delegation.
    let result: Record<string, unknown> | undefined;
    try {
      const privacy = getPrivacy();
      switch (type) {
        case "access":
        case "portability":
          result = privacy.requestExport(accountId) as unknown as Record<string, unknown>;
          break;
        case "erasure":
          result = privacy.requestDeletion(accountId, requestedBy, reason) as unknown as Record<string, unknown>;
          break;
        case "rectification":
          if (!opts.field) {
            // Without a target field, record the request but don't invoke privacy.
            result = { note: "rectification_requires_field_metadata" };
            break;
          }
          result = privacy.requestCorrection(
            accountId,
            opts.field,
            opts.currentValue,
            opts.newValue,
            reason,
          ) as unknown as Record<string, unknown>;
          break;
        case "restriction":
        case "objection":
          // No direct privacy call; status remains received pending manual review.
          result = { note: `${type}_pending_manual_review` };
          break;
      }
    } catch (e) {
      // Privacy engine failure shouldn't lose the DSR record.
      result = { error: e instanceof Error ? e.message : "privacy_engine_failure" };
    }
    if (result) {
      const updated: DataSubjectRequest = {
        ...dsr,
        status: "in_progress",
        result,
      };
      this.dsrs.set(dsr.id, updated);
      return updated;
    }
    return dsr;
  }

  /** Mark a DSR as completed (or denied with reason). */
  completeDataSubjectRequest(id: DsrId, outcome: "completed" | "denied", denialReason?: string): DataSubjectRequest {
    const existing = this.dsrs.get(id);
    if (!existing) {
      throw new IdentityError({
        code: "eks.identity.compliance.dsr_not_found",
        category: "not_found",
        message: `DSR ${id} not found.`,
      });
    }
    const updated: DataSubjectRequest = {
      ...existing,
      status: outcome,
      completedAt: getClock().iso(),
      denialReason,
    };
    this.dsrs.set(id, updated);
    if (outcome === "completed") {
      void getEventBus().publish(
        buildEvent(
          COMPLIANCE_EVENTS.dsrCompleted,
          { dsrId: id, accountId: existing.accountId, type: existing.type },
          {},
          "domain",
        ),
      );
    }
    return updated;
  }

  listDataSubjectRequests(filter?: { readonly accountId?: AccountId; readonly type?: DsrType; readonly status?: DsrStatus }): DataSubjectRequest[] {
    let list: DataSubjectRequest[];
    if (filter?.accountId) {
      const ids = this.dsrsByAccount.get(filter.accountId) ?? [];
      list = ids.map((id) => this.dsrs.get(id)!).filter((d): d is DataSubjectRequest => !!d);
    } else {
      list = [...this.dsrs.values()];
    }
    if (filter?.type) list = list.filter((d) => d.type === filter.type);
    if (filter?.status) list = list.filter((d) => d.status === filter.status);
    return list.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  /**
   * Record a personal-data breach. Notification deadline is computed from
   * the framework's `notificationWindowHours` (e.g. GDPR = 72h).
   */
  recordBreach(input: {
    readonly title: string;
    readonly description: string;
    readonly severity: BreachSeverity;
    readonly frameworkId?: FrameworkId;
    readonly discoveredAt?: string;
    readonly reportedBy?: string;
    readonly affectedAccounts: AccountId[];
    readonly affectedRecords?: number;
    readonly metadata?: Record<string, unknown>;
  }): BreachNotification {
    const framework = input.frameworkId ? this.frameworks.get(input.frameworkId) : undefined;
    const discoveredAt = input.discoveredAt ?? getClock().iso();
    const windowHours = framework?.notificationWindowHours ?? 72;
    const notificationDeadline = new Date(
      new Date(discoveredAt).getTime() + windowHours * 60 * 60 * 1000,
    ).toISOString();
    const breach: BreachNotification = {
      id: asBreachId(generateId("brch_")),
      frameworkId: input.frameworkId,
      title: input.title,
      description: input.description,
      severity: input.severity,
      discoveredAt,
      reportedBy: input.reportedBy,
      affectedAccounts: input.affectedAccounts,
      affectedRecords: input.affectedRecords,
      notificationDeadline,
      notificationsSent: [],
      contained: false,
      metadata: input.metadata,
    };
    this.breaches.set(breach.id, breach);
    void getEventBus().publish(
      buildEvent(
        COMPLIANCE_EVENTS.breachRecorded,
        {
          breachId: breach.id,
          frameworkId: breach.frameworkId,
          severity: breach.severity,
          affectedAccountCount: breach.affectedAccounts.length,
          notificationDeadline,
        },
        {},
        "domain",
      ),
    );
    return breach;
  }

  /** Mark a breach notification as sent (regulator / data subjects / DPO). */
  recordBreachNotificationSent(
    breachId: BreachId,
    recipient: "regulator" | "data_subjects" | "dpo",
    channel: "email" | "letter" | "portal" | "phone",
  ): BreachNotification {
    const breach = this.breaches.get(breachId);
    if (!breach) {
      throw new IdentityError({
        code: "eks.identity.compliance.breach_not_found",
        category: "not_found",
        message: `Breach ${breachId} not found.`,
      });
    }
    const updated: BreachNotification = {
      ...breach,
      reportedAt: breach.reportedAt ?? getClock().iso(),
      notificationsSent: [
        ...breach.notificationsSent,
        { recipient, sentAt: getClock().iso(), channel },
      ],
    };
    this.breaches.set(breachId, updated);
    return updated;
  }

  /** Mark a breach as contained. */
  containBreach(breachId: BreachId): BreachNotification {
    const breach = this.breaches.get(breachId);
    if (!breach) {
      throw new IdentityError({
        code: "eks.identity.compliance.breach_not_found",
        category: "not_found",
        message: `Breach ${breachId} not found.`,
      });
    }
    const updated: BreachNotification = {
      ...breach,
      contained: true,
      containedAt: getClock().iso(),
    };
    this.breaches.set(breachId, updated);
    return updated;
  }

  listBreaches(filter?: { readonly severity?: BreachSeverity; readonly contained?: boolean }): BreachNotification[] {
    let list = [...this.breaches.values()];
    if (filter?.severity) list = list.filter((b) => b.severity === filter.severity);
    if (filter?.contained !== undefined) list = list.filter((b) => b.contained === filter.contained);
    return list.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
  }

  getBreach(id: BreachId): BreachNotification | undefined {
    return this.breaches.get(id);
  }

  /**
   * Determine which compliance frameworks apply based on jurisdiction and
   * sector. REAL declarative rules — no business logic.
   */
  applicableFrameworks(country: string, sector?: string): ComplianceFramework[] {
    const applicable: ComplianceFramework[] = [];
    const c = country.toUpperCase();
    const EU_COUNTRIES = new Set([
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
      "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
      "SI", "ES", "SE", "IS", "LI", "NO",
    ]);
    if (EU_COUNTRIES.has(c) || c === "GB") {
      applicable.push(this.getFrameworkByKind("gdpr")!);
    }
    if (c === "US") {
      if (sector === "health" || sector === "healthcare" || sector === "medical") {
        applicable.push(this.getFrameworkByKind("hipaa")!);
      }
      if (c === "US") {
        // CCPA applies to California residents regardless of business location
        applicable.push(this.getFrameworkByKind("ccpa")!);
      }
    }
    if (c === "CA") {
      applicable.push(this.getFrameworkByKind("pipeda")!);
    }
    if (sector === "audit" || sector === "saas" || sector === "enterprise") {
      applicable.push(this.getFrameworkByKind("soc2")!);
      applicable.push(this.getFrameworkByKind("iso27001")!);
    }
    // Always include ISO 27001 for SaaS platforms
    if (sector === "saas" && !applicable.some((f) => f.kind === "iso27001")) {
      applicable.push(this.getFrameworkByKind("iso27001")!);
    }
    // De-dup
    const seen = new Set<FrameworkId>();
    return applicable.filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  }

  /** Aggregate readiness across multiple frameworks. */
  aggregateReadiness(frameworkIds: FrameworkId[]): {
    readonly overallPercent: number;
    readonly perFramework: Array<{ readonly frameworkId: FrameworkId; readonly name: string; readonly readinessPercent: number }>;
  } {
    const perFramework = frameworkIds.map((id) => {
      const report = this.generateReport(id);
      return { frameworkId: id, name: report.frameworkName, readinessPercent: report.readinessPercent };
    });
    const overallPercent = perFramework.length === 0
      ? 100
      : Math.round(perFramework.reduce((sum, r) => sum + r.readinessPercent, 0) / perFramework.length);
    return { overallPercent, perFramework };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: ComplianceManager | null = null;
export function getCompliance(): ComplianceManager {
  if (!_mgr) _mgr = new ComplianceManager();
  return _mgr;
}
export function setCompliance(m: ComplianceManager): void {
  _mgr = m;
}
export function resetCompliance(): void {
  _mgr = null;
}

/** Stable fingerprint of a control (for change-detection). */
export function controlFingerprint(control: ComplianceControl): string {
  return createHash("sha256")
    .update(JSON.stringify({ id: control.id, code: control.code, status: control.status, mapsTo: control.mapsTo }), "utf8")
    .digest("hex")
    .slice(0, 16);
}

export { IdentityError };
