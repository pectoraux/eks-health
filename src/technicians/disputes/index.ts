/**
 * Eks-Health Technician Network — Dispute Resolution
 *
 * Participants dispute measurements; technicians respond; programs review;
 * independent reviewers may be escalated; appeals and final decisions are
 * tracked. Disputed measurements do not silently disappear — every state
 * transition is recorded in an immutable timeline.
 *
 * Real state machine (only valid transitions), real timeline tracking, real
 * stats aggregation. No mocks.
 */

import "server-only";
import {
  type DisputeId,
  type DisputeStatus,
  type DisputeReason,
  type MeasurementId,
  type SessionId,
  type AccountId,
  type TechnicianId,
  type ProgramId,
  type EvidenceId,
  TechnicianError,
  asDisputeId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { TECHNICIAN_EVENTS } from "../core";

// ---------------------------------------------------------------------------
// Dispute types
// ---------------------------------------------------------------------------

export type DisputeResponseRole = "technician" | "participant" | "program" | "reviewer";

export interface DisputeResponse {
  readonly from: AccountId;
  readonly role: DisputeResponseRole;
  readonly message: string;
  readonly evidenceIds: EvidenceId[];
  readonly at: string;
}

export type DisputeReviewRole = "program" | "independent";
export type DisputeReviewRecommendation = "uphold" | "overturn" | "needs_info";

export interface DisputeReview {
  readonly reviewerId: AccountId;
  readonly role: DisputeReviewRole;
  readonly recommendation: DisputeReviewRecommendation;
  readonly rationale: string;
  readonly at: string;
}

export type DisputeDecisionOutcome = "upheld" | "overturned";

export interface DisputeDecision {
  readonly decision: DisputeDecisionOutcome;
  readonly decidedBy: AccountId;
  readonly rationale: string;
  readonly decidedAt: string;
  readonly final: boolean;
}

export type DisputeTimelineEntryType =
  | "opened"
  | "response"
  | "evidence_added"
  | "submitted_for_review"
  | "review"
  | "appealed"
  | "decision"
  | "closed";

export interface DisputeTimelineEntry {
  readonly at: string;
  readonly type: DisputeTimelineEntryType;
  readonly actor: AccountId;
  readonly fromStatus?: DisputeStatus;
  readonly toStatus: DisputeStatus;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

export interface Dispute {
  readonly id: DisputeId;
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
  readonly disputedBy: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId?: ProgramId;
  readonly reason: DisputeReason;
  readonly description: string;
  readonly status: DisputeStatus;
  readonly openedAt: string;
  readonly evidenceIds: EvidenceId[];
  readonly responses: DisputeResponse[];
  readonly reviews: DisputeReview[];
  readonly decision?: DisputeDecision;
  readonly resolvedAt?: string;
  readonly closedAt?: string;
  readonly timeline: DisputeTimelineEntry[];
}

export interface OpenDisputeInput {
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
  readonly disputedBy: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId?: ProgramId;
  readonly reason: DisputeReason;
  readonly description: string;
  readonly evidenceIds?: EvidenceId[];
}

export interface ListDisputesFilter {
  readonly status?: DisputeStatus;
  readonly technicianId?: TechnicianId;
  readonly programId?: ProgramId;
  readonly reason?: DisputeReason;
  readonly measurementId?: MeasurementId;
  readonly sessionId?: SessionId;
  readonly disputedBy?: AccountId;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Valid transitions. Keyed by current status, value = set of allowed next
 * statuses. The `resolve()` transition produces either `resolved_upheld` or
 * `resolved_overturned`.
 */
const VALID_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  opened: ["technician_responded"],
  technician_responded: ["evidence_review", "program_review", "appealed"],
  evidence_review: ["independent_review", "resolved_upheld", "resolved_overturned", "appealed"],
  program_review: ["independent_review", "resolved_upheld", "resolved_overturned", "appealed"],
  independent_review: ["resolved_upheld", "resolved_overturned", "appealed"],
  appealed: ["resolved_upheld", "resolved_overturned"],
  resolved_upheld: ["closed"],
  resolved_overturned: ["closed"],
  closed: [],
};

function assertTransition(from: DisputeStatus, to: DisputeStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new TechnicianError({
      code: "eks.technician.dispute.invalid_transition",
      category: "state_conflict",
      message: `Dispute cannot transition from "${from}" to "${to}".`,
      userMessage: "This dispute action is not allowed at its current stage.",
      metadata: { from, to, allowed },
    });
  }
}

// ---------------------------------------------------------------------------
// Dispute manager
// ---------------------------------------------------------------------------

export class DisputeManager {
  private readonly disputes = new Map<DisputeId, Dispute>();
  private readonly byTechnician = new Map<TechnicianId, DisputeId[]>();
  private readonly byProgram = new Map<ProgramId, DisputeId[]>();
  private readonly byMeasurement = new Map<MeasurementId, DisputeId[]>();
  private readonly bySession = new Map<SessionId, DisputeId[]>();

  open(input: OpenDisputeInput): Dispute {
    if (!input.description || input.description.trim().length === 0) {
      throw new TechnicianError({
        code: "eks.technician.dispute.empty_description",
        category: "validation",
        message: "Dispute description is required.",
        userMessage: "Please describe the dispute.",
      });
    }
    if (!input.measurementId && !input.sessionId) {
      throw new TechnicianError({
        code: "eks.technician.dispute.no_subject",
        category: "validation",
        message: "Dispute must reference a measurementId or sessionId.",
        userMessage: "A dispute must reference a measurement or session.",
      });
    }
    const now = getClock().iso();
    const id = asDisputeId(generateId("dsp_"));
    const dispute: Dispute = {
      id,
      measurementId: input.measurementId,
      sessionId: input.sessionId,
      disputedBy: input.disputedBy,
      technicianId: input.technicianId,
      programId: input.programId,
      reason: input.reason,
      description: input.description,
      status: "opened",
      openedAt: now,
      evidenceIds: input.evidenceIds ?? [],
      responses: [],
      reviews: [],
      timeline: [
        {
          at: now,
          type: "opened",
          actor: input.disputedBy,
          toStatus: "opened",
          message: `Dispute opened: ${input.reason}`,
          metadata: { reason: input.reason, measurementId: input.measurementId, sessionId: input.sessionId },
        },
      ],
    };
    this.disputes.set(id, dispute);
    this.index(dispute);
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.disputeOpened,
        { disputeId: id, technicianId: input.technicianId, reason: input.reason, measurementId: input.measurementId, sessionId: input.sessionId },
        {},
        "domain",
      ),
    );
    return dispute;
  }

  respond(disputeId: DisputeId, response: Omit<DisputeResponse, "at">): Dispute {
    const current = this.require(disputeId);
    assertTransition(current.status, "technician_responded");
    const full: DisputeResponse = { ...response, at: getClock().iso() };
    const updated: Dispute = {
      ...current,
      responses: [...current.responses, full],
      status: current.status === "opened" ? "technician_responded" : current.status,
      timeline: [
        ...current.timeline,
        this.timelineEntry("response", response.from, current.status, current.status === "opened" ? "technician_responded" : current.status, `${response.role} responded`),
      ],
    };
    this.disputes.set(disputeId, updated);
    this.reindex(updated, current);
    return updated;
  }

  submitForReview(disputeId: DisputeId, reviewerType: "program" | "independent"): Dispute {
    const current = this.require(disputeId);
    const nextStatus: DisputeStatus = reviewerType === "program" ? "program_review" : "evidence_review";
    assertTransition(current.status, nextStatus);
    const updated: Dispute = {
      ...current,
      status: nextStatus,
      timeline: [
        ...current.timeline,
        this.timelineEntry("submitted_for_review", current.disputedBy, current.status, nextStatus, `Submitted for ${reviewerType} review`),
      ],
    };
    this.disputes.set(disputeId, updated);
    return updated;
  }

  review(disputeId: DisputeId, review: Omit<DisputeReview, "at">): Dispute {
    const current = this.require(disputeId);
    if (current.status !== "evidence_review" && current.status !== "program_review" && current.status !== "independent_review") {
      throw new TechnicianError({
        code: "eks.technician.dispute.review.not_in_review",
        category: "state_conflict",
        message: `Cannot review a dispute in status "${current.status}".`,
        userMessage: "This dispute is not currently under review.",
      });
    }
    const full: DisputeReview = { ...review, at: getClock().iso() };
    const escalate = review.recommendation === "needs_info" || review.role === "independent";
    const nextStatus: DisputeStatus = escalate && current.status !== "independent_review" ? "independent_review" : current.status;
    const updated: Dispute = {
      ...current,
      reviews: [...current.reviews, full],
      status: nextStatus,
      timeline: [
        ...current.timeline,
        this.timelineEntry("review", review.reviewerId, current.status, nextStatus, `${review.role} reviewer recommends ${review.recommendation}`),
      ],
    };
    this.disputes.set(disputeId, updated);
    this.reindex(updated, current);
    return updated;
  }

  appeal(disputeId: DisputeId, reason: string): Dispute {
    const current = this.require(disputeId);
    assertTransition(current.status, "appealed");
    const updated: Dispute = {
      ...current,
      status: "appealed",
      timeline: [
        ...current.timeline,
        this.timelineEntry("appealed", current.disputedBy, current.status, "appealed", `Appealed: ${reason}`, { reason }),
      ],
    };
    this.disputes.set(disputeId, updated);
    return updated;
  }

  resolve(disputeId: DisputeId, decision: Omit<DisputeDecision, "decidedAt">): Dispute {
    const current = this.require(disputeId);
    const nextStatus: DisputeStatus = decision.decision === "upheld" ? "resolved_upheld" : "resolved_overturned";
    assertTransition(current.status, nextStatus);
    const now = getClock().iso();
    const full: DisputeDecision = { ...decision, decidedAt: now };
    const updated: Dispute = {
      ...current,
      status: nextStatus,
      decision: full,
      resolvedAt: now,
      timeline: [
        ...current.timeline,
        this.timelineEntry("decision", decision.decidedBy, current.status, nextStatus, `Dispute ${decision.decision} (final: ${decision.final})`, { decision: decision.decision, rationale: decision.rationale }),
      ],
    };
    this.disputes.set(disputeId, updated);
    this.reindex(updated, current);
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.disputeResolved,
        { disputeId, technicianId: current.technicianId, decision: decision.decision, final: decision.final },
        {},
        "domain",
      ),
    );
    return updated;
  }

  close(disputeId: DisputeId, closedBy: AccountId): Dispute {
    const current = this.require(disputeId);
    assertTransition(current.status, "closed");
    if (current.status !== "resolved_upheld" && current.status !== "resolved_overturned") {
      throw new TechnicianError({
        code: "eks.technician.dispute.close.not_resolved",
        category: "state_conflict",
        message: "Dispute must be resolved before closing.",
        userMessage: "A dispute must be resolved before it can be closed.",
      });
    }
    const now = getClock().iso();
    const updated: Dispute = {
      ...current,
      status: "closed",
      closedAt: now,
      timeline: [
        ...current.timeline,
        this.timelineEntry("closed", closedBy, current.status, "closed", `Dispute closed by ${closedBy}`),
      ],
    };
    this.disputes.set(disputeId, updated);
    return updated;
  }

  get(id: DisputeId): Dispute | undefined {
    return this.disputes.get(id);
  }

  list(filter?: ListDisputesFilter): Dispute[] {
    let list = [...this.disputes.values()];
    if (filter?.status) list = list.filter((d) => d.status === filter.status);
    if (filter?.technicianId) list = list.filter((d) => d.technicianId === filter.technicianId);
    if (filter?.programId) list = list.filter((d) => d.programId === filter.programId);
    if (filter?.reason) list = list.filter((d) => d.reason === filter.reason);
    if (filter?.measurementId) list = list.filter((d) => d.measurementId === filter.measurementId);
    if (filter?.sessionId) list = list.filter((d) => d.sessionId === filter.sessionId);
    if (filter?.disputedBy) list = list.filter((d) => d.disputedBy === filter.disputedBy);
    return list.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  getTimeline(id: DisputeId): DisputeTimelineEntry[] {
    const d = this.disputes.get(id);
    return d ? [...d.timeline] : [];
  }

  addEvidence(disputeId: DisputeId, evidenceId: EvidenceId, addedBy: AccountId): Dispute {
    const current = this.require(disputeId);
    if (current.evidenceIds.includes(evidenceId)) return current;
    const updated: Dispute = {
      ...current,
      evidenceIds: [...current.evidenceIds, evidenceId],
      timeline: [
        ...current.timeline,
        this.timelineEntry("evidence_added", addedBy, current.status, current.status, `Evidence ${evidenceId} added`, { evidenceId }),
      ],
    };
    this.disputes.set(disputeId, updated);
    return updated;
  }

  getStats(): {
    total: number;
    byStatus: Record<DisputeStatus, number>;
    byReason: Record<DisputeReason, number>;
    resolutionRate: number;
    overturnRate: number;
    avgResolutionMs?: number;
  } {
    const list = [...this.disputes.values()];
    const byStatus = {} as Record<DisputeStatus, number>;
    const byReason = {} as Record<DisputeReason, number>;
    const statusKeys: DisputeStatus[] = [
      "opened", "technician_responded", "evidence_review", "program_review",
      "independent_review", "appealed", "resolved_upheld", "resolved_overturned", "closed",
    ];
    const reasonKeys: DisputeReason[] = [
      "measurement_inaccuracy", "procedural_error", "evidence_issue", "technician_misconduct",
      "device_malfunction", "identity_mismatch", "fraud_suspected", "other",
    ];
    for (const s of statusKeys) byStatus[s] = 0;
    for (const r of reasonKeys) byReason[r] = 0;
    let resolved = 0;
    let overturned = 0;
    let totalResolutionMs = 0;
    let resolutionSamples = 0;
    for (const d of list) {
      byStatus[d.status]++;
      byReason[d.reason]++;
      if (d.status === "resolved_upheld" || d.status === "resolved_overturned" || d.status === "closed") {
        resolved++;
        if (d.resolvedAt) {
          totalResolutionMs += Date.parse(d.resolvedAt) - Date.parse(d.openedAt);
          resolutionSamples++;
        }
      }
      if (d.status === "resolved_overturned" || (d.decision && d.decision.decision === "overturned")) {
        overturned++;
      }
    }
    return {
      total: list.length,
      byStatus,
      byReason,
      resolutionRate: list.length > 0 ? resolved / list.length : 0,
      overturnRate: resolved > 0 ? overturned / resolved : 0,
      avgResolutionMs: resolutionSamples > 0 ? totalResolutionMs / resolutionSamples : undefined,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private require(id: DisputeId): Dispute {
    const d = this.disputes.get(id);
    if (!d) {
      throw new TechnicianError({
        code: "eks.technician.dispute.not_found",
        category: "not_found",
        message: `Dispute ${id} not found.`,
        userMessage: "This dispute could not be found.",
      });
    }
    return d;
  }

  private timelineEntry(
    type: DisputeTimelineEntryType,
    actor: AccountId,
    fromStatus: DisputeStatus | undefined,
    toStatus: DisputeStatus,
    message: string,
    metadata?: Record<string, unknown>,
  ): DisputeTimelineEntry {
    return { at: getClock().iso(), type, actor, fromStatus, toStatus, message, metadata };
  }

  private index(d: Dispute): void {
    const t = this.byTechnician.get(d.technicianId) ?? [];
    this.byTechnician.set(d.technicianId, [...t, d.id]);
    if (d.programId) {
      const p = this.byProgram.get(d.programId) ?? [];
      this.byProgram.set(d.programId, [...p, d.id]);
    }
    if (d.measurementId) {
      const m = this.byMeasurement.get(d.measurementId) ?? [];
      this.byMeasurement.set(d.measurementId, [...m, d.id]);
    }
    if (d.sessionId) {
      const s = this.bySession.get(d.sessionId) ?? [];
      this.bySession.set(d.sessionId, [...s, d.id]);
    }
  }

  private reindex(updated: Dispute, previous: Dispute): void {
    if (updated.technicianId !== previous.technicianId) {
      const t = this.byTechnician.get(previous.technicianId) ?? [];
      this.byTechnician.set(previous.technicianId, t.filter((id) => id !== updated.id));
      const nt = this.byTechnician.get(updated.technicianId) ?? [];
      this.byTechnician.set(updated.technicianId, [...nt, updated.id]);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _disputes: DisputeManager | null = null;
export function getDisputes(): DisputeManager {
  if (!_disputes) _disputes = new DisputeManager();
  return _disputes;
}
