/**
 * Eks-Health Technician Network — Measurement Sessions
 *
 * A MeasurementSession is the immutable record of a single health-data
 * collection event: which participant, which technician, which program,
 * which measurements were taken, what evidence was captured, how it was
 * verified, where/when it happened, on what devices, who signed off, and
 * what audit trail it carries. Sessions are state machines that progress
 * through: scheduled → checked_in → in_progress → evidence_captured →
 * technician_signed → participant_confirmed → program_validated → verified
 * (with disputed / cancelled / failed terminal exits at any point).
 *
 * Signatures are REAL SHA-256 hashes computed from the canonical session
 * representation at signing time, anchoring the record cryptographically.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type SessionId,
  type AppointmentId,
  type TechnicianId,
  type PaymentIntentId,
  type SessionStatus,
  type AccountId,
  type ProgramId,
  type MeasurementId,
  type EvidenceId,
  type VerificationId,
  type ChainOfCustodyId,
  type DeviceId,
  TechnicianError,
  TECHNICIAN_EVENTS,
  asSessionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getTechnicians } from "../profiles";

// ---------------------------------------------------------------------------
// Signature & location
// ---------------------------------------------------------------------------

export type SignatureMethod = "digital" | "biometric" | "witnessed";

export interface SessionSignature {
  readonly signedBy: AccountId;
  readonly signedAt: string;
  /** SHA-256 of the canonical session data at signing time. */
  readonly signatureHash: string;
  readonly method: SignatureMethod;
}

export interface SessionLocation {
  readonly lat: number;
  readonly lon: number;
  readonly label?: string;
}

// ---------------------------------------------------------------------------
// Measurement session
// ---------------------------------------------------------------------------

export interface MeasurementSession {
  readonly id: SessionId;
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly appointmentId?: AppointmentId;
  readonly requestedMeasurements: string[]; // schema IDs
  readonly recordedMeasurements: MeasurementId[];
  readonly evidenceIds: EvidenceId[];
  readonly verificationId?: VerificationId;
  readonly location?: SessionLocation;
  readonly scheduledAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly deviceIds?: string[];
  readonly notes: string[];
  readonly technicianSignature?: SessionSignature;
  readonly participantSignature?: SessionSignature;
  readonly status: SessionStatus;
  readonly paymentIntentId?: PaymentIntentId;
  readonly auditReferences: string[];
  readonly chainOfCustodyId?: ChainOfCustodyId;
  readonly createdBy: AccountId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancellationReason?: string;
  readonly failureReason?: string;
  readonly disputeReason?: string;
}

// Session snapshot used for signature computation — the cryptographically
// anchored projection of the session at a point in time.
export interface SessionSnapshot {
  readonly id: SessionId;
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly appointmentId?: AppointmentId;
  readonly requestedMeasurements: string[];
  readonly recordedMeasurements: string[];
  readonly evidenceIds: string[];
  readonly status: SessionStatus;
  readonly scheduledAt: string;
  readonly startedAt?: string;
  readonly location?: SessionLocation;
}

/** A single state transition in the session's history. */
export interface SessionStep {
  readonly fromStatus: SessionStatus | "created";
  readonly toStatus: SessionStatus;
  readonly at: string;
  readonly actor?: AccountId;
  readonly reason?: string;
  readonly detail?: string;
}

/** Materialized view of a session's terminal outcome. */
export type SessionOutcome =
  | { kind: "verified"; at: string }
  | { kind: "cancelled"; at: string; reason: string }
  | { kind: "failed"; at: string; reason: string }
  | { kind: "disputed"; at: string; reason: string }
  | { kind: "open"; currentStatus: SessionStatus };

export interface SessionState {
  readonly session: MeasurementSession;
  readonly history: SessionStep[];
  readonly outcome: SessionOutcome;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  scheduled: ["checked_in", "in_progress", "cancelled", "failed", "disputed"],
  checked_in: ["in_progress", "cancelled", "failed", "disputed"],
  in_progress: ["evidence_captured", "technician_signed", "cancelled", "failed", "disputed"],
  evidence_captured: ["technician_signed", "cancelled", "failed", "disputed"],
  technician_signed: ["participant_confirmed", "program_validated", "disputed", "cancelled", "failed"],
  participant_confirmed: ["program_validated", "disputed", "cancelled", "failed"],
  program_validated: ["verified", "disputed", "cancelled", "failed"],
  verified: [],
  disputed: ["program_validated", "cancelled", "failed", "verified"],
  cancelled: [],
  failed: [],
};

// ---------------------------------------------------------------------------
// Create input
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  readonly participantId: AccountId;
  readonly technicianId: TechnicianId;
  readonly programId: ProgramId;
  readonly appointmentId?: AppointmentId;
  readonly requestedMeasurements?: string[];
  readonly location?: SessionLocation;
  readonly scheduledAt: string;
  readonly deviceIds?: string[];
  readonly notes?: string[];
  readonly paymentIntentId?: PaymentIntentId;
  readonly chainOfCustodyId?: ChainOfCustodyId;
  readonly createdBy: AccountId;
}

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly sessions = new Map<SessionId, MeasurementSession>();
  private readonly history = new Map<SessionId, SessionStep[]>();
  private readonly byParticipant = new Map<AccountId, SessionId[]>();
  private readonly byTechnician = new Map<TechnicianId, SessionId[]>();
  private readonly byProgram = new Map<ProgramId, SessionId[]>();
  private readonly byAppointment = new Map<AppointmentId, SessionId[]>();

  create(input: CreateSessionInput): MeasurementSession {
    const now = getClock().iso();
    const session: MeasurementSession = {
      id: asSessionId(generateId("sess_")),
      participantId: input.participantId,
      technicianId: input.technicianId,
      programId: input.programId,
      appointmentId: input.appointmentId,
      requestedMeasurements: input.requestedMeasurements ?? [],
      recordedMeasurements: [],
      evidenceIds: [],
      location: input.location,
      scheduledAt: input.scheduledAt,
      deviceIds: input.deviceIds,
      notes: input.notes ?? [],
      status: "scheduled",
      paymentIntentId: input.paymentIntentId,
      auditReferences: [],
      chainOfCustodyId: input.chainOfCustodyId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.history.set(session.id, [
      { fromStatus: "created", toStatus: "scheduled", at: now, actor: input.createdBy },
    ]);
    this.indexBy(session);
    return session;
  }

  get(id: SessionId): MeasurementSession | undefined {
    return this.sessions.get(id);
  }

  list(filter?: {
    participantId?: AccountId;
    technicianId?: TechnicianId;
    programId?: ProgramId;
    appointmentId?: AppointmentId;
    status?: SessionStatus;
    from?: string;
    to?: string;
  }): MeasurementSession[] {
    let list = [...this.sessions.values()];
    if (filter?.participantId) list = list.filter((s) => s.participantId === filter.participantId);
    if (filter?.technicianId) list = list.filter((s) => s.technicianId === filter.technicianId);
    if (filter?.programId) list = list.filter((s) => s.programId === filter.programId);
    if (filter?.appointmentId) list = list.filter((s) => s.appointmentId === filter.appointmentId);
    if (filter?.status) list = list.filter((s) => s.status === filter.status);
    if (filter?.from) list = list.filter((s) => s.scheduledAt >= filter.from!);
    if (filter?.to) list = list.filter((s) => s.scheduledAt <= filter.to!);
    return list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  /** Transition to "checked_in". */
  checkIn(id: SessionId, actor?: AccountId): MeasurementSession {
    return this.transition(id, "checked_in", { actor });
  }

  /** Transition to "in_progress", emits session.started. */
  start(id: SessionId, actor?: AccountId): MeasurementSession {
    const updated = this.transition(id, "in_progress", { actor });
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.sessionStarted,
        {
          sessionId: id,
          technicianId: updated.technicianId,
          participantId: updated.participantId,
          programId: updated.programId,
          startedAt: updated.startedAt,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Add a recorded measurement id to the session. */
  recordMeasurement(id: SessionId, measurementId: MeasurementId): MeasurementSession {
    const session = this.require(id);
    if (session.recordedMeasurements.includes(measurementId)) return session;
    const updated: MeasurementSession = {
      ...session,
      recordedMeasurements: [...session.recordedMeasurements, measurementId],
      updatedAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  /** Attach evidence and emit evidence.captured. Auto-transitions to evidence_captured. */
  captureEvidence(id: SessionId, evidenceId: EvidenceId, actor?: AccountId): MeasurementSession {
    const session = this.require(id);
    if (session.evidenceIds.includes(evidenceId)) return session;
    const now = getClock().iso();
    const updated: MeasurementSession = {
      ...session,
      evidenceIds: [...session.evidenceIds, evidenceId],
      status:
        session.status === "in_progress"
          ? "evidence_captured"
          : session.status,
      updatedAt: now,
    };
    this.sessions.set(id, updated);
    if (updated.status !== session.status) {
      this.pushHistory(id, session.status, updated.status, now, actor, "evidence captured");
    }
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.evidenceCaptured,
        {
          sessionId: id,
          evidenceId,
          technicianId: updated.technicianId,
          programId: updated.programId,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Technician signs: compute SHA-256, transition to "technician_signed". */
  technicianSign(
    id: SessionId,
    technicianAccountId: AccountId,
    method: SignatureMethod = "digital",
  ): MeasurementSession {
    const session = this.require(id);
    if (session.status !== "in_progress" && session.status !== "evidence_captured") {
      throw new TechnicianError({
        code: "eks.technician.session.invalid_sign_state",
        category: "session_invalid",
        message: `Cannot sign session in status ${session.status}.`,
        userMessage: "This session cannot be signed in its current state.",
        metadata: { sessionId: id, status: session.status },
      });
    }
    const now = getClock().iso();
    const snapshot = this.snapshot(session);
    const signatureHash = this.signatureHash(snapshot, now, technicianAccountId);
    const signature: SessionSignature = {
      signedBy: technicianAccountId,
      signedAt: now,
      signatureHash,
      method,
    };
    const updated: MeasurementSession = {
      ...session,
      technicianSignature: signature,
      status: "technician_signed",
      updatedAt: now,
    };
    this.sessions.set(id, updated);
    this.pushHistory(id, session.status, "technician_signed", now, technicianAccountId, "technician signature");
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.technicianSigned,
        {
          sessionId: id,
          signedBy: technicianAccountId,
          signatureHash,
          method,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Participant confirms: signs and transitions to "participant_confirmed". */
  participantConfirm(
    id: SessionId,
    participantAccountId: AccountId,
    method: SignatureMethod = "digital",
  ): MeasurementSession {
    const session = this.require(id);
    if (session.status !== "technician_signed" && session.status !== "participant_confirmed") {
      throw new TechnicianError({
        code: "eks.technician.session.invalid_confirm_state",
        category: "session_invalid",
        message: `Cannot confirm session in status ${session.status}.`,
        metadata: { sessionId: id, status: session.status },
      });
    }
    const now = getClock().iso();
    const snapshot = this.snapshot(session);
    const signatureHash = this.signatureHash(snapshot, now, participantAccountId);
    const signature: SessionSignature = {
      signedBy: participantAccountId,
      signedAt: now,
      signatureHash,
      method,
    };
    const updated: MeasurementSession = {
      ...session,
      participantSignature: signature,
      status: "participant_confirmed",
      updatedAt: now,
    };
    this.sessions.set(id, updated);
    this.pushHistory(id, session.status, "participant_confirmed", now, participantAccountId, "participant confirmation");
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.participantConfirmed,
        {
          sessionId: id,
          signedBy: participantAccountId,
          signatureHash,
          method,
        },
        {},
        "domain",
      ),
    );
    return updated;
  }

  /** Program validation pass — transitions to "program_validated". */
  programValidate(id: SessionId, actor?: AccountId, verificationId?: VerificationId): MeasurementSession {
    const updated = this.transition(id, "program_validated", {
      actor,
      extra: verificationId ? { verificationId } : undefined,
    });
    return updated;
  }

  /** Final verification — transitions to "verified", emits session.verified + session.completed. */
  verify(id: SessionId, actor?: AccountId, verificationId?: VerificationId): MeasurementSession {
    const now = getClock().iso();
    const session = this.require(id);
    const verified = this.transition(id, "verified", {
      actor,
      at: now,
      extra: { completedAt: now, verificationId },
    });
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.sessionVerified,
        {
          sessionId: id,
          technicianId: verified.technicianId,
          programId: verified.programId,
          verifiedAt: now,
        },
        {},
        "domain",
      ),
    );
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.sessionCompleted,
        {
          sessionId: id,
          technicianId: verified.technicianId,
          participantId: verified.participantId,
          programId: verified.programId,
          completedAt: now,
          outcome: "verified",
        },
        {},
        "domain",
      ),
    );
    // Best-effort: update technician profile session counters.
    try {
      getTechnicians().recordSession(verified.technicianId, true, false);
    } catch {
      // profile registry may not be initialized in this context.
    }
    return verified;
  }

  dispute(id: SessionId, reason: string, actor?: AccountId): MeasurementSession {
    const updated = this.transition(id, "disputed", { actor, reason, reasonField: "disputeReason" });
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.disputeOpened,
        { sessionId: id, reason, technicianId: updated.technicianId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  cancel(id: SessionId, reason: string, actor?: AccountId): MeasurementSession {
    const updated = this.transition(id, "cancelled", { actor, reason, reasonField: "cancellationReason" });
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.sessionCompleted,
        { sessionId: id, outcome: "cancelled", reason, technicianId: updated.technicianId },
        {},
        "domain",
      ),
    );
    return updated;
  }

  fail(id: SessionId, reason: string, actor?: AccountId): MeasurementSession {
    const updated = this.transition(id, "failed", { actor, reason, reasonField: "failureReason" });
    void getEventBus().publish(
      buildEvent(
        TECHNICIAN_EVENTS.sessionCompleted,
        { sessionId: id, outcome: "failed", reason, technicianId: updated.technicianId },
        {},
        "domain",
      ),
    );
    try {
      getTechnicians().recordSession(updated.technicianId, false, false);
    } catch {
      // profile registry may not be initialized in this context.
    }
    return updated;
  }

  addNote(id: SessionId, note: string): MeasurementSession {
    const session = this.require(id);
    const updated: MeasurementSession = {
      ...session,
      notes: [...session.notes, note],
      updatedAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  addAuditReference(id: SessionId, ref: string): MeasurementSession {
    const session = this.require(id);
    if (session.auditReferences.includes(ref)) return session;
    const updated: MeasurementSession = {
      ...session,
      auditReferences: [...session.auditReferences, ref],
      updatedAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  setPaymentIntent(id: SessionId, paymentIntentId: PaymentIntentId): MeasurementSession {
    const session = this.require(id);
    const updated: MeasurementSession = {
      ...session,
      paymentIntentId,
      updatedAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  setVerification(id: SessionId, verificationId: VerificationId): MeasurementSession {
    const session = this.require(id);
    const updated: MeasurementSession = {
      ...session,
      verificationId,
      updatedAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  attachDevice(id: SessionId, deviceId: DeviceId): MeasurementSession {
    const session = this.require(id);
    const devices = session.deviceIds ?? [];
    if (devices.includes(deviceId)) return session;
    const updated: MeasurementSession = {
      ...session,
      deviceIds: [...devices, deviceId],
      updatedAt: getClock().iso(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  getHistory(id: SessionId): SessionStep[] {
    return [...(this.history.get(id) ?? [])];
  }

  getState(id: SessionId): SessionState {
    const session = this.require(id);
    const history = this.getHistory(id);
    const outcome: SessionOutcome = this.computeOutcome(session);
    return { session, history, outcome };
  }

  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    verified: number;
    disputed: number;
    cancelled: number;
    failed: number;
  } {
    const list = [...this.sessions.values()];
    const byStatus: Record<string, number> = {};
    for (const s of list) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    return {
      total: list.length,
      byStatus,
      verified: list.filter((s) => s.status === "verified").length,
      disputed: list.filter((s) => s.status === "disputed").length,
      cancelled: list.filter((s) => s.status === "cancelled").length,
      failed: list.filter((s) => s.status === "failed").length,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private require(id: SessionId): MeasurementSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new TechnicianError({
        code: "eks.technician.session.not_found",
        category: "not_found",
        message: "Session not found.",
        userMessage: "This measurement session does not exist.",
        metadata: { sessionId: id },
      });
    }
    return session;
  }

  private transition(
    id: SessionId,
    toStatus: SessionStatus,
    opts: {
      actor?: AccountId;
      reason?: string;
      reasonField?: "cancellationReason" | "failureReason" | "disputeReason";
      at?: string;
      extra?: Partial<MeasurementSession>;
    },
  ): MeasurementSession {
    const session = this.require(id);
    const allowed = VALID_TRANSITIONS[session.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new TechnicianError({
        code: "eks.technician.session.invalid_transition",
        category: "session_invalid",
        message: `Cannot transition session from ${session.status} to ${toStatus}.`,
        userMessage: "This session state change is not allowed.",
        metadata: { sessionId: id, from: session.status, to: toStatus },
      });
    }
    const now = opts.at ?? getClock().iso();
    const updated: MeasurementSession = {
      ...session,
      status: toStatus,
      startedAt: toStatus === "in_progress" ? (session.startedAt ?? now) : session.startedAt,
      completedAt:
        toStatus === "verified" || toStatus === "cancelled" || toStatus === "failed"
          ? now
          : session.completedAt,
      ...(opts.reason && opts.reasonField ? { [opts.reasonField]: opts.reason } : {}),
      ...(opts.extra ?? {}),
      updatedAt: now,
    };
    this.sessions.set(id, updated);
    this.pushHistory(id, session.status, toStatus, now, opts.actor, opts.reason);
    return updated;
  }

  private pushHistory(
    id: SessionId,
    from: SessionStatus | "created",
    to: SessionStatus,
    at: string,
    actor?: AccountId,
    reason?: string,
  ): void {
    const list = this.history.get(id) ?? [];
    list.push({ fromStatus: from, toStatus: to, at, actor, reason });
    this.history.set(id, list);
  }

  private indexBy(s: MeasurementSession): void {
    const pList = this.byParticipant.get(s.participantId) ?? [];
    this.byParticipant.set(s.participantId, [...pList, s.id]);
    const tList = this.byTechnician.get(s.technicianId) ?? [];
    this.byTechnician.set(s.technicianId, [...tList, s.id]);
    const prList = this.byProgram.get(s.programId) ?? [];
    this.byProgram.set(s.programId, [...prList, s.id]);
    if (s.appointmentId) {
      const aList = this.byAppointment.get(s.appointmentId) ?? [];
      this.byAppointment.set(s.appointmentId, [...aList, s.id]);
    }
  }

  private computeOutcome(s: MeasurementSession): SessionOutcome {
    switch (s.status) {
      case "verified":
        return { kind: "verified", at: s.completedAt ?? s.updatedAt };
      case "cancelled":
        return { kind: "cancelled", at: s.completedAt ?? s.updatedAt, reason: s.cancellationReason ?? "unspecified" };
      case "failed":
        return { kind: "failed", at: s.completedAt ?? s.updatedAt, reason: s.failureReason ?? "unspecified" };
      case "disputed":
        return { kind: "disputed", at: s.updatedAt, reason: s.disputeReason ?? "unspecified" };
      default:
        return { kind: "open", currentStatus: s.status };
    }
  }

  /** Project a session to its cryptographic snapshot. */
  private snapshot(s: MeasurementSession): SessionSnapshot {
    return {
      id: s.id,
      participantId: s.participantId,
      technicianId: s.technicianId,
      programId: s.programId,
      appointmentId: s.appointmentId,
      requestedMeasurements: [...s.requestedMeasurements],
      recordedMeasurements: s.recordedMeasurements.map((m) => String(m)),
      evidenceIds: s.evidenceIds.map((e) => String(e)),
      status: s.status,
      scheduledAt: s.scheduledAt,
      startedAt: s.startedAt,
      location: s.location,
    };
  }

  /**
   * Compute a deterministic SHA-256 signature hash over the canonical
   * representation of the session snapshot plus the signer and timestamp.
   * Keys are sorted to guarantee reproducibility across runtimes.
   */
  private signatureHash(snapshot: SessionSnapshot, signedAt: string, signedBy: AccountId): string {
    const canonical = JSON.stringify(
      {
        evidenceIds: snapshot.evidenceIds,
        id: snapshot.id,
        participantId: snapshot.participantId,
        programId: snapshot.programId,
        recordedMeasurements: snapshot.recordedMeasurements,
        requestedMeasurements: snapshot.requestedMeasurements,
        scheduledAt: snapshot.scheduledAt,
        signedAt,
        signedBy,
        startedAt: snapshot.startedAt ?? null,
        status: snapshot.status,
        technicianId: snapshot.technicianId,
        appointmentId: snapshot.appointmentId ?? null,
        location: snapshot.location ?? null,
      },
      Object.keys({
        evidenceIds: 0,
        id: 0,
        participantId: 0,
        programId: 0,
        recordedMeasurements: 0,
        requestedMeasurements: 0,
        scheduledAt: 0,
        signedAt: 0,
        signedBy: 0,
        startedAt: 0,
        status: 0,
        technicianId: 0,
        appointmentId: 0,
        location: 0,
      }).sort(),
    );
    return createHash("sha256").update(canonical).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: SessionManager | null = null;

export function getSessions(): SessionManager {
  if (!_manager) _manager = new SessionManager();
  return _manager;
}

/** Test-only: replace the singleton. */
export function setSessions(manager: SessionManager | null): void {
  _manager = manager;
}
