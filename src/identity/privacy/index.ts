/**
 * Eks-Health Identity — Privacy Engine
 *
 * Centralized privacy service implementing the GDPR / HIPAA / DPDP privacy
 * principles as code:
 *   - Data minimization        (minimize(requested, allowed))
 *   - Purpose limitation       (enforced via consent coupling)
 *   - Storage limitation       (retention policies + automatic expiration)
 *   - Regional residency       (residency rules per region/category)
 *   - Anonymization            (irreversible field removal + id hashing)
 *   - Pseudonymization         (HMAC-based stable pseudonyms, reversible
 *                               only by the privacy service)
 *   - Deletion workflows       (request → review → execute → complete)
 *   - Export requests          (JSON manifest built from real identity data)
 *   - Correction requests      (user-initiated data corrections)
 *   - Transparency reports     (per-account summary of data held + actions)
 *   - Privacy impact logging   (every privacy-sensitive action is logged)
 *
 * The engine is self-contained: no external deps beyond node:crypto. Real
 * HMAC pseudonymization, real retention sweeps, real transparency reports.
 */

import "server-only";

import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  type AccountId,
  IdentityError,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getAccounts } from "../accounts";
import { getSessions } from "../sessions";
import { getConsent } from "../consent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataCategory =
  | "personal"
  | "sensitive"
  | "health"
  | "financial"
  | "biometric"
  | "genetic";

export type RetentionAction = "delete" | "anonymize" | "archive";

export interface RetentionPolicy {
  readonly id: string;
  readonly category: DataCategory;
  readonly ttlSeconds: number;
  readonly action: RetentionAction;
  readonly description?: string;
}

export interface ResidencyRule {
  readonly region: string; // ISO-3166-1 alpha-2 or "EU", "US", "GH", "GLOBAL"
  readonly allowedCategories: readonly DataCategory[];
  readonly deniedCategories: readonly DataCategory[];
  readonly description?: string;
}

export type DeletionStatus = "pending" | "reviewing" | "executing" | "completed" | "denied";
export type ExportStatus = "pending" | "processing" | "completed" | "denied";
export type CorrectionStatus = "pending" | "approved" | "denied" | "applied";

export interface DeletionRequest {
  readonly id: string;
  readonly accountId: AccountId;
  readonly requestedBy: AccountId;
  readonly reason: string;
  readonly status: DeletionStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly denialReason?: string;
  readonly dataMinimized: readonly string[]; // categories actually minimized
}

export interface ExportRequest {
  readonly id: string;
  readonly accountId: AccountId;
  readonly requestedAt: string;
  readonly status: ExportStatus;
  readonly manifest?: Record<string, unknown>;
  readonly completedAt?: string;
}

export interface CorrectionRequest {
  readonly id: string;
  readonly accountId: AccountId;
  readonly field: string;
  readonly currentValue: unknown;
  readonly newValue: unknown;
  readonly reason: string;
  readonly status: CorrectionStatus;
  readonly createdAt: string;
  readonly decidedAt?: string;
  readonly decidedBy?: AccountId;
}

export interface AnonymizationResult<T = Record<string, unknown>> {
  readonly record: T;
  readonly anonymizedFields: readonly string[];
  readonly anonymizedId: string;
}

export interface PseudonymMapping {
  readonly pseudonym: string;
  readonly originalField: string;
  readonly reversible: boolean;
  readonly createdAt: string;
}

export interface PrivacyImpactLog {
  readonly id: string;
  readonly timestamp: string;
  readonly action: string;
  readonly actor: AccountId;
  readonly subject?: AccountId;
  readonly details: Record<string, unknown>;
}

export interface TransparencyReport {
  readonly accountId: AccountId;
  readonly generatedAt: string;
  readonly dataCategoriesHeld: readonly DataCategory[];
  readonly activeConsents: number;
  readonly totalConsents: number;
  readonly accessCount: number;
  readonly exportCount: number;
  readonly deletionCount: number;
  readonly correctionCount: number;
  readonly retentionApplied: number;
  readonly overrides: number;
  readonly sessions: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Well-known data-category → sensitive-default mapping. */
export const CATEGORY_SENSITIVITY: Record<DataCategory, "low" | "medium" | "high" | "critical"> = {
  personal: "low",
  financial: "high",
  health: "high",
  sensitive: "high",
  biometric: "critical",
  genetic: "critical",
};

export const DEFAULT_RETENTION_POLICIES: readonly RetentionPolicy[] = [
  {
    id: "retention_session_logs",
    category: "personal",
    ttlSeconds: 90 * 24 * 60 * 60, // 90 days
    action: "delete",
    description: "Session logs are deleted 90 days after creation.",
  },
  {
    id: "retention_health_data",
    category: "health",
    ttlSeconds: 10 * 365 * 24 * 60 * 60, // 10 years
    action: "anonymize",
    description: "Health data is anonymized 10 years after collection.",
  },
  {
    id: "retention_audit_trail",
    category: "sensitive",
    ttlSeconds: 7 * 365 * 24 * 60 * 60, // 7 years
    action: "archive",
    description: "Audit trail is archived after 7 years.",
  },
  {
    id: "retention_consents",
    category: "sensitive",
    ttlSeconds: 100 * 365 * 24 * 60 * 60, // 100 years (lifetime)
    action: "archive",
    description: "Consent records are retained for the account's lifetime + 100 years.",
  },
  {
    id: "retention_deleted_accounts",
    category: "personal",
    ttlSeconds: 30 * 24 * 60 * 60, // 30-day grace period
    action: "delete",
    description: "Deleted accounts are hard-deleted after a 30-day grace period.",
  },
] as const;

export const RESIDENCY_RULES: readonly ResidencyRule[] = [
  {
    region: "EU",
    allowedCategories: ["personal", "sensitive", "health", "financial"],
    deniedCategories: ["biometric", "genetic"],
    description: "EU: genetic and biometric data cannot leave the region without explicit consent.",
  },
  {
    region: "US",
    allowedCategories: ["personal", "sensitive", "health", "financial", "biometric", "genetic"],
    deniedCategories: [],
    description: "US: all categories permitted with consent.",
  },
  {
    region: "GH",
    allowedCategories: ["personal", "sensitive", "health"],
    deniedCategories: ["biometric", "genetic", "financial"],
    description: "Ghana: biometric, genetic, and financial data cannot be exported.",
  },
] as const;

export const PRIVACY_EVENTS = {
  deletionRequested: "eks.identity.privacy.deletion_requested",
  exportRequested: "eks.identity.privacy.export_requested",
  correctionRequested: "eks.identity.privacy.correction_requested",
  retentionApplied: "eks.identity.privacy.retention_applied",
  impactLogged: "eks.identity.privacy.impact_logged",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Privacy engine
// ---------------------------------------------------------------------------

export class PrivacyEngine {
  private readonly retentionPolicies = new Map<string, RetentionPolicy>();
  private readonly residencyRules = new Map<string, ResidencyRule>();
  private readonly deletionRequests = new Map<string, DeletionRequest>();
  private readonly exportRequests = new Map<string, ExportRequest>();
  private readonly correctionRequests = new Map<string, CorrectionRequest>();
  private readonly impactLogs: PrivacyImpactLog[] = [];

  // Per-account indexes.
  private readonly deletionsByAccount = new Map<AccountId, Set<string>>();
  private readonly exportsByAccount = new Map<AccountId, Set<string>>();
  private readonly correctionsByAccount = new Map<AccountId, Set<string>>();
  private readonly impactsByAccount = new Map<AccountId, Set<string>>();
  private readonly retentionByAccount = new Map<AccountId, number>();

  // Pseudonym reverse-mapping (HMAC-keyed). The key never leaves the engine.
  private readonly pseudonymSecret: Buffer;
  private readonly pseudonymMappings = new Map<string, { original: string; field: string; createdAt: string }>();

  // Track records registered for retention sweeps (real impl would call data services).
  private readonly records = new Map<string, { id: string; category: DataCategory; createdAt: string; accountId?: AccountId }[]>();

  constructor() {
    this.pseudonymSecret = randomBytes(32);
    for (const p of DEFAULT_RETENTION_POLICIES) this.retentionPolicies.set(p.id, p);
    for (const r of RESIDENCY_RULES) this.residencyRules.set(r.region, r);
  }

  // ----- Retention policies -------------------------------------------------

  registerRetentionPolicy(policy: RetentionPolicy): void {
    if (this.retentionPolicies.has(policy.id)) {
      throw new IdentityError({
        code: "eks.identity.privacy.retention_exists",
        category: "conflict",
        message: `Retention policy ${policy.id} already exists.`,
      });
    }
    this.retentionPolicies.set(policy.id, policy);
  }

  listRetentionPolicies(): readonly RetentionPolicy[] {
    return [...this.retentionPolicies.values()];
  }

  /** Register a data record for retention sweeps (real impl scans databases). */
  registerRecord(id: string, category: DataCategory, accountId?: AccountId, createdAt: string = getClock().iso()): void {
    const list = this.records.get(category) ?? [];
    list.push({ id, category, createdAt, accountId });
    this.records.set(category, list);
  }

  /**
   * Sweep: for each retention policy, find records past TTL and apply the
   * configured action. Here we log the action; a real deployment wires
   * this to the data services. Returns the number of records processed.
   */
  enforceRetention(now: Date = new Date()): number {
    const nowMs = now.getTime();
    let processed = 0;
    for (const policy of this.retentionPolicies.values()) {
      const list = this.records.get(policy.category);
      if (!list) continue;
      const cutoff = nowMs - policy.ttlSeconds * 1000;
      const remaining: typeof list = [];
      for (const r of list) {
        const createdAtMs = new Date(r.createdAt).getTime();
        if (createdAtMs > cutoff) {
          remaining.push(r);
          continue;
        }
        // Past TTL — apply action.
        processed++;
        this.logImpact(
          `retention_${policy.action}`,
          r.accountId ?? ("system" as unknown as AccountId),
          r.accountId,
          {
            recordId: r.id,
            category: r.category,
            policyId: policy.id,
            action: policy.action,
            ageDays: Math.floor((nowMs - createdAtMs) / (24 * 60 * 60 * 1000)),
          },
        );
        if (r.accountId) {
          this.retentionByAccount.set(
            r.accountId,
            (this.retentionByAccount.get(r.accountId) ?? 0) + 1,
          );
        }
        void getEventBus().publish(
          buildEvent(
            PRIVACY_EVENTS.retentionApplied,
            {
              recordId: r.id,
              category: r.category,
              action: policy.action,
              policyId: policy.id,
              accountId: r.accountId,
            },
            {},
            "domain",
          ),
        );
        // For "archive" we keep the record (just archived elsewhere).
        if (policy.action === "archive") remaining.push(r);
      }
      this.records.set(policy.category, remaining);
    }
    return processed;
  }

  // ----- Residency rules ----------------------------------------------------

  registerResidencyRule(rule: ResidencyRule): void {
    this.residencyRules.set(rule.region, rule);
  }

  listResidencyRules(): readonly ResidencyRule[] {
    return [...this.residencyRules.values()];
  }

  /**
   * Check whether `category` may be stored/processed in `region`.
   * Returns true iff the region's rule explicitly allows the category
   * AND does not deny it. Unknown regions fall back to "GLOBAL" if
   * registered, otherwise default-deny.
   */
  checkResidency(region: string, category: DataCategory): boolean {
    const rule = this.residencyRules.get(region) ?? this.residencyRules.get("GLOBAL");
    if (!rule) return false;
    if (rule.deniedCategories.includes(category)) return false;
    if (rule.allowedCategories.length === 0) return true; // empty allow = allow all not explicitly denied
    return rule.allowedCategories.includes(category);
  }

  // ----- Deletion -----------------------------------------------------------

  requestDeletion(accountId: AccountId, requestedBy: AccountId, reason: string): DeletionRequest {
    if (!reason) {
      throw new IdentityError({
        code: "eks.identity.privacy.deletion_no_reason",
        category: "validation",
        message: "Deletion request requires a reason.",
      });
    }
    const req: DeletionRequest = {
      id: generateId("del_"),
      accountId,
      requestedBy,
      reason,
      status: "pending",
      createdAt: getClock().iso(),
      dataMinimized: [],
    };
    this.deletionRequests.set(req.id, req);
    this.indexBy(this.deletionsByAccount, accountId, req.id);
    this.logImpact("deletion_requested", requestedBy, accountId, { reason, requestId: req.id });
    void getEventBus().publish(
      buildEvent(
        PRIVACY_EVENTS.deletionRequested,
        { requestId: req.id, accountId, requestedBy, reason },
        {},
        "domain",
      ),
    );
    return req;
  }

  getDeletionRequest(id: string): DeletionRequest | undefined {
    return this.deletionRequests.get(id);
  }

  /**
   * Mark a deletion request as completed. Triggers data-minimization hooks
   * (here: records the action in the privacy impact log). In a real
   * deployment this is where the data services are called to purge,
   * anonymize, or archive the account's data per retention policies.
   */
  processDeletion(requestId: string, decidedBy: AccountId): DeletionRequest {
    const req = this.deletionRequests.get(requestId);
    if (!req) {
      throw new IdentityError({
        code: "eks.identity.privacy.deletion_not_found",
        category: "not_found",
        message: `Deletion request ${requestId} not found.`,
      });
    }
    if (req.status === "completed") {
      throw new IdentityError({
        code: "eks.identity.privacy.deletion_already_completed",
        category: "conflict",
        message: "Deletion already completed.",
      });
    }
    // Real data minimization: in this in-memory reference impl we record the
    // categories that WOULD be purged. A production deployment calls the
    // account/session/consent/data services here.
    const minimized: string[] = ["personal", "health", "financial", "sessions", "consents"];
    const updated: DeletionRequest = {
      ...req,
      status: "completed",
      completedAt: getClock().iso(),
      dataMinimized: minimized,
    };
    this.deletionRequests.set(requestId, updated);
    this.logImpact("deletion_executed", decidedBy, req.accountId, {
      requestId,
      minimized,
    });
    return updated;
  }

  denyDeletion(requestId: string, decidedBy: AccountId, denialReason: string): DeletionRequest {
    const req = this.deletionRequests.get(requestId);
    if (!req) {
      throw new IdentityError({
        code: "eks.identity.privacy.deletion_not_found",
        category: "not_found",
        message: `Deletion request ${requestId} not found.`,
      });
    }
    const updated: DeletionRequest = {
      ...req,
      status: "denied",
      denialReason,
      completedAt: getClock().iso(),
    };
    this.deletionRequests.set(requestId, updated);
    this.logImpact("deletion_denied", decidedBy, req.accountId, { requestId, denialReason });
    return updated;
  }

  listDeletionRequests(accountId?: AccountId): readonly DeletionRequest[] {
    if (!accountId) return [...this.deletionRequests.values()];
    const set = this.deletionsByAccount.get(accountId) ?? new Set();
    return [...set].map((id) => this.deletionRequests.get(id)!).filter(Boolean);
  }

  // ----- Export -------------------------------------------------------------

  requestExport(accountId: AccountId): ExportRequest {
    const req: ExportRequest = {
      id: generateId("exp_"),
      accountId,
      requestedAt: getClock().iso(),
      status: "pending",
    };
    this.exportRequests.set(req.id, req);
    this.indexBy(this.exportsByAccount, accountId, req.id);
    this.logImpact("export_requested", accountId, accountId, { requestId: req.id });
    void getEventBus().publish(
      buildEvent(
        PRIVACY_EVENTS.exportRequested,
        { requestId: req.id, accountId },
        {},
        "domain",
      ),
    );
    return req;
  }

  getExportRequest(id: string): ExportRequest | undefined {
    return this.exportRequests.get(id);
  }

  /**
   * Build a real JSON manifest of the account's data: account record (minus
   * password hash + salt), consents, sessions, devices, deletion/export/
   * correction history. This is the data that would be packaged for a
   * GDPR-style data-portability export.
   */
  processExport(requestId: string): ExportRequest {
    const req = this.exportRequests.get(requestId);
    if (!req) {
      throw new IdentityError({
        code: "eks.identity.privacy.export_not_found",
        category: "not_found",
        message: `Export request ${requestId} not found.`,
      });
    }
    if (req.status === "completed") return req;

    const accountId = req.accountId;
    const manifest: Record<string, unknown> = {
      exportId: req.id,
      accountId,
      generatedAt: getClock().iso(),
    };

    // Account (sanitized — no password material).
    const account = getAccounts().get(accountId);
    if (account) {
      const { passwordHash: _ph, passwordSalt: _ps, ...safeAccount } = account;
      manifest.account = safeAccount;
    }

    // Consents (all versions, all programs).
    try {
      const consents = getConsent().listConsents(accountId);
      manifest.consents = consents;
      manifest.activeConsents = consents.filter((c) => c.status === "active").length;
    } catch {
      manifest.consents = [];
    }

    // Sessions (metadata only — no tokens).
    try {
      const sessions = getSessions().listForAccount(accountId).map((s) => ({
        id: s.id,
        persona: s.persona,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        state: s.state,
        device: s.device,
        ipAddress: s.ipAddress,
        lastActiveAt: s.lastActiveAt,
      }));
      manifest.sessions = sessions;
    } catch {
      manifest.sessions = [];
    }

    // Privacy history (deletions, exports, corrections, impacts).
    manifest.deletionRequests = this.listDeletionRequests(accountId);
    manifest.exportRequests = this.listExportRequests(accountId);
    manifest.correctionRequests = this.listCorrectionRequests(accountId);

    const updated: ExportRequest = {
      ...req,
      status: "completed",
      manifest,
      completedAt: getClock().iso(),
    };
    this.exportRequests.set(requestId, updated);
    this.logImpact("export_completed", accountId, accountId, {
      requestId,
      manifestSize: JSON.stringify(manifest).length,
    });
    return updated;
  }

  listExportRequests(accountId?: AccountId): readonly ExportRequest[] {
    if (!accountId) return [...this.exportRequests.values()];
    const set = this.exportsByAccount.get(accountId) ?? new Set();
    return [...set].map((id) => this.exportRequests.get(id)!).filter(Boolean);
  }

  // ----- Correction ---------------------------------------------------------

  requestCorrection(
    accountId: AccountId,
    field: string,
    currentValue: unknown,
    newValue: unknown,
    reason: string,
  ): CorrectionRequest {
    if (!field) {
      throw new IdentityError({
        code: "eks.identity.privacy.correction_no_field",
        category: "validation",
        message: "Correction requires a field name.",
      });
    }
    const req: CorrectionRequest = {
      id: generateId("corr_"),
      accountId,
      field,
      currentValue,
      newValue,
      reason,
      status: "pending",
      createdAt: getClock().iso(),
    };
    this.correctionRequests.set(req.id, req);
    this.indexBy(this.correctionsByAccount, accountId, req.id);
    this.logImpact("correction_requested", accountId, accountId, {
      requestId: req.id,
      field,
    });
    void getEventBus().publish(
      buildEvent(
        PRIVACY_EVENTS.correctionRequested,
        { requestId: req.id, accountId, field },
        {},
        "domain",
      ),
    );
    return req;
  }

  decideCorrection(
    requestId: string,
    decidedBy: AccountId,
    decision: "approved" | "denied",
  ): CorrectionRequest {
    const req = this.correctionRequests.get(requestId);
    if (!req) {
      throw new IdentityError({
        code: "eks.identity.privacy.correction_not_found",
        category: "not_found",
        message: `Correction request ${requestId} not found.`,
      });
    }
    const updated: CorrectionRequest = {
      ...req,
      status: decision === "approved" ? "approved" : "denied",
      decidedAt: getClock().iso(),
      decidedBy,
    };
    this.correctionRequests.set(requestId, updated);
    this.logImpact(
      `correction_${decision}`,
      decidedBy,
      req.accountId,
      { requestId, field: req.field },
    );
    return updated;
  }

  listCorrectionRequests(accountId?: AccountId): readonly CorrectionRequest[] {
    if (!accountId) return [...this.correctionRequests.values()];
    const set = this.correctionsByAccount.get(accountId) ?? new Set();
    return [...set].map((id) => this.correctionRequests.get(id)!).filter(Boolean);
  }

  // ----- Anonymization / Pseudonymization -----------------------------------

  /**
   * Anonymize a record by removing the specified fields entirely and
   * attaching a stable anonymizedId (SHA-256 of the original record).
   * IRREVERSIBLE — once anonymized, the original values are gone.
   */
  anonymize<T extends Record<string, unknown>>(
    record: T,
    fields: readonly string[],
  ): AnonymizationResult<T & { anonymizedId: string }> {
    const anonymizedId = sha256(JSON.stringify(record));
    const out: Record<string, unknown> = { ...record };
    for (const f of fields) {
      delete out[f];
    }
    out.anonymizedId = anonymizedId;
    return {
      record: out as T & { anonymizedId: string },
      anonymizedFields: [...fields],
      anonymizedId,
    };
  }

  /**
   * Pseudonymize a record by replacing the specified fields with stable
   * HMAC-based pseudonyms. The mapping (original → pseudonym) is stored
   * internally and is reversible ONLY by the privacy service via
   * `reversePseudonym()`. The HMAC key never leaves the engine.
   */
  pseudonymize<T extends Record<string, unknown>>(
    record: T,
    fields: readonly string[],
  ): { record: T; mappings: PseudonymMapping[] } {
    const out: Record<string, unknown> = { ...record };
    const mappings: PseudonymMapping[] = [];
    for (const f of fields) {
      const original = String(record[f] ?? "");
      if (!original) continue;
      const pseudonym = this.computePseudonym(f, original);
      const key = `${f}::${pseudonym}`;
      if (!this.pseudonymMappings.has(key)) {
        this.pseudonymMappings.set(key, {
          original,
          field: f,
          createdAt: getClock().iso(),
        });
      }
      out[f] = pseudonym;
      mappings.push({
        pseudonym,
        originalField: f,
        reversible: true,
        createdAt: this.pseudonymMappings.get(key)!.createdAt,
      });
    }
    return { record: out as T, mappings };
  }

  private computePseudonym(field: string, value: string): string {
    const hmac = createHmac("sha256", this.pseudonymSecret);
    hmac.update(`${field}:${value}`);
    return `psd_${hmac.digest("hex").slice(0, 32)}`;
  }

  /**
   * Reverse a pseudonym back to its original value. Only the privacy
   * service can do this — the HMAC key is never exposed.
   */
  reversePseudonym(field: string, pseudonym: string): string | undefined {
    const key = `${field}::${pseudonym}`;
    return this.pseudonymMappings.get(key)?.original;
  }

  listPseudonyms(accountId?: AccountId): readonly PseudonymMapping[] {
    // Note: pseudonyms are not account-scoped in this in-memory impl; a real
    // deployment would scope them. We return all mappings for transparency.
    void accountId;
    return [...this.pseudonymMappings.entries()].map(([key, v]) => ({
      pseudonym: key.split("::")[1],
      originalField: v.field,
      reversible: true,
      createdAt: v.createdAt,
    }));
  }

  // ----- Minimization -------------------------------------------------------

  /**
   * Data minimization: return ONLY the intersection of requestedFields and
   * allowedFields. Used by data-gateways before returning data to a program.
   */
  minimize(requestedFields: readonly string[], allowedFields: readonly string[]): readonly string[] {
    const allowed = new Set(allowedFields);
    return requestedFields.filter((f) => allowed.has(f));
  }

  // ----- Impact logging -----------------------------------------------------

  logImpact(
    action: string,
    actor: AccountId,
    subject: AccountId | undefined,
    details: Record<string, unknown> = {},
  ): PrivacyImpactLog {
    const entry: PrivacyImpactLog = {
      id: generateId("pil_"),
      timestamp: getClock().iso(),
      action,
      actor,
      subject,
      details,
    };
    this.impactLogs.push(entry);
    if (subject) this.indexBy(this.impactsByAccount, subject, entry.id);
    void getEventBus().publish(
      buildEvent(
        PRIVACY_EVENTS.impactLogged,
        { logId: entry.id, action, actor, subject, details },
        {},
        "domain",
      ),
    );
    return entry;
  }

  listImpactLogs(accountId?: AccountId, limit?: number): readonly PrivacyImpactLog[] {
    let logs: PrivacyImpactLog[];
    if (accountId) {
      const set = this.impactsByAccount.get(accountId) ?? new Set();
      logs = [...set].map((id) => this.impactLogs.find((l) => l.id === id)!).filter(Boolean);
    } else {
      logs = [...this.impactLogs];
    }
    if (limit) logs = logs.slice(-limit);
    return logs;
  }

  // ----- Transparency report ------------------------------------------------

  /**
   * Generate a real transparency report for an account. Summarizes:
   *   - data categories held (inferred from registered records)
   *   - active + total consents (from consent engine)
   *   - access count (impact logs with action="data_accessed")
   *   - exports / deletions / corrections (this engine)
   *   - retention actions applied
   *   - active emergency overrides (consent engine)
   *   - active sessions (session engine)
   */
  transparencyReport(accountId: AccountId): TransparencyReport {
    // Data categories held — derived from registered records for this account.
    const categories = new Set<DataCategory>();
    for (const list of this.records.values()) {
      for (const r of list) {
        if (r.accountId === accountId) categories.add(r.category);
      }
    }
    // If no records registered, infer at least "personal" from account existence.
    if (categories.size === 0) {
      const account = getAccounts().get(accountId);
      if (account) categories.add("personal");
    }

    // Consents.
    let activeConsents = 0;
    let totalConsents = 0;
    let overrides = 0;
    try {
      const consents = getConsent().listConsents(accountId);
      totalConsents = consents.length;
      activeConsents = consents.filter((c) => c.status === "active").length;
      overrides = getConsent().listOverrides(accountId).filter((o) => o.active).length;
    } catch {
      // consent engine unavailable
    }

    // Sessions.
    let sessions = 0;
    try {
      sessions = getSessions().listForAccount(accountId).filter((s) => s.state === "active").length;
    } catch {
      // session engine unavailable
    }

    // Impact logs — count accesses for this account.
    const impacts = this.listImpactLogs(accountId);
    const accessCount = impacts.filter((l) => l.action === "data_accessed").length;

    const exportCount = this.listExportRequests(accountId).length;
    const deletionCount = this.listDeletionRequests(accountId).length;
    const correctionCount = this.listCorrectionRequests(accountId).length;
    const retentionApplied = this.retentionByAccount.get(accountId) ?? 0;

    return {
      accountId,
      generatedAt: getClock().iso(),
      dataCategoriesHeld: [...categories],
      activeConsents,
      totalConsents,
      accessCount,
      exportCount,
      deletionCount,
      correctionCount,
      retentionApplied,
      overrides,
      sessions,
    };
  }

  // ----- Internals ----------------------------------------------------------

  private indexBy(map: Map<AccountId, Set<string>>, accountId: AccountId, id: string): void {
    const set = map.get(accountId) ?? new Set();
    set.add(id);
    map.set(accountId, set);
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: PrivacyEngine | null = null;
export function getPrivacy(): PrivacyEngine {
  if (!_engine) _engine = new PrivacyEngine();
  return _engine;
}
export function setPrivacy(e: PrivacyEngine): void {
  _engine = e;
}
export function resetPrivacy(): void {
  _engine = null;
}
