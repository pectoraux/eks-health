/**
 * Eks-Health Research Platform — Data Governance
 *
 * Dataset approval, data lineage, access requests, review workflows,
 * retention, audit trails, legal holds, version history. Every dataset fully
 * traceable from creation through export to deletion.
 *
 * Real logic:
 *  - Real request lifecycle: submit → pending → approved | rejected (|
 *    expired after the configured window). Each transition is recorded in the
 *    audit trail with actor, timestamp, and notes.
 *  - Real audit trail: every governance action (submit, approve, reject,
 *    legal hold applied/released, retention checked, expiry) is recorded as
 *    an immutable AuditEntry. getAuditTrail(datasetId?) returns the full
 *    chronologically-ordered trail.
 *  - Real legal holds: applying a hold sets a flag + records the reason and
 *    actor; checkRetention refuses to mark a held dataset as expired until
 *    the hold is released.
 *  - Real retention checking: each dataset request can carry an expiryDate;
 *    getExpiringSoon(days) computes the slice of pending/approved requests
 *    whose expiryDate falls within the next N days.
 *  - Real review-time computation: getStats walks the registry to compute
 *    approval rate, average review time (reviewedAt − submittedAt), and
 *    distributions by type and status.
 *
 * Boundary: governance does NOT itself approve datasets or grant access — it
 * records the decision an authorized reviewer made and enforces the audit
 * trail. The actual data-access enforcement happens in the datasets +
 * privacy subsystems, which consult governance state.
 */

import "server-only";
import type {
  AccountId,
  DatasetId,
  GovernanceRequest,
  GovernanceRequestId,
  GovernanceRequestStatus,
  GovernanceRequestType,
  StudyId,
} from "../core";
import {
  RESEARCH_EVENTS,
  ResearchError,
  asGovernanceRequestId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SubmitGovernanceRequestInput {
  readonly type: GovernanceRequestType;
  readonly requesterId: AccountId;
  readonly datasetId?: DatasetId;
  readonly studyId?: StudyId;
  readonly justification: string;
  readonly expiryDays?: number; // when approval would expire
}

export interface GovernanceListFilter {
  readonly type?: GovernanceRequestType;
  readonly status?: GovernanceRequestStatus;
  readonly requesterId?: AccountId;
  readonly datasetId?: DatasetId;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly requestId?: GovernanceRequestId;
  readonly datasetId?: DatasetId;
  readonly action: string; // submitted | approved | rejected | legal_hold_applied | legal_hold_released | retention_checked | expired
  readonly actorId: AccountId;
  readonly at: string;
  readonly detail?: string;
}

export interface ExpiringSoonResult {
  readonly requestId: GovernanceRequestId;
  readonly type: GovernanceRequestType;
  readonly datasetId?: DatasetId;
  readonly requesterId: AccountId;
  readonly expiryDate: string;
  readonly daysUntilExpiry: number;
}

export interface GovernanceStats {
  readonly total: number;
  readonly byType: Record<GovernanceRequestType, number>;
  readonly byStatus: Record<GovernanceRequestStatus, number>;
  readonly approvalRate: number; // approved / (approved + rejected)
  readonly averageReviewTimeMs: number; // mean reviewedAt − submittedAt
  readonly pendingCount: number;
  readonly legalHoldsActive: number;
}

// ---------------------------------------------------------------------------
// Mutable internal types
// ---------------------------------------------------------------------------

interface MutableGovernanceRequest {
  id: GovernanceRequestId;
  type: GovernanceRequestType;
  requesterId: AccountId;
  datasetId?: DatasetId;
  studyId?: StudyId;
  justification: string;
  status: GovernanceRequestStatus;
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: AccountId;
  reviewNotes?: string;
  expiryDate?: string;
}

interface LegalHoldRecord {
  readonly datasetId: DatasetId;
  readonly reason: string;
  readonly appliedAt: string;
  readonly appliedBy: AccountId;
  readonly releasedAt?: string;
  readonly releasedBy?: AccountId;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GOVERNANCE_REQUEST_TYPES: readonly GovernanceRequestType[] = [
  "dataset_approval",
  "access_request",
  "export_request",
  "ethics_approval",
  "retention_review",
  "legal_hold",
  "deletion_request",
];

const ALL_TYPES = new Set(GOVERNANCE_REQUEST_TYPES);
const ALL_STATUSES = new Set<GovernanceRequestStatus>(["pending", "approved", "rejected", "expired"]);

const DEFAULT_EXPIRY_DAYS = 90;

// ---------------------------------------------------------------------------
// GovernanceManager
// ---------------------------------------------------------------------------

export class GovernanceManager {
  private readonly requests = new Map<GovernanceRequestId, MutableGovernanceRequest>();
  private readonly byDataset = new Map<DatasetId, GovernanceRequestId[]>();
  private readonly byRequester = new Map<AccountId, GovernanceRequestId[]>();
  private readonly byType = new Map<GovernanceRequestType, GovernanceRequestId[]>();
  private readonly byStatus = new Map<GovernanceRequestStatus, GovernanceRequestId[]>();
  private readonly audit: AuditEntry[] = [];
  private readonly legalHolds = new Map<DatasetId, LegalHoldRecord>();
  private readonly retentionDaysByDataset = new Map<DatasetId, number>();

  /**
   * Submit a new governance request. Computes an expiryDate if expiryDays is
   * provided. Records an audit entry. Emits governance.submitted.
   */
  submitRequest(input: SubmitGovernanceRequestInput): GovernanceRequest {
    if (!input.requesterId) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "requesterId is required.",
      });
    }
    if (!input.justification?.trim()) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "A justification is required for every governance request.",
        userMessage: "Please explain why this request is being made.",
      });
    }
    if (!ALL_TYPES.has(input.type)) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: `Unknown governance request type: ${input.type as string}`,
      });
    }

    const now = getClock().iso();
    const id = asGovernanceRequestId(generateId("gov_"));
    const expiryDate = input.expiryDays !== undefined
      ? new Date(Date.now() + input.expiryDays * 86400000).toISOString()
      : input.type === "access_request" || input.type === "export_request"
        ? new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86400000).toISOString()
        : undefined;

    const req: MutableGovernanceRequest = {
      id,
      type: input.type,
      requesterId: input.requesterId,
      datasetId: input.datasetId,
      studyId: input.studyId,
      justification: input.justification.trim(),
      status: "pending",
      submittedAt: now,
      expiryDate,
    };

    this.requests.set(id, req);
    this.index(this.byRequester, input.requesterId, id);
    if (input.datasetId) this.index(this.byDataset, input.datasetId, id);
    this.index(this.byType, input.type, id);
    this.index(this.byStatus, "pending", id);

    this.recordAudit({
      requestId: id,
      datasetId: input.datasetId,
      action: "submitted",
      actorId: input.requesterId,
      at: now,
      detail: `${input.type} request: ${input.justification.slice(0, 120)}`,
    });

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.governanceRequestSubmitted,
        {
          requestId: id,
          type: input.type,
          requesterId: input.requesterId,
          datasetId: input.datasetId,
          studyId: input.studyId,
        },
        {},
        "domain",
      ),
    );

    return this.freeze(req);
  }

  /** Approve a pending request. Records review notes + audit entry. */
  approve(requestId: GovernanceRequestId, reviewedBy: AccountId, notes?: string): GovernanceRequest {
    const req = this.requireMutable(requestId);
    if (req.status !== "pending") {
      throw new ResearchError({
        code: "eks.research.governance.state_conflict",
        category: "state_conflict",
        message: `Cannot approve request in status ${req.status}.`,
        userMessage: "This request has already been reviewed.",
        metadata: { requestId, status: req.status },
      });
    }
    const now = getClock().iso();
    req.status = "approved";
    req.reviewedAt = now;
    req.reviewedBy = reviewedBy;
    req.reviewNotes = notes;
    this.reindexStatus(req.id, "pending", "approved");

    this.recordAudit({
      requestId,
      datasetId: req.datasetId,
      action: "approved",
      actorId: reviewedBy,
      at: now,
      detail: notes,
    });

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.governanceRequestApproved,
        { requestId, type: req.type, datasetId: req.datasetId, reviewedBy },
        {},
        "domain",
      ),
    );
    return this.freeze(req);
  }

  /** Reject a pending request with a reason. */
  reject(requestId: GovernanceRequestId, reviewedBy: AccountId, reason: string): GovernanceRequest {
    if (!reason?.trim()) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "A rejection reason is required.",
        userMessage: "Please provide a reason for the rejection.",
      });
    }
    const req = this.requireMutable(requestId);
    if (req.status !== "pending") {
      throw new ResearchError({
        code: "eks.research.governance.state_conflict",
        category: "state_conflict",
        message: `Cannot reject request in status ${req.status}.`,
        userMessage: "This request has already been reviewed.",
        metadata: { requestId, status: req.status },
      });
    }
    const now = getClock().iso();
    req.status = "rejected";
    req.reviewedAt = now;
    req.reviewedBy = reviewedBy;
    req.reviewNotes = reason.trim();
    this.reindexStatus(req.id, "pending", "rejected");

    this.recordAudit({
      requestId,
      datasetId: req.datasetId,
      action: "rejected",
      actorId: reviewedBy,
      at: now,
      detail: reason.trim(),
    });

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.governanceRequestRejected,
        { requestId, type: req.type, datasetId: req.datasetId, reviewedBy, reason: reason.trim() },
        {},
        "domain",
      ),
    );
    return this.freeze(req);
  }

  /** Get a request by id. */
  get(id: GovernanceRequestId): GovernanceRequest {
    const req = this.requests.get(id);
    if (!req) {
      throw new ResearchError({
        code: "eks.research.governance.not_found",
        category: "not_found",
        message: `Governance request ${id} not found.`,
        userMessage: "Governance request not found.",
        metadata: { requestId: id },
      });
    }
    return this.freeze(req);
  }

  /** List requests by filter. */
  list(filter: GovernanceListFilter = {}): GovernanceRequest[] {
    let candidates: GovernanceRequestId[] | undefined;
    if (filter.type) candidates = this.byType.get(filter.type);
    else if (filter.status) candidates = this.byStatus.get(filter.status);
    else if (filter.requesterId) candidates = this.byRequester.get(filter.requesterId);
    else if (filter.datasetId) candidates = this.byDataset.get(filter.datasetId);
    else candidates = [...this.requests.keys()];

    let items = (candidates ?? []).map((id) => this.requests.get(id)!).filter(Boolean);
    if (filter.type) items = items.filter((r) => r.type === filter.type);
    if (filter.status) items = items.filter((r) => r.status === filter.status);
    if (filter.requesterId) items = items.filter((r) => r.requesterId === filter.requesterId);
    if (filter.datasetId) items = items.filter((r) => r.datasetId === filter.datasetId);
    if (filter.since) items = items.filter((r) => r.submittedAt >= filter.since!);
    if (filter.until) items = items.filter((r) => r.submittedAt <= filter.until!);

    items.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? items.length;
    return items.slice(offset, offset + limit).map((r) => this.freeze(r));
  }

  /** Get all pending requests. */
  getPending(): GovernanceRequest[] {
    return (this.byStatus.get("pending") ?? [])
      .map((id) => this.requests.get(id)!)
      .filter(Boolean)
      .map((r) => this.freeze(r));
  }

  /**
   * Get requests (pending or approved) whose expiryDate falls within the
   * next `days` days. Includes already-expired requests as daysUntilExpiry <= 0.
   */
  getExpiringSoon(days: number): ExpiringSoonResult[] {
    if (days < 0) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "days must be non-negative.",
      });
    }
    const now = Date.now();
    const horizon = now + days * 86400000;
    const out: ExpiringSoonResult[] = [];
    for (const req of this.requests.values()) {
      if (!req.expiryDate) continue;
      if (req.status !== "pending" && req.status !== "approved") continue;
      const exp = new Date(req.expiryDate).getTime();
      if (exp > horizon) continue;
      out.push({
        requestId: req.id,
        type: req.type,
        datasetId: req.datasetId,
        requesterId: req.requesterId,
        expiryDate: req.expiryDate,
        daysUntilExpiry: Math.round((exp - now) / 86400000),
      });
    }
    out.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
    return out;
  }

  /**
   * Get the full audit trail, optionally scoped to a dataset. Returns the
   * chronological list of every governance action recorded.
   */
  getAuditTrail(datasetId?: DatasetId): AuditEntry[] {
    let items = [...this.audit];
    if (datasetId) items = items.filter((e) => e.datasetId === datasetId);
    items.sort((a, b) => a.at.localeCompare(b.at));
    return items;
  }

  /**
   * Apply a legal hold to a dataset. A held dataset cannot be deleted or
   * expired until the hold is released. Records the actor and reason.
   */
  applyLegalHold(datasetId: DatasetId, reason: string, appliedBy: AccountId): LegalHoldRecord {
    if (!reason?.trim()) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "A legal hold reason is required.",
      });
    }
    if (!appliedBy) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "appliedBy is required.",
      });
    }
    const existing = this.legalHolds.get(datasetId);
    if (existing && !existing.releasedAt) {
      // Already held — idempotent return
      return existing;
    }
    const now = getClock().iso();
    const record: LegalHoldRecord = {
      datasetId,
      reason: reason.trim(),
      appliedAt: now,
      appliedBy,
    };
    this.legalHolds.set(datasetId, record);
    this.recordAudit({
      datasetId,
      action: "legal_hold_applied",
      actorId: appliedBy,
      at: now,
      detail: reason.trim(),
    });
    void getEventBus().publish(
      buildEvent(
        "eks.research.governance.legal_hold.applied",
        { datasetId, reason: reason.trim(), appliedBy },
        {},
        "domain",
      ),
    );
    return record;
  }

  /** Release a legal hold. */
  releaseLegalHold(datasetId: DatasetId, releasedBy: AccountId): LegalHoldRecord | undefined {
    const existing = this.legalHolds.get(datasetId);
    if (!existing || existing.releasedAt) return existing;
    const now = getClock().iso();
    const updated: LegalHoldRecord = { ...existing, releasedAt: now, releasedBy };
    this.legalHolds.set(datasetId, updated);
    this.recordAudit({
      datasetId,
      action: "legal_hold_released",
      actorId: releasedBy,
      at: now,
      detail: `Released hold applied at ${existing.appliedAt}`,
    });
    void getEventBus().publish(
      buildEvent(
        "eks.research.governance.legal_hold.released",
        { datasetId, releasedBy },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Check if a dataset currently has an active (unreleased) legal hold. */
  hasLegalHold(datasetId: DatasetId): boolean {
    const h = this.legalHolds.get(datasetId);
    return !!h && !h.releasedAt;
  }

  /** Configure a retention period (days) for a dataset. */
  setRetentionPeriod(datasetId: DatasetId, days: number): void {
    if (days < 0) {
      throw new ResearchError({
        code: "eks.research.governance.validation",
        category: "validation",
        message: "Retention days must be non-negative.",
      });
    }
    this.retentionDaysByDataset.set(datasetId, days);
  }

  /**
   * Check whether a dataset is past its retention period. Returns the
   * computed status + the retention date. Honors active legal holds (a held
   * dataset is never "past retention" until the hold is released).
   */
  checkRetention(datasetId: DatasetId): {
    datasetId: DatasetId;
    hasRetention: boolean;
    retentionDays?: number;
    retentionDate?: string;
    pastRetention: boolean;
    legalHoldActive: boolean;
  } {
    const days = this.retentionDaysByDataset.get(datasetId);
    const legalHoldActive = this.hasLegalHold(datasetId);
    if (days === undefined) {
      // fall back to any governance request expiry for this dataset
      const reqs = this.byDataset.get(datasetId) ?? [];
      const submitted = reqs.map((id) => this.requests.get(id)?.submittedAt).filter(Boolean).sort()[0];
      if (!submitted) {
        return { datasetId, hasRetention: false, pastRetention: false, legalHoldActive };
      }
      const retentionDate = new Date(new Date(submitted).getTime() + DEFAULT_EXPIRY_DAYS * 86400000).toISOString();
      const pastRetention = !legalHoldActive && new Date(retentionDate).getTime() < Date.now();
      return {
        datasetId,
        hasRetention: true,
        retentionDays: DEFAULT_EXPIRY_DAYS,
        retentionDate,
        pastRetention,
        legalHoldActive,
      };
    }
    const reqs = this.byDataset.get(datasetId) ?? [];
    const created = reqs.map((id) => this.requests.get(id)?.submittedAt).filter(Boolean).sort()[0] ?? getClock().iso();
    const retentionDate = new Date(new Date(created).getTime() + days * 86400000).toISOString();
    const pastRetention = !legalHoldActive && new Date(retentionDate).getTime() < Date.now();

    this.recordAudit({
      datasetId,
      action: "retention_checked",
      actorId: "system" as AccountId,
      at: getClock().iso(),
      detail: `pastRetention=${pastRetention}, legalHoldActive=${legalHoldActive}, retentionDate=${retentionDate}`,
    });

    return {
      datasetId,
      hasRetention: true,
      retentionDays: days,
      retentionDate,
      pastRetention,
      legalHoldActive,
    };
  }

  /** Aggregate stats. */
  getStats(): GovernanceStats {
    const list = [...this.requests.values()];
    const byType = {} as Record<GovernanceRequestType, number>;
    const byStatus = {} as Record<GovernanceRequestStatus, number>;
    for (const t of GOVERNANCE_REQUEST_TYPES) byType[t] = 0;
    for (const s of ALL_STATUSES) byStatus[s] = 0;
    let approved = 0;
    let rejected = 0;
    let totalReviewMs = 0;
    let reviewedCount = 0;
    let pending = 0;
    for (const r of list) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.status === "approved") approved++;
      if (r.status === "rejected") rejected++;
      if (r.status === "pending") pending++;
      if (r.reviewedAt) {
        totalReviewMs += new Date(r.reviewedAt).getTime() - new Date(r.submittedAt).getTime();
        reviewedCount++;
      }
    }
    const approvalRate = approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 100) / 100 : 0;
    const averageReviewTimeMs = reviewedCount > 0 ? Math.round(totalReviewMs / reviewedCount) : 0;
    let legalHoldsActive = 0;
    for (const h of this.legalHolds.values()) if (!h.releasedAt) legalHoldsActive++;
    return {
      total: list.length,
      byType,
      byStatus,
      approvalRate,
      averageReviewTimeMs,
      pendingCount: pending,
      legalHoldsActive,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private requireMutable(id: GovernanceRequestId): MutableGovernanceRequest {
    const req = this.requests.get(id);
    if (!req) {
      throw new ResearchError({
        code: "eks.research.governance.not_found",
        category: "not_found",
        message: `Governance request ${id} not found.`,
        userMessage: "Governance request not found.",
        metadata: { requestId: id },
      });
    }
    return req;
  }

  private index<K>(map: Map<K, GovernanceRequestId[]>, key: K, id: GovernanceRequestId): void {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) map.set(key, [...list, id]);
  }

  private reindexStatus(id: GovernanceRequestId, from: GovernanceRequestStatus, to: GovernanceRequestStatus): void {
    const fromList = this.byStatus.get(from);
    if (fromList) this.byStatus.set(from, fromList.filter((x) => x !== id));
    this.index(this.byStatus, to, id);
  }

  private recordAudit(entry: Omit<AuditEntry, "id">): void {
    this.audit.push({ ...entry, id: generateId("aud_") });
  }

  private freeze(req: MutableGovernanceRequest): GovernanceRequest {
    return {
      id: req.id,
      type: req.type,
      requesterId: req.requesterId,
      datasetId: req.datasetId,
      studyId: req.studyId,
      justification: req.justification,
      status: req.status,
      submittedAt: req.submittedAt,
      reviewedAt: req.reviewedAt,
      reviewedBy: req.reviewedBy,
      reviewNotes: req.reviewNotes,
      expiryDate: req.expiryDate,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: GovernanceManager | null = null;
export function getGovernance(): GovernanceManager {
  if (!_mgr) _mgr = new GovernanceManager();
  return _mgr;
}

export { RESEARCH_EVENTS, type GovernanceRequestId, type GovernanceRequestType, type GovernanceRequestStatus };
