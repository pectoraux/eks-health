/**
 * Eks-Health Universal Health Data Platform — Core Primitives
 *
 * Foundational types for measurements, metrics, observations, evidence,
 * verification, timelines, units, schemas, validation, and sources.
 *
 * The platform understands ONLY generic concepts. It does NOT know what
 * "weight", "blood pressure", "HbA1c", or "VO₂ Max" mean. Those concepts
 * are introduced by Programs through schemas. The platform validates and
 * stores them generically.
 *
 * Built on the kernel (events, ids, errors), identity (consent, audit,
 * data-gateway), and programs (capabilities, manifests).
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

// ---------------------------------------------------------------------------
// Branded health-data identifiers
// ---------------------------------------------------------------------------

export type MeasurementId = Brand<string, "MeasurementId">;
export type SchemaId = Brand<string, "SchemaId">;
export type SchemaVersionId = Brand<string, "SchemaVersionId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type VerificationId = Brand<string, "VerificationId">;
export type ProfileId = Brand<string, "ProfileId">;
export type TimelineId = Brand<string, "TimelineId">;
export type SourceId = Brand<string, "SourceId">;
export type UnitId = Brand<string, "UnitId">;
export type ObservationId = Brand<string, "ObservationId">;
export type DerivedMetricId = Brand<string, "DerivedMetricId">;
export type CompositeMetricId = Brand<string, "CompositeMetricId">;
export type ExportRequestId = Brand<string, "ExportRequestId">;
export type QueryId = Brand<string, "QueryId">;

export function asMeasurementId(s: string): MeasurementId { return s as MeasurementId; }
export function asSchemaId(s: string): SchemaId { return s as SchemaId; }
export function asSchemaVersionId(s: string): SchemaVersionId { return s as SchemaVersionId; }
export function asEvidenceId(s: string): EvidenceId { return s as EvidenceId; }
export function asVerificationId(s: string): VerificationId { return s as VerificationId; }
export function asProfileId(s: string): ProfileId { return s as ProfileId; }
export function asTimelineId(s: string): TimelineId { return s as TimelineId; }
export function asSourceId(s: string): SourceId { return s as SourceId; }
export function asUnitId(s: string): UnitId { return s as UnitId; }
export function asObservationId(s: string): ObservationId { return s as ObservationId; }
export function asDerivedMetricId(s: string): DerivedMetricId { return s as DerivedMetricId; }
export function asCompositeMetricId(s: string): CompositeMetricId { return s as CompositeMetricId; }
export function asExportRequestId(s: string): ExportRequestId { return s as ExportRequestId; }
export function asQueryId(s: string): QueryId { return s as QueryId; }

// ---------------------------------------------------------------------------
// Generic measurement value (the platform never interprets the meaning)
// ---------------------------------------------------------------------------

export type MeasurementValue =
  | number
  | string
  | boolean
  | { value: number; unit: string }
  | { systolic: number; diastolic: number; unit: string }
  | Record<string, unknown>
  | unknown[];

// ---------------------------------------------------------------------------
// Verification states
// ---------------------------------------------------------------------------

export type VerificationState =
  | "pending"
  | "verified"
  | "rejected"
  | "expired"
  | "disputed"
  | "superseded";

// ---------------------------------------------------------------------------
// Measurement source types
// ---------------------------------------------------------------------------

export type SourceType =
  | "health_technician"
  | "medical_device"
  | "laboratory"
  | "clinic"
  | "hospital"
  | "wearable"
  | "mobile_app"
  | "manual_entry"
  | "government_registry"
  | "research_organization"
  | "program"
  | "import"
  | "custom";

// ---------------------------------------------------------------------------
// Evidence types
// ---------------------------------------------------------------------------

export type EvidenceType =
  | "image"
  | "video"
  | "medical_report"
  | "laboratory_document"
  | "machine_output"
  | "sensor_log"
  | "digital_signature"
  | "certificate"
  | "supporting_document"
  | "custom";

// ---------------------------------------------------------------------------
// Visibility / privacy levels
// ---------------------------------------------------------------------------

export type VisibilityLevel =
  | "private" // only the participant
  | "program" // the program that requested it
  | "technician" // collecting technician
  | "organization" // participant's org
  | "research_anonymized" // de-identified research
  | "public"; // explicitly public

// ---------------------------------------------------------------------------
// Health-data errors
// ---------------------------------------------------------------------------

export type HealthErrorCategory =
  | "schema_invalid"
  | "validation_failed"
  | "range_exceeded"
  | "duplicate_measurement"
  | "consent_required"
  | "verification_required"
  | "evidence_required"
  | "not_found"
  | "state_conflict"
  | "version_conflict"
  | "unit_mismatch"
  | "provenance_invalid"
  | "quota_exceeded"
  | "interop_error";

export class HealthError extends Error {
  readonly code: string;
  readonly category: HealthErrorCategory;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly timestamp: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly metadata: Record<string, unknown>;

  constructor(opts: {
    code: string;
    category: HealthErrorCategory;
    message: string;
    userMessage?: string;
    retryable?: boolean;
    correlationId?: CorrelationId;
    traceId?: TraceId;
    metadata?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "HealthError";
    this.code = opts.code;
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.userMessage = opts.userMessage ?? "A health data error occurred.";
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
// Health-data event types (published to the kernel event bus)
// ---------------------------------------------------------------------------

export const HEALTH_EVENTS = {
  schemaPublished: "eks.health.schema.published",
  schemaUpdated: "eks.health.schema.updated",
  schemaDeprecated: "eks.health.schema.deprecated",
  measurementCreated: "eks.health.measurement.created",
  measurementUpdated: "eks.health.measurement.updated",
  measurementVerified: "eks.health.measurement.verified",
  measurementRejected: "eks.health.measurement.rejected",
  measurementSuperseded: "eks.health.measurement.superseded",
  measurementCorrected: "eks.health.measurement.corrected",
  evidenceUploaded: "eks.health.evidence.uploaded",
  evidenceVerified: "eks.health.evidence.verified",
  profileCreated: "eks.health.profile.created",
  profileChanged: "eks.health.profile.changed",
  compositeComputed: "eks.health.composite.computed",
  derivedComputed: "eks.health.derived.computed",
  exportRequested: "eks.health.export.requested",
  exportCompleted: "eks.health.export.completed",
  importCompleted: "eks.health.import.completed",
} as const;

export type HealthEventType = (typeof HEALTH_EVENTS)[keyof typeof HEALTH_EVENTS];

// ---------------------------------------------------------------------------
// Provenance — full traceability for every measurement
// ---------------------------------------------------------------------------

export interface Provenance {
  readonly collectedBy: AccountId; // who collected it
  readonly verifiedBy?: AccountId; // who verified it
  readonly programId?: ProgramId; // which program requested it
  readonly sourceId: SourceId; // measurement source
  readonly deviceId?: string; // device identifier
  readonly collectedAt: string; // ISO timestamp
  readonly location?: { lat: number; lon: number; label?: string }; // if permitted
  readonly consentReference?: string; // consent grant id
  readonly auditReference?: string; // audit entry id
  readonly verificationHistory: VerificationHistoryEntry[];
}

export interface VerificationHistoryEntry {
  readonly state: VerificationState;
  readonly at: string;
  readonly by: AccountId;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Retention policy
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  readonly retentionDays: number; // 0 = forever
  readonly action: "delete" | "anonymize" | "archive";
  readonly jurisdiction?: string; // e.g. "EU" for GDPR overrides
}

export { type TenantId, type AccountId, type OrgId, type ProgramId };
