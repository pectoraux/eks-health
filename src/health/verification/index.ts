/**
 * Eks-Health Universal Health Data Platform — Verification Framework
 *
 * Measurements have verification states: pending, verified, rejected,
 * expired, disputed, superseded. Programs define verification workflows
 * (who can verify, whether auto-verification from trusted sources is
 * allowed, how long a verification stays valid). Technicians execute the
 * workflows; the platform enforces them with a real state machine.
 *
 * The VerificationManager is the single authority for verification state
 * transitions. It publishes the appropriate `eks.health.measurement.*`
 * event for every transition and updates the underlying measurement's
 * verificationState via the measurements store.
 */

import "server-only";

import type {
  AccountId,
  MeasurementId,
  SchemaId,
  SourceType,
  VerificationHistoryEntry,
  VerificationId,
  VerificationState,
} from "../core";
import {
  HealthError,
  HEALTH_EVENTS,
  asVerificationId,
} from "../core";
import type { VerificationWorkflow } from "../schemas";
import { getSchemas } from "../schemas";
import { getSources } from "../sources";
import { getMeasurements } from "../measurements";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  readonly id: VerificationId;
  readonly measurementId: MeasurementId;
  readonly schemaId: SchemaId;
  readonly currentState: VerificationState;
  readonly requestedAt: string;
  readonly requestedBy: AccountId;
  readonly workflow: VerificationWorkflow;
  readonly history: readonly VerificationHistoryEntry[];
  readonly expiresAt?: string;
  readonly assignedTo?: AccountId;
  readonly completedAt?: string;
  readonly completionReason?: string;
}

export type VerificationActionType =
  | "approve"
  | "reject"
  | "dispute"
  | "expire"
  | "request";

export interface VerificationAction {
  readonly type: VerificationActionType;
  readonly by: AccountId;
  readonly at: string;
  readonly fromState: VerificationState;
  readonly toState: VerificationState;
  readonly reason?: string;
}

export interface Verifier {
  readonly accountId: AccountId;
  readonly sourceTypes: readonly SourceType[];
  readonly canVerify: boolean;
}

export interface VerificationListFilter {
  readonly state?: VerificationState;
  readonly schemaId?: SchemaId;
  readonly assignedTo?: AccountId;
  readonly measurementId?: MeasurementId;
  readonly includeCompleted?: boolean;
}

// Local event types — extend HEALTH_EVENTS with the missing lifecycle events.
const VERIFICATION_EVENTS = {
  ...HEALTH_EVENTS,
  measurementDisputed: "eks.health.measurement.disputed",
  measurementExpired: "eks.health.measurement.expired",
  verificationRequested: "eks.health.verification.requested",
} as const;

// Allowed state transitions (real state machine).
const ALLOWED_TRANSITIONS: Record<VerificationState, readonly VerificationState[]> = {
  pending: ["verified", "rejected", "expired", "disputed"],
  verified: ["expired", "disputed"],
  rejected: ["disputed", "pending"],
  expired: ["pending"],
  disputed: ["verified", "rejected", "pending"],
  superseded: [],
};

// ---------------------------------------------------------------------------
// Verification manager
// ---------------------------------------------------------------------------

export class VerificationManager {
  private readonly requests = new Map<VerificationId, VerificationRequest>();
  private readonly byMeasurement = new Map<string, Set<VerificationId>>();
  private readonly bySchema = new Map<string, Set<VerificationId>>();
  private readonly byAssignee = new Map<string, Set<VerificationId>>();

  /**
   * Create a verification request for a measurement. If the schema's
   * workflow has `autoVerifyIfSource` and the measurement's source matches
   * one of those source types, the request is created in the "verified"
   * state and the measurement is updated immediately. Otherwise the
   * request is created in `workflow.initial` (typically "pending").
   */
  request(
    measurementId: MeasurementId,
    schemaId: SchemaId,
    requestedBy: AccountId,
  ): VerificationRequest {
    const schema = getSchemas().get(schemaId);
    if (!schema) {
      throw new HealthError({
        code: "eks.health.verification.schema_not_found",
        category: "not_found",
        message: `Schema ${schemaId} not found.`,
      });
    }

    const measurement = getMeasurements().get(measurementId);
    if (!measurement) {
      throw new HealthError({
        code: "eks.health.verification.measurement_not_found",
        category: "not_found",
        message: `Measurement ${measurementId} not found.`,
      });
    }

    const workflow = schema.verificationWorkflow;
    if (!workflow.required) {
      throw new HealthError({
        code: "eks.health.verification.not_required",
        category: "state_conflict",
        message: `Schema ${schema.slug} does not require verification.`,
      });
    }

    // Check for an existing PENDING request for the same measurement —
    // don't allow duplicate concurrent requests.
    const existing = this.getForMeasurement(measurementId);
    if (existing && existing.currentState === "pending") {
      throw new HealthError({
        code: "eks.health.verification.already_pending",
        category: "state_conflict",
        message: `Measurement ${measurementId} already has a pending verification request.`,
        userMessage: "This measurement is already awaiting verification.",
        metadata: { existingRequestId: existing.id },
      });
    }

    const now = getClock().iso();
    const id = asVerificationId(generateId("vrf_"));
    const expiresAt = workflow.expiryDays
      ? new Date(getClock().epochMs() + workflow.expiryDays * 86_400_000).toISOString()
      : undefined;

    // Resolve the source type to check auto-verify eligibility.
    const source = getSources().get(measurement.sourceId);
    const sourceType = source?.type;
    const autoVerify =
      workflow.autoVerifyIfSource &&
      sourceType &&
      workflow.autoVerifyIfSource.includes(sourceType);

    const initialState: VerificationState = autoVerify ? "verified" : workflow.initial;
    const history: VerificationHistoryEntry[] = [
      {
        state: "pending",
        at: now,
        by: requestedBy,
        reason: "Verification requested",
      },
    ];
    if (autoVerify) {
      history.push({
        state: "verified",
        at: now,
        by: requestedBy,
        reason: `Auto-verified from trusted source type: ${sourceType}`,
      });
    }

    const req: VerificationRequest = {
      id,
      measurementId,
      schemaId,
      currentState: initialState,
      requestedAt: now,
      requestedBy,
      workflow,
      history,
      expiresAt,
      completedAt: autoVerify ? now : undefined,
      completionReason: autoVerify ? "auto_verified" : undefined,
    };

    this.requests.set(id, req);
    this.index(byMeasurementKey(measurementId), id, this.byMeasurement);
    this.index(bySchemaKey(schemaId), id, this.bySchema);
    if (req.assignedTo) this.index(byAssigneeKey(req.assignedTo), id, this.byAssignee);

    // Update the measurement's verification state.
    getMeasurements().setVerificationState(measurementId, initialState, requestedBy);

    void getEventBus().publish(
      buildEvent(
        VERIFICATION_EVENTS.verificationRequested,
        {
          requestId: id,
          measurementId,
          schemaId,
          requestedBy,
          initialState,
          autoVerified: !!autoVerify,
        },
        {},
        "domain",
      ),
    );

    if (autoVerify) {
      void getEventBus().publish(
        buildEvent(
          HEALTH_EVENTS.measurementVerified,
          {
            measurementId,
            requestId: id,
            verifiedBy: requestedBy,
            reason: "auto_verified",
            sourceType,
          },
          {},
          "domain",
        ),
      );
    }

    return req;
  }

  /** Transition a request to "verified". */
  approve(requestId: VerificationId, by: AccountId): VerificationRequest {
    return this.transition(requestId, "approve", "verified", by);
  }

  /** Transition a request to "rejected". */
  reject(requestId: VerificationId, by: AccountId, reason: string): VerificationRequest {
    return this.transition(requestId, "reject", "rejected", by, reason);
  }

  /** Transition a request to "disputed". */
  dispute(requestId: VerificationId, by: AccountId, reason: string): VerificationRequest {
    return this.transition(requestId, "dispute", "disputed", by, reason);
  }

  /**
   * Expire a request. Only valid if the request's expiryAt has passed AND
   * the workflow defines an expiryDays. Called individually or by sweep().
   */
  expire(requestId: VerificationId): VerificationRequest | undefined {
    const req = this.requests.get(requestId);
    if (!req) return undefined;
    if (!req.expiresAt) return req;
    if (req.currentState === "expired") return req;
    if (req.currentState === "verified" || req.currentState === "rejected") {
      // Verified/rejected requests CAN still expire (verifications have a TTL).
      if (Date.parse(req.expiresAt) > getClock().epochMs()) return req;
    } else if (req.currentState === "pending" || req.currentState === "disputed") {
      if (Date.parse(req.expiresAt) > getClock().epochMs()) return req;
    } else {
      return req;
    }
    return this.transition(requestId, "expire", "expired", req.requestedBy, "verification_expired");
  }

  /** List requests matching a filter. */
  list(filter: VerificationListFilter = {}): readonly VerificationRequest[] {
    let list = [...this.requests.values()];
    if (filter.state) list = list.filter((r) => r.currentState === filter.state);
    if (filter.schemaId) list = list.filter((r) => r.schemaId === filter.schemaId);
    if (filter.measurementId) list = list.filter((r) => r.measurementId === filter.measurementId);
    if (filter.assignedTo) list = list.filter((r) => r.assignedTo === filter.assignedTo);
    if (!filter.includeCompleted) {
      list = list.filter((r) => r.currentState === "pending" || r.currentState === "disputed");
    }
    return list;
  }

  /** Get the most recent verification request for a measurement. */
  getForMeasurement(measurementId: MeasurementId): VerificationRequest | undefined {
    const ids = this.byMeasurement.get(byMeasurementKey(measurementId));
    if (!ids || ids.size === 0) return undefined;
    let latest: VerificationRequest | undefined;
    for (const id of ids) {
      const r = this.requests.get(id)!;
      if (!latest || Date.parse(r.requestedAt) > Date.parse(latest.requestedAt)) latest = r;
    }
    return latest;
  }

  /** Get a single request. */
  get(requestId: VerificationId): VerificationRequest | undefined {
    return this.requests.get(requestId);
  }

  /** Full verification history for a request. */
  getHistory(requestId: VerificationId): readonly VerificationHistoryEntry[] {
    const r = this.requests.get(requestId);
    return r ? [...r.history] : [];
  }

  /**
   * Sweep all requests and expire any whose expiryAt has passed. Returns the
   * number of requests expired. Designed to be called by the kernel
   * scheduler on a regular cadence (e.g. hourly).
   */
  sweep(): number {
    let expired = 0;
    for (const req of this.requests.values()) {
      if (!req.expiresAt) continue;
      if (req.currentState === "expired" || req.currentState === "superseded") continue;
      if (Date.parse(req.expiresAt) > getClock().epochMs()) continue;
      const updated = this.transition(req.id, "expire", "expired", req.requestedBy, "verification_expired");
      if (updated.currentState === "expired") expired++;
    }
    return expired;
  }

  /**
   * Check if an account is a valid verifier for this request's workflow.
   * Verifiers must be associated with a registered, verified source whose
   * type is in the workflow's `verifiedBy` list.
   */
  canVerify(requestId: VerificationId, accountId: AccountId): boolean {
    const req = this.requests.get(requestId);
    if (!req) return false;
    if (req.currentState !== "pending" && req.currentState !== "disputed") return false;
    if (req.workflow.verifiedBy.length === 0) return true; // anyone can verify
    // Look for any verified source of an allowed type that was verified by this account.
    const sources = getSources().list({ verifiedOnly: true });
    for (const source of sources) {
      if (!req.workflow.verifiedBy.includes(source.type)) continue;
      if (source.verifiedBy === accountId) return true;
    }
    return false;
  }

  /** Number of active verification requests. */
  size(): number {
    let n = 0;
    for (const r of this.requests.values()) {
      if (r.currentState === "pending" || r.currentState === "disputed") n++;
    }
    return n;
  }

  // ---------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------

  private transition(
    requestId: VerificationId,
    actionType: VerificationActionType,
    toState: VerificationState,
    by: AccountId,
    reason?: string,
  ): VerificationRequest {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new HealthError({
        code: "eks.health.verification.not_found",
        category: "not_found",
        message: `Verification request ${requestId} not found.`,
        userMessage: "This verification request does not exist.",
      });
    }
    const fromState = req.currentState;
    if (fromState === toState) {
      throw new HealthError({
        code: "eks.health.verification.already_in_state",
        category: "state_conflict",
        message: `Request ${requestId} is already in state ${toState}.`,
      });
    }
    const allowed = ALLOWED_TRANSITIONS[fromState];
    if (!allowed || !allowed.includes(toState)) {
      throw new HealthError({
        code: "eks.health.verification.invalid_transition",
        category: "state_conflict",
        message: `Cannot transition from ${fromState} to ${toState}.`,
        userMessage: "This verification state transition is not allowed.",
        metadata: { from: fromState, to: toState },
      });
    }

    // Dispute requires workflow permission.
    if (toState === "disputed" && !req.workflow.disputeAllowed) {
      throw new HealthError({
        code: "eks.health.verification.dispute_not_allowed",
        category: "state_conflict",
        message: `Workflow for schema ${req.schemaId} does not allow disputes.`,
      });
    }

    const now = getClock().iso();
    const entry: VerificationHistoryEntry = {
      state: toState,
      at: now,
      by,
      reason,
    };
    const isTerminal = toState === "verified" || toState === "rejected" || toState === "expired";
    const updated: VerificationRequest = {
      ...req,
      currentState: toState,
      history: [...req.history, entry],
      completedAt: isTerminal ? now : req.completedAt,
      completionReason: isTerminal ? (reason ?? actionType) : req.completionReason,
    };
    this.requests.set(requestId, updated);

    // Update the underlying measurement's verification state.
    getMeasurements().setVerificationState(req.measurementId, toState, by);

    // Emit the right event.
    const eventType = this.eventForTransition(toState);
    if (eventType) {
      void getEventBus().publish(
        buildEvent(
          eventType,
          {
            requestId,
            measurementId: req.measurementId,
            schemaId: req.schemaId,
            by,
            reason,
            fromState,
            toState,
          },
          {},
          "domain",
        ),
      );
    }

    return updated;
  }

  private eventForTransition(state: VerificationState): string | null {
    switch (state) {
      case "verified": return HEALTH_EVENTS.measurementVerified;
      case "rejected": return HEALTH_EVENTS.measurementRejected;
      case "disputed": return VERIFICATION_EVENTS.measurementDisputed;
      case "expired": return VERIFICATION_EVENTS.measurementExpired;
      default: return null;
    }
  }

  private index<K>(key: string, id: K, map: Map<string, Set<K>>): void {
    const set = map.get(key) ?? new Set<K>();
    set.add(id);
    map.set(key, set);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byMeasurementKey(id: MeasurementId): string {
  return `m:${id}`;
}
function bySchemaKey(id: SchemaId): string {
  return `s:${id}`;
}
function byAssigneeKey(id: AccountId): string {
  return `a:${id}`;
}

// ---------------------------------------------------------------------------
// Re-exports for the public API
// ---------------------------------------------------------------------------

export type { VerificationWorkflow } from "../schemas";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: VerificationManager | null = null;

export function getVerification(): VerificationManager {
  if (!_manager) _manager = new VerificationManager();
  return _manager;
}

export function setVerification(m: VerificationManager): void {
  _manager = m;
}

export function resetVerification(): void {
  _manager = null;
}
