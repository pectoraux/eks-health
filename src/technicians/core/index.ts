/**
 * Eks-Health Technician Network — Core Primitives
 *
 * Foundational types for technicians, certifications, eligibility,
 * appointments, measurement sessions, verification, evidence, trust,
 * reputation, and accreditation.
 *
 * The platform understands ONLY generic concepts. It does NOT know what
 * "nurse", "doctor", "nutritionist", or "personal trainer" mean. Those
 * are technician types and certifications defined by Programs or
 * organizations. The platform provides the programmable trust network.
 *
 * Built on the kernel (events, ids, errors), identity (accounts, personas),
 * programs (capabilities, manifests), and health (measurements, evidence,
 * verification, sources).
 */

import "server-only";
import type {
  Brand,
  TenantId,
  CorrelationId,
  TraceId,
} from "@/kernel";
import type { AccountId, OrgId } from "@/identity";
import type { ProgramId } from "@/programs";
import type { MeasurementId, EvidenceId, SourceId, VerificationId } from "@/health";

// ---------------------------------------------------------------------------
// Branded technician identifiers
// ---------------------------------------------------------------------------

export type TechnicianId = Brand<string, "TechnicianId">;
export type CertificationId = Brand<string, "CertificationId">;
export type CertificationTypeId = Brand<string, "CertificationTypeId">;
export type AccreditationId = Brand<string, "AccreditationId">;
export type AccreditationAuthorityId = Brand<string, "AccreditationAuthorityId">;
export type AppointmentId = Brand<string, "AppointmentId">;
export type SessionId = Brand<string, "SessionId">;
export type EligibilityRuleId = Brand<string, "EligibilityRuleId">;
export type EligibilityResultId = Brand<string, "EligibilityResultId">;
export type ReputationId = Brand<string, "ReputationId">;
export type DisputeId = Brand<string, "DisputeId">;
export type DeviceId = Brand<string, "DeviceId">;
export type ChainOfCustodyId = Brand<string, "ChainOfCustodyId">;
export type FraudAlertId = Brand<string, "FraudAlertId">;
export type PaymentIntentId = Brand<string, "PaymentIntentId">;
export type WaitlistEntryId = Brand<string, "WaitlistEntryId">;

export function asTechnicianId(s: string): TechnicianId { return s as TechnicianId; }
export function asCertificationId(s: string): CertificationId { return s as CertificationId; }
export function asCertificationTypeId(s: string): CertificationTypeId { return s as CertificationTypeId; }
export function asAccreditationId(s: string): AccreditationId { return s as AccreditationId; }
export function asAccreditationAuthorityId(s: string): AccreditationAuthorityId { return s as AccreditationAuthorityId; }
export function asAppointmentId(s: string): AppointmentId { return s as AppointmentId; }
export function asSessionId(s: string): SessionId { return s as SessionId; }
export function asEligibilityRuleId(s: string): EligibilityRuleId { return s as EligibilityRuleId; }
export function asReputationId(s: string): ReputationId { return s as ReputationId; }
export function asDisputeId(s: string): DisputeId { return s as DisputeId; }
export function asDeviceId(s: string): DeviceId { return s as DeviceId; }
export function asChainOfCustodyId(s: string): ChainOfCustodyId { return s as ChainOfCustodyId; }
export function asFraudAlertId(s: string): FraudAlertId { return s as FraudAlertId; }
export function asPaymentIntentId(s: string): PaymentIntentId { return s as PaymentIntentId; }
export function asWaitlistEntryId(s: string): WaitlistEntryId { return s as WaitlistEntryId; }

// ---------------------------------------------------------------------------
// Technician types (program-defined, NOT hardcoded by the platform)
// ---------------------------------------------------------------------------

export type TechnicianCategory =
  | "individual"
  | "organization"
  | "team"
  | "clinic"
  | "laboratory"
  | "mobile"
  | "remote"
  | "custom";

// ---------------------------------------------------------------------------
// Certification types
// ---------------------------------------------------------------------------

export type CertificationStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "suspended"
  | "renewing";

export type CertificationLevel =
  | "basic"
  | "intermediate"
  | "advanced"
  | "expert"
  | "master";

// ---------------------------------------------------------------------------
// Accreditation authority types
// ---------------------------------------------------------------------------

export type AccreditationAuthorityType =
  | "government"
  | "hospital"
  | "professional_association"
  | "university"
  | "program_developer"
  | "platform"
  | "independent_organization"
  | "custom";

// ---------------------------------------------------------------------------
// Appointment states
// ---------------------------------------------------------------------------

export type AppointmentStatus =
  | "requested"
  | "offered"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show"
  | "rescheduled";

export type AppointmentType =
  | "in_person"
  | "remote"
  | "home_visit"
  | "clinic_visit"
  | "lab_visit"
  | "custom";

// ---------------------------------------------------------------------------
// Measurement session states
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "scheduled"
  | "checked_in"
  | "in_progress"
  | "evidence_captured"
  | "technician_signed"
  | "participant_confirmed"
  | "program_validated"
  | "verified"
  | "disputed"
  | "cancelled"
  | "failed";

// ---------------------------------------------------------------------------
// Dispute states
// ---------------------------------------------------------------------------

export type DisputeStatus =
  | "opened"
  | "technician_responded"
  | "evidence_review"
  | "program_review"
  | "independent_review"
  | "appealed"
  | "resolved_upheld"
  | "resolved_overturned"
  | "closed";

export type DisputeReason =
  | "measurement_inaccuracy"
  | "procedural_error"
  | "evidence_issue"
  | "technician_misconduct"
  | "device_malfunction"
  | "identity_mismatch"
  | "fraud_suspected"
  | "other";

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export type ReputationFactor =
  | "accuracy"
  | "consistency"
  | "participant_feedback"
  | "verification_quality"
  | "dispute_rate"
  | "completion_rate"
  | "response_time"
  | "fraud_indicators"
  | "platform_violations"
  | "certification_history";

// ---------------------------------------------------------------------------
// Device trust levels
// ---------------------------------------------------------------------------

export type DeviceTrustLevel =
  | "unverified"
  | "registered"
  | "calibrated"
  | "certified"
  | "clinical"
  | "authoritative";

// ---------------------------------------------------------------------------
// Fraud alert
// ---------------------------------------------------------------------------

export type FraudAlertType =
  | "improbable_improvement"
  | "duplicate_evidence"
  | "device_anomaly"
  | "location_inconsistency"
  | "technician_collusion"
  | "identity_mismatch"
  | "frequency_abuse"
  | "suspicious_verification_pattern"
  | "impossible_travel"
  | "statistical_outlier";

export type FraudAlertSeverity = "low" | "medium" | "high" | "critical";

// ---------------------------------------------------------------------------
// Payment (delegated to payment provider — no business logic here)
// ---------------------------------------------------------------------------

export type PaymentProviderId = "payswap" | "stripe" | "manual" | "custom";

export interface PaymentIntent {
  readonly id: PaymentIntentId;
  readonly provider: PaymentProviderId;
  readonly amount: number;
  readonly currency: string;
  readonly status: "pending" | "confirmed" | "failed" | "refunded" | "payout_confirmed";
  readonly reference: string; // session or appointment id
  readonly createdAt: string;
  readonly confirmedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Technician errors
// ---------------------------------------------------------------------------

export type TechnicianErrorCategory =
  | "not_found"
  | "not_certified"
  | "not_eligible"
  | "certification_expired"
  | "appointment_conflict"
  | "session_invalid"
  | "verification_failed"
  | "dispute_invalid"
  | "device_not_trusted"
  | "fraud_detected"
  | "payment_required"
  | "validation"
  | "state_conflict";

export class TechnicianError extends Error {
  readonly code: string;
  readonly category: TechnicianErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: TechnicianErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "TechnicianError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A technician platform error occurred.";
    this.timestamp = new Date().toISOString();
    this.correlationId = opts.correlationId;
    this.traceId = opts.traceId;
    this.metadata = opts.metadata ?? {};
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      userMessage: this.userMessage,
      message: this.message,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      traceId: this.traceId,
      metadata: this.metadata,
    };
  }
}

// ---------------------------------------------------------------------------
// Technician event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const TECHNICIAN_EVENTS = {
  technicianRegistered: "eks.technician.registered",
  technicianSuspended: "eks.technician.suspended",
  certificationGranted: "eks.technician.certification.granted",
  certificationRevoked: "eks.technician.certification.revoked",
  certificationExpired: "eks.technician.certification.expired",
  accreditationGranted: "eks.technician.accreditation.granted",
  appointmentBooked: "eks.technician.appointment.booked",
  appointmentCancelled: "eks.technician.appointment.cancelled",
  appointmentRescheduled: "eks.technician.appointment.rescheduled",
  sessionStarted: "eks.technician.session.started",
  sessionCompleted: "eks.technician.session.completed",
  sessionVerified: "eks.technician.session.verified",
  evidenceCaptured: "eks.technician.evidence.captured",
  technicianSigned: "eks.technician.session.signed",
  participantConfirmed: "eks.technician.session.confirmed",
  disputeOpened: "eks.technician.dispute.opened",
  disputeResolved: "eks.technician.dispute.resolved",
  reputationUpdated: "eks.technician.reputation.updated",
  fraudAlertCreated: "eks.technician.fraud.alert",
  deviceRegistered: "eks.technician.device.registered",
  paymentIntentCreated: "eks.technician.payment.intent_created",
  paymentConfirmed: "eks.technician.payment.confirmed",
} as const;

export type TechnicianEventType = (typeof TECHNICIAN_EVENTS)[keyof typeof TECHNICIAN_EVENTS];

export { type TenantId, type AccountId, type OrgId, type ProgramId, type MeasurementId, type EvidenceId, type SourceId, type VerificationId };
