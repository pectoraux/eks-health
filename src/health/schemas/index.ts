/**
 * Eks-Health Universal Health Data Platform — Measurement Schema Framework
 *
 * Programs define measurement schemas (name, description, units, validation
 * rules, acceptable ranges, precision, collection methods, evidence
 * requirements, verification requirements, visibility, retention, versioning,
 * dependencies, derived/composite metrics). The platform validates and stores
 * them generically — it NEVER hardcodes "weight" or "blood pressure".
 *
 * Schemas are versioned. Old versions remain queryable so historical data is
 * never corrupted by schema evolution.
 */

import "server-only";
import {
  type SchemaId,
  type SchemaVersionId,
  type ProgramId,
  type UnitId,
  type VisibilityLevel,
  type RetentionPolicy,
  type SourceType,
  type EvidenceType,
  type VerificationState,
  HealthError,
  asSchemaId,
  asSchemaVersionId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { HEALTH_EVENTS } from "../core";
import type { UnitDefinition } from "../units";

// ---------------------------------------------------------------------------
// Schema definition (owned by Programs, validated by the platform)
// ---------------------------------------------------------------------------

export interface MeasurementSchema {
  readonly id: SchemaId;
  readonly programId: ProgramId;
  readonly slug: string; // unique within program, e.g. "resting_heart_rate"
  readonly name: string;
  readonly description: string;
  readonly category: string; // program-defined, e.g. "cardiovascular"
  readonly valueType: MeasurementValueType;
  readonly defaultUnit?: UnitId;
  readonly allowedUnits: UnitId[];
  readonly validation: ValidationRules;
  readonly collectionMethods: string[];
  readonly allowedSources: SourceType[];
  readonly requiredEvidence?: EvidenceRequirement[];
  readonly verificationWorkflow: VerificationWorkflow;
  readonly visibility: VisibilityLevel;
  readonly retention: RetentionPolicy;
  readonly tags: string[];
  readonly derivedFrom?: string[]; // schema slugs this derives from
  readonly compositeComponents?: CompositeComponent[]; // if composite
  readonly derivationFormula?: string; // expression for derived/composite
  readonly customAttributes?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MeasurementValueType =
  | "scalar" // single number
  | "categorical" // string from allowed set
  | "boolean"
  | "range" // {min, max}
  | "vector" // {systolic, diastolic} or {x, y, z}
  | "timeseries" // array of {t, v}
  | "structured" // arbitrary JSON object
  | "text";

export interface ValidationRules {
  readonly min?: number;
  readonly max?: number;
  readonly precision?: number; // decimal places
  readonly allowedValues?: string[]; // for categorical
  readonly regex?: string; // for text
  readonly requiredFields?: string[]; // for structured
  readonly unitConsistency?: boolean; // must match allowedUnits
  readonly temporalConstraints?: {
    readonly minIntervalSeconds?: number; // can't record more often than this
    readonly maxAgeHours?: number; // can't backdate beyond this
  };
  readonly outlierDetection?: {
    readonly method: "iqr" | "zscore" | "mad";
    readonly threshold: number;
  };
  readonly custom?: Record<string, unknown>; // program-defined, validated by program
}

export interface EvidenceRequirement {
  readonly type: EvidenceType;
  readonly required: boolean;
  readonly minCount: number;
  readonly description?: string;
}

export interface VerificationWorkflow {
  readonly required: boolean;
  readonly initial: VerificationState;
  readonly verifiedBy: SourceType[]; // who can verify
  readonly autoVerifyIfSource?: SourceType[]; // auto-verify from trusted sources
  readonly expiryDays?: number; // verification expires after N days
  readonly disputeAllowed: boolean;
}

export interface CompositeComponent {
  readonly schemaSlug: string;
  readonly weight?: number;
  readonly transform?: string; // e.g. "normalize", "log", "inverse"
}

// ---------------------------------------------------------------------------
// Schema version (immutable snapshots)
// ---------------------------------------------------------------------------

export interface SchemaVersion {
  readonly id: SchemaVersionId;
  readonly schemaId: SchemaId;
  readonly version: number;
  readonly schema: MeasurementSchema;
  readonly publishedAt: string;
  readonly deprecatedAt?: string;
  readonly successorVersionId?: SchemaVersionId;
  readonly migrationNotes?: string;
}

// ---------------------------------------------------------------------------
// Schema registry
// ---------------------------------------------------------------------------

export class SchemaRegistry {
  private readonly schemas = new Map<SchemaId, MeasurementSchema>();
  private readonly versions = new Map<SchemaVersionId, SchemaVersion>();
  private readonly byProgram = new Map<ProgramId, SchemaId[]>();
  private readonly bySlug = new Map<string, SchemaId>(); // `${programId}:${slug}`

  /** Publish a new schema (or a new version of an existing one). */
  publish(input: Omit<MeasurementSchema, "id" | "createdAt" | "updatedAt">): MeasurementSchema {
    // Validate
    this.validateSchemaInput(input);

    const slugKey = `${input.programId}:${input.slug}`;
    const existing = this.bySlug.get(slugKey);
    const now = getClock().iso();

    let schemaId: SchemaId;
    let version: number;

    if (existing) {
      // New version of existing schema
      const oldSchema = this.schemas.get(existing)!;
      schemaId = existing;
      version = this.countVersions(existing) + 1;
      // Update the schema (the "current" version)
      const updated: MeasurementSchema = {
        ...input,
        id: schemaId,
        createdAt: oldSchema.createdAt,
        updatedAt: now,
      };
      this.schemas.set(schemaId, updated);
      // Deprecate the previous version's snapshot
      const prevVersion = this.findLatestVersion(schemaId);
      if (prevVersion) {
        this.versions.set(prevVersion.id, { ...prevVersion, deprecatedAt: now, successorVersionId: undefined });
      }
      // Create a new immutable version snapshot
      const newVersion: SchemaVersion = {
        id: asSchemaVersionId(generateId("schver_")),
        schemaId,
        version,
        schema: updated,
        publishedAt: now,
      };
      this.versions.set(newVersion.id, newVersion);
      void getEventBus().publish(buildEvent(HEALTH_EVENTS.schemaUpdated, { schemaId, version, programId: input.programId }, {}, "domain"));
      return updated;
    }

    // New schema
    schemaId = asSchemaId(generateId("sch_"));
    version = 1;
    const schema: MeasurementSchema = {
      ...input,
      id: schemaId,
      createdAt: now,
      updatedAt: now,
    };
    this.schemas.set(schemaId, schema);
    this.bySlug.set(slugKey, schemaId);
    const pList = this.byProgram.get(input.programId) ?? [];
    this.byProgram.set(input.programId, [...pList, schemaId]);
    const v1: SchemaVersion = {
      id: asSchemaVersionId(generateId("schver_")),
      schemaId,
      version,
      schema,
      publishedAt: now,
    };
    this.versions.set(v1.id, v1);
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.schemaPublished, { schemaId, slug: input.slug, programId: input.programId, version }, {}, "domain"));
    return schema;
  }

  /** Deprecate a schema (no new measurements, historical data preserved). */
  deprecate(schemaId: SchemaId, reason: string): void {
    const schema = this.schemas.get(schemaId);
    if (!schema) throw new HealthError({ code: "eks.health.schema.not_found", category: "not_found", message: "Schema not found." });
    this.schemas.set(schemaId, { ...schema, updatedAt: getClock().iso() });
    const latest = this.findLatestVersion(schemaId);
    if (latest) {
      this.versions.set(latest.id, { ...latest, deprecatedAt: getClock().iso(), migrationNotes: reason });
    }
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.schemaDeprecated, { schemaId, reason }, {}, "domain"));
  }

  get(schemaId: SchemaId): MeasurementSchema | undefined {
    return this.schemas.get(schemaId);
  }

  getBySlug(programId: ProgramId, slug: string): MeasurementSchema | undefined {
    const id = this.bySlug.get(`${programId}:${slug}`);
    return id ? this.schemas.get(id) : undefined;
  }

  list(filter?: { programId?: ProgramId; category?: string }): MeasurementSchema[] {
    let list = [...this.schemas.values()];
    if (filter?.programId) list = list.filter((s) => s.programId === filter.programId);
    if (filter?.category) list = list.filter((s) => s.category === filter.category);
    return list;
  }

  listByProgram(programId: ProgramId): MeasurementSchema[] {
    return (this.byProgram.get(programId) ?? []).map((id) => this.schemas.get(id)!).filter(Boolean);
  }

  getVersion(versionId: SchemaVersionId): SchemaVersion | undefined {
    return this.versions.get(versionId);
  }

  getVersionHistory(schemaId: SchemaId): SchemaVersion[] {
    return [...this.versions.values()]
      .filter((v) => v.schemaId === schemaId)
      .sort((a, b) => a.version - b.version);
  }

  /** Resolve the unit definitions for a schema (delegates to units module). */
  resolveUnits(schema: MeasurementSchema, units: UnitDefinition[]): UnitDefinition[] {
    return schema.allowedUnits
      .map((uid) => units.find((u) => u.id === uid))
      .filter((u): u is UnitDefinition => !!u);
  }

  private validateSchemaInput(input: Omit<MeasurementSchema, "id" | "createdAt" | "updatedAt">): void {
    if (!input.slug || !/^[a-z0-9_]+$/.test(input.slug)) {
      throw new HealthError({ code: "eks.health.schema.invalid_slug", category: "schema_invalid", message: "Slug must be lowercase snake_case.", userMessage: "Invalid schema slug." });
    }
    if (!input.name) {
      throw new HealthError({ code: "eks.health.schema.missing_name", category: "schema_invalid", message: "Name required." });
    }
    if (!input.programId) {
      throw new HealthError({ code: "eks.health.schema.missing_program", category: "schema_invalid", message: "Program ID required." });
    }
    if (input.valueType === "scalar" && input.validation.min !== undefined && input.validation.max !== undefined && input.validation.min > input.validation.max) {
      throw new HealthError({ code: "eks.health.schema.invalid_range", category: "schema_invalid", message: "min > max.", userMessage: "Validation range is invalid." });
    }
    if (input.valueType === "categorical" && (!input.validation.allowedValues || input.validation.allowedValues.length === 0)) {
      throw new HealthError({ code: "eks.health.schema.no_allowed_values", category: "schema_invalid", message: "Categorical schema requires allowedValues." });
    }
    if (input.valueType !== "categorical" && input.validation.allowedValues && input.validation.allowedValues.length > 0) {
      throw new HealthError({ code: "eks.health.schema.unexpected_allowed_values", category: "schema_invalid", message: "allowedValues only valid for categorical." });
    }
  }

  private countVersions(schemaId: SchemaId): number {
    return [...this.versions.values()].filter((v) => v.schemaId === schemaId).length;
  }

  private findLatestVersion(schemaId: SchemaId): SchemaVersion | undefined {
    const versions = this.getVersionHistory(schemaId);
    return versions[versions.length - 1];
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _registry: SchemaRegistry | null = null;
export function getSchemas(): SchemaRegistry {
  if (!_registry) _registry = new SchemaRegistry();
  return _registry;
}
