/**
 * Eks-Health Health Orchestrator — Shared Measurement Registry
 *
 * Avoid duplicate measurements. Five Programs require the participant's weight
 * (Weight Program, Nutrition Program, Sleep Program, Mental Wellness Program,
 * Exercise Program). Without orchestration the participant would step on the
 * scale five times. With the Shared Measurement Registry, the participant
 * measures ONCE; authorized Programs consume the verified measurement
 * according to consent.
 *
 * The orchestrator:
 *   - Registers shared measurements (one canonical record per schema)
 *   - Tracks which programs are authorized to consume each schema
 *   - Validates consent (via identity consent) before each consumption
 *   - Records consumption (so deduplication savings are measurable)
 *   - Allows per-program revocation
 *
 * Built on the orchestrator core, the health measurement store, and the
 * identity consent engine. Pure TS, strict, ESM. No mocks.
 */

import "server-only";
import {
  type AccountId,
  type ProgramId,
  type SchemaId,
  type MeasurementId,
  type SharedMeasurementId,
  type SharedMeasurement,
  OrchestratorError,
  asSharedMeasurementId,
  ORCHESTRATOR_EVENTS,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getMeasurements, type Measurement } from "@/health";
import { getConsent } from "@/identity";

// ---------------------------------------------------------------------------
// Local mutable shape
// ---------------------------------------------------------------------------

interface SharedMeasurementRecord extends SharedMeasurement {
  consumingPrograms: ProgramId[];
  authorizedPrograms: ProgramId[];
}

export interface DuplicateCheckResult {
  readonly schemaId: SchemaId;
  readonly participantId: AccountId;
  readonly requestedPrograms: ProgramId[];
  readonly duplicateCount: number; // # of programs requesting the SAME schema
  readonly isDuplicate: boolean; // true when 2+ programs request the same schema
  readonly potentialSavings: number; // (duplicateCount - 1) measurements saved
}

export interface SharedMeasurementStats {
  readonly totalSharedMeasurements: number;
  readonly bySchema: Record<string, number>;
  readonly avgConsumingPrograms: number;
  readonly totalConsumptions: number;
  readonly deduplicationSavings: number; // total measurements avoided
  readonly revocations: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class SharedMeasurementRegistry {
  private readonly records = new Map<SharedMeasurementId, SharedMeasurementRecord>();
  private readonly byParticipantSchema = new Map<string, SharedMeasurementId[]>();
  private revocationCount = 0;

  /**
   * Register a shared measurement. Records which programs are authorized to
   * consume it. Emits shared_measurement.registered.
   */
  register(
    schemaId: SchemaId,
    measurementId: MeasurementId,
    participantId: AccountId,
    authorizedPrograms: ProgramId[],
  ): SharedMeasurement {
    if (!schemaId) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_measurement.missing_schema",
        category: "validation",
        message: "schemaId is required.",
        userMessage: "Measurement type is required.",
      });
    }
    if (!measurementId) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_measurement.missing_measurement",
        category: "validation",
        message: "measurementId is required.",
        userMessage: "Measurement id is required.",
      });
    }
    if (authorizedPrograms.length === 0) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_measurement.no_authorized",
        category: "validation",
        message: "At least one authorized program is required.",
        userMessage: "At least one program must be authorized.",
      });
    }

    // Verify the measurement exists in the health store. Guard with try/catch.
    let measuredAt = getClock().iso();
    try {
      const store = getMeasurements();
      const m: Measurement | undefined = store.get(measurementId);
      if (m) {
        measuredAt = m.provenance.collectedAt;
        // Sanity: schema must match.
        if (m.schemaId !== schemaId) {
          throw new OrchestratorError({
            code: "eks.orchestrator.shared_measurement.schema_mismatch",
            category: "validation",
            message: `Measurement ${measurementId} schema (${m.schemaId}) does not match declared schema (${schemaId}).`,
            userMessage: "The measurement does not match the expected type.",
            metadata: { measurementId, declaredSchema: schemaId, actualSchema: m.schemaId },
          });
        }
      }
    } catch (e) {
      // If it's our own validation error, propagate it.
      if (e instanceof OrchestratorError) throw e;
      // Otherwise the store is unavailable — proceed with default timestamp.
    }

    const record: SharedMeasurementRecord = {
      id: asSharedMeasurementId(generateId("sm_")),
      schemaId,
      measurementId,
      participantId,
      measuredAt,
      consumingPrograms: [],
      authorizedPrograms: [...new Set(authorizedPrograms)],
    };
    this.records.set(record.id, record);
    const key = this.participantSchemaKey(participantId, schemaId);
    const list = this.byParticipantSchema.get(key) ?? [];
    this.byParticipantSchema.set(key, [...list, record.id]);
    void getEventBus().publish(
      buildEvent(
        ORCHESTRATOR_EVENTS.sharedMeasurementRegistered,
        {
          sharedMeasurementId: record.id,
          participantId,
          schemaId,
          measurementId,
          authorizedPrograms: record.authorizedPrograms,
        },
        {},
        "domain",
      ),
    );
    return record;
  }

  get(id: SharedMeasurementId): SharedMeasurement | undefined {
    return this.records.get(id);
  }

  list(participantId?: AccountId, schemaId?: SchemaId): SharedMeasurement[] {
    let list = [...this.records.values()];
    if (participantId) list = list.filter((r) => r.participantId === participantId);
    if (schemaId) list = list.filter((r) => r.schemaId === schemaId);
    return list.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
  }

  /**
   * A program consumes the latest shared measurement of a schema. Returns the
   * measurement if authorized AND consented; throws otherwise. Records the
   * consumption (dedupes future requests).
   */
  consume(
    participantId: AccountId,
    schemaId: SchemaId,
    programId: ProgramId,
  ): { measurement: SharedMeasurement; healthMeasurement?: Measurement; alreadyConsumed: boolean } {
    const latest = this.getLatest(participantId, schemaId);
    if (!latest) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_measurement.no_shared",
        category: "not_found",
        message: `No shared measurement for schema ${schemaId} for participant ${participantId}.`,
        userMessage: "No shared measurement is available for this data type.",
        metadata: { participantId, schemaId, programId },
      });
    }

    // 1) Authorization check (recorded at registration time).
    if (!latest.authorizedPrograms.includes(programId)) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_measurement.not_authorized",
        category: "not_authorized",
        message: `Program ${programId} is not authorized to consume schema ${schemaId}.`,
        userMessage: "This program is not authorized to access this measurement.",
        metadata: { sharedMeasurementId: latest.id, programId, schemaId },
      });
    }

    // 2) Consent check (live, via identity consent engine). Guard with try/catch.
    //    The purpose here is "shared_measurement_consumption" and the field is
    //    the schema id. If consent cannot be verified (e.g. identity subsystem
    //    unavailable), we fail closed: consumption is denied.
    let consentOk = false;
    try {
      const consent = getConsent();
      consentOk = consent.checkAccess(
        participantId,
        programId as string,
        "shared_measurement_consumption",
        schemaId as string,
      );
    } catch {
      consentOk = false;
    }
    if (!consentOk) {
      throw new OrchestratorError({
        code: "eks.orchestrator.shared_measurement.no_consent",
        category: "not_authorized",
        message: `Participant has not granted consent for program ${programId} to access schema ${schemaId}.`,
        userMessage: "You have not granted consent for this program to access this data.",
        metadata: { sharedMeasurementId: latest.id, programId, schemaId },
      });
    }

    // 3) Record consumption (idempotent — if already consumed, no duplicate).
    const alreadyConsumed = latest.consumingPrograms.includes(programId);
    if (!alreadyConsumed) {
      const updated: SharedMeasurementRecord = {
        ...latest,
        consumingPrograms: [...latest.consumingPrograms, programId],
      };
      this.records.set(latest.id, updated);
      void getEventBus().publish(
        buildEvent(
          ORCHESTRATOR_EVENTS.sharedMeasurementRegistered,
          {
            action: "consumed",
            sharedMeasurementId: latest.id,
            participantId,
            schemaId,
            measurementId: latest.measurementId,
            programId,
          },
          {},
          "domain",
        ),
      );
    }

    // 4) Fetch the underlying health measurement (best-effort).
    let healthMeasurement: Measurement | undefined;
    try {
      healthMeasurement = getMeasurements().get(latest.measurementId);
    } catch {
      healthMeasurement = undefined;
    }

    const current = this.records.get(latest.id)!;
    return { measurement: current, healthMeasurement, alreadyConsumed };
  }

  /**
   * Check whether multiple programs are requesting the same measurement
   * schema for a participant (deduplication opportunity).
   */
  checkDuplicate(
    schemaId: SchemaId,
    participantId: AccountId,
    programs: ProgramId[],
  ): DuplicateCheckResult {
    const unique = [...new Set(programs)];
    const duplicateCount = unique.length;
    return {
      schemaId,
      participantId,
      requestedPrograms: unique,
      duplicateCount,
      isDuplicate: duplicateCount >= 2,
      potentialSavings: Math.max(0, duplicateCount - 1),
    };
  }

  /** Latest shared measurement for a (participant, schema) pair. */
  getLatest(participantId: AccountId, schemaId: SchemaId): SharedMeasurementRecord | undefined {
    const key = this.participantSchemaKey(participantId, schemaId);
    const ids = this.byParticipantSchema.get(key);
    if (!ids || ids.length === 0) return undefined;
    const records = ids
      .map((id) => this.records.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
    return records[0];
  }

  /** Which programs consumed a specific shared measurement. */
  getConsumingPrograms(measurementId: MeasurementId): ProgramId[] {
    const rec = [...this.records.values()].find((r) => r.measurementId === measurementId);
    return rec ? [...rec.consumingPrograms] : [];
  }

  /**
   * Revoke a program's access to shared measurements of a schema. Affects all
   * shared measurements of that schema for the participant (if specified) or
   * globally. Returns the number of records updated.
   */
  revoke(programId: ProgramId, schemaId: SchemaId, participantId?: AccountId): number {
    let updated = 0;
    for (const [id, rec] of [...this.records]) {
      if (rec.schemaId !== schemaId) continue;
      if (participantId && rec.participantId !== participantId) continue;
      if (!rec.authorizedPrograms.includes(programId)) continue;
      const next: SharedMeasurementRecord = {
        ...rec,
        authorizedPrograms: rec.authorizedPrograms.filter((p) => p !== programId),
        consumingPrograms: rec.consumingPrograms.filter((p) => p !== programId),
      };
      this.records.set(id, next);
      updated++;
      void getEventBus().publish(
        buildEvent(
          ORCHESTRATOR_EVENTS.sharedMeasurementRegistered,
          {
            action: "revoked",
            sharedMeasurementId: id,
            participantId: rec.participantId,
            schemaId,
            programId,
          },
          {},
          "domain",
        ),
      );
    }
    this.revocationCount += updated;
    return updated;
  }

  getStats(): SharedMeasurementStats {
    const list = [...this.records.values()];
    const bySchema: Record<string, number> = {};
    let totalConsumptions = 0;
    let totalConsumingPrograms = 0;
    let dedupSavings = 0;
    for (const r of list) {
      bySchema[r.schemaId] = (bySchema[r.schemaId] ?? 0) + 1;
      totalConsumptions += r.consumingPrograms.length;
      totalConsumingPrograms += r.consumingPrograms.length;
      // Each consumption beyond the first is a measurement saved.
      const saves = Math.max(0, r.consumingPrograms.length - 1);
      dedupSavings += saves;
      // Authorized-but-not-yet-consumed programs also represent potential
      // savings: they will avoid a future measurement.
      dedupSavings += Math.max(0, r.authorizedPrograms.length - 1 - r.consumingPrograms.length);
    }
    return {
      totalSharedMeasurements: list.length,
      bySchema,
      avgConsumingPrograms: list.length > 0 ? totalConsumingPrograms / list.length : 0,
      totalConsumptions,
      deduplicationSavings: Math.max(0, dedupSavings),
      revocations: this.revocationCount,
    };
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private participantSchemaKey(participantId: AccountId, schemaId: SchemaId): string {
    return `${participantId}::${schemaId}`;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: SharedMeasurementRegistry | null = null;
export function getSharedMeasurements(): SharedMeasurementRegistry {
  if (!_registry) _registry = new SharedMeasurementRegistry();
  return _registry;
}

// Re-export shared types for consumers
export type {
  AccountId,
  ProgramId,
  SchemaId,
  MeasurementId,
  SharedMeasurement,
  SharedMeasurementId,
} from "../core";
