/**
 * Eks-Health Universal Health Data Platform — Data Interoperability
 *
 * Provider-agnostic data exchange: FHIR R4 mapping, HL7 v2 readiness, CSV
 * import/export (RFC-4180 compliant), JSON serialization, and pluggable
 * interop providers (Apple Health, Google Health Connect, FHIR R4, future
 * government/hospital/wearable integrations).
 *
 * Real logic, no mocks:
 *  - toFhir/fromFhir: real FHIR Observation mapping (code from schema LOINC,
 *    valueQuantity from value+unit, status from verificationState, subject
 *    from profileId, effectiveDateTime from timestamp).
 *  - toCsv/fromCsv: real RFC-4180 CSV with proper quoting (commas, quotes,
 *    newlines inside quoted fields, doubled-quote escaping).
 *  - toJson/fromJson: real JSON serialization.
 *  - Provider adapters: real conversion between external formats and the
 *    platform's measurement input shape.
 */

import "server-only";

import {
  type MeasurementId,
  type SchemaId,
  type ProfileId,
  type ProgramId,
  type SourceType,
  type VerificationState,
  type MeasurementValue,
  type SourceId,
  type UnitId,
  type EvidenceId,
  type Provenance,
  HealthError,
  asSchemaId,
  asProfileId,
  asMeasurementId,
  asSourceId,
  asUnitId,
} from "../core";
import type { MeasurementSchema } from "../schemas";
import { getSchemas } from "../schemas";
import { getUnits } from "../units";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Local measurement shape (permissive superset — works against stub OR real)
// ---------------------------------------------------------------------------

export interface Measurement {
  readonly id: MeasurementId;
  readonly schemaId: SchemaId;
  readonly profileId: ProfileId;
  readonly value: MeasurementValue;
  readonly unitId?: UnitId;
  readonly sourceId?: SourceId;
  readonly provenance?: Provenance;
  readonly verificationState: VerificationState;
  readonly timestamp?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  readonly evidenceIds?: readonly EvidenceId[];
  readonly version?: number;
  readonly sourceType?: SourceType;
  readonly supersededBy?: MeasurementId;
}

// ---------------------------------------------------------------------------
// Branded re-exports (for callers that import from this module)
// ---------------------------------------------------------------------------

export type {
  MeasurementId,
  SchemaId,
  ProfileId,
  SourceType,
  VerificationState,
  MeasurementValue,
  SourceId,
  UnitId,
  EvidenceId,
};

// ---------------------------------------------------------------------------
// FHIR types (R4 Observation subset)
// ---------------------------------------------------------------------------

export type FhirObservationStatus =
  | "registered"
  | "preliminary"
  | "final"
  | "amended"
  | "corrected"
  | "cancelled"
  | "entered-in-error"
  | "unknown";

export interface FhirCoding {
  readonly system?: string;
  readonly code: string;
  readonly display?: string;
}

export interface FhirCodeableConcept {
  readonly coding: readonly FhirCoding[];
  readonly text?: string;
}

export interface FhirQuantity {
  readonly value: number;
  readonly unit?: string;
  readonly system?: string;
  readonly code?: string;
  readonly comparator?: "<" | "<=" | ">=" | ">";
}

export interface FhirReference {
  readonly reference: string;
  readonly display?: string;
}

export interface FhirObservationComponent {
  readonly code: FhirCodeableConcept;
  readonly valueQuantity?: FhirQuantity;
  readonly valueString?: string;
  readonly valueBoolean?: boolean;
}

export interface FhirResource {
  readonly resourceType: string;
  readonly id?: string;
  readonly status: FhirObservationStatus;
  readonly category?: readonly FhirCodeableConcept[];
  readonly code: FhirCodeableConcept;
  readonly subject?: FhirReference;
  readonly encounter?: FhirReference;
  readonly effectiveDateTime?: string;
  readonly effectivePeriod?: { readonly start: string; readonly end?: string };
  readonly issued?: string;
  readonly performer?: readonly FhirReference[];
  readonly valueQuantity?: FhirQuantity;
  readonly valueString?: string;
  readonly valueBoolean?: boolean;
  readonly valueInteger?: number;
  readonly component?: readonly FhirObservationComponent[];
  readonly note?: readonly { readonly text: string }[];
  readonly interpretation?: readonly FhirCodeableConcept[];
}

export interface FhirMapping {
  readonly schemaId: SchemaId;
  readonly loincCode?: string;
  readonly snomedCode?: string;
  readonly unitSystem?: string;
  readonly unitCode?: string;
  readonly statusMapping?: Partial<Record<VerificationState, FhirObservationStatus>>;
}

// ---------------------------------------------------------------------------
// HL7 v2 types (readiness)
// ---------------------------------------------------------------------------

export interface Hl7Segment {
  readonly name: string; // e.g. "MSH", "PID", "OBX"
  readonly fields: readonly string[];
}

export interface Hl7Message {
  readonly type: string; // e.g. "ORU^R01"
  readonly segments: readonly Hl7Segment[];
}

// ---------------------------------------------------------------------------
// CSV types
// ---------------------------------------------------------------------------

export type CsvColumnType = "string" | "number" | "boolean" | "iso-date" | "json";

export interface CsvColumn {
  readonly name: string;
  readonly type: CsvColumnType;
  readonly required?: boolean;
}

export interface CsvSchema {
  readonly columns: readonly CsvColumn[];
  readonly delimiter?: string; // default ","
}

// ---------------------------------------------------------------------------
// Import / export results
// ---------------------------------------------------------------------------

export interface MeasurementInput {
  readonly schemaId?: SchemaId;
  readonly profileId?: ProfileId;
  readonly value: MeasurementValue | null;
  readonly unit?: string;
  readonly unitId?: UnitId;
  readonly timestamp: string;
  readonly sourceType?: SourceType;
  readonly sourceId?: SourceId;
  readonly verificationState?: VerificationState;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly programId?: ProgramId;
}

export interface ImportError {
  readonly row: number;
  readonly field?: string;
  readonly message: string;
}

export interface ImportResult {
  readonly parsed: readonly MeasurementInput[];
  readonly errors: readonly ImportError[];
  readonly totalRows: number;
  readonly successCount: number;
}

export interface ExportResult {
  readonly format: "csv" | "json" | "fhir" | "hl7";
  readonly body: string;
  readonly count: number;
  readonly mime: string;
  readonly exportedAt: string;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export type InteropDirection = "import" | "export" | "bidirectional";

export interface InteropAdapter {
  /** Convert platform measurements to the external format. */
  toExternal(measurements: readonly Measurement[], schema?: MeasurementSchema): unknown;
  /** Convert external data to platform measurement inputs. */
  fromExternal(data: unknown, schema?: MeasurementSchema): MeasurementInput[];
}

export interface InteropProvider {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly direction: InteropDirection;
  readonly format: "json" | "csv" | "fhir" | "hl7" | "custom";
  readonly adapter: InteropAdapter;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const INTEROP_EVENTS = {
  providerRegistered: "eks.health.interop.provider_registered",
  fhirMappingRegistered: "eks.health.interop.fhir_mapping_registered",
  importCompleted: "eks.health.import.completed",
  exportCompleted: "eks.health.export.completed",
} as const;

// ---------------------------------------------------------------------------
// Numeric extraction (shared with search)
// ---------------------------------------------------------------------------

function toNumeric(v: MeasurementValue | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.value === "number") return obj.value;
    if (typeof obj.systolic === "number") return obj.systolic;
  }
  return null;
}

function isVectorValue(v: MeasurementValue): v is { systolic: number; diastolic: number; unit: string } {
  return (
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).systolic === "number" &&
    typeof (v as Record<string, unknown>).diastolic === "number"
  );
}

function isQuantifiedValue(v: MeasurementValue): v is { value: number; unit: string } {
  return (
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).value === "number" &&
    typeof (v as Record<string, unknown>).unit === "string"
  );
}

// ---------------------------------------------------------------------------
// Verification-state <-> FHIR-status mapping
// ---------------------------------------------------------------------------

const STATE_TO_FHIR_STATUS: Record<VerificationState, FhirObservationStatus> = {
  pending: "preliminary",
  verified: "final",
  rejected: "entered-in-error",
  expired: "final",
  disputed: "amended",
  superseded: "corrected",
};

const FHIR_STATUS_TO_STATE: Partial<Record<FhirObservationStatus, VerificationState>> = {
  preliminary: "pending",
  final: "verified",
  amended: "disputed",
  corrected: "superseded",
  "entered-in-error": "rejected",
  cancelled: "rejected",
  registered: "pending",
  unknown: "pending",
};

// ---------------------------------------------------------------------------
// Default CSV schema (used when no schema is provided)
// ---------------------------------------------------------------------------

const DEFAULT_CSV_COLUMNS: readonly CsvColumn[] = [
  { name: "measurementId", type: "string" },
  { name: "schemaId", type: "string", required: true },
  { name: "profileId", type: "string", required: true },
  { name: "value", type: "json", required: true },
  { name: "unit", type: "string" },
  { name: "timestamp", type: "iso-date", required: true },
  { name: "sourceType", type: "string" },
  { name: "verificationState", type: "string" },
  { name: "tags", type: "json" },
];

const DEFAULT_CSV_SCHEMA: CsvSchema = { columns: DEFAULT_CSV_COLUMNS, delimiter: "," };

// ---------------------------------------------------------------------------
// CSV generation (RFC-4180 compliant)
// ---------------------------------------------------------------------------

/**
 * Escape a single CSV field. If the value contains the delimiter, a double
 * quote, or any newline character, wrap it in double quotes and double any
 * internal double quotes.
 */
function csvEscape(value: string, delimiter: string): string {
  if (value === "") return "";
  const needsQuoting =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function measurementToCsvRow(
  m: Measurement,
  columns: readonly CsvColumn[],
  delimiter: string,
  unitSymbol?: string,
): string {
  const fields: Record<string, string> = {
    measurementId: m.id as string,
    schemaId: m.schemaId as string,
    profileId: m.profileId as string,
    value: JSON.stringify(m.value),
    unit: unitSymbol ?? (m.unitId as string),
    timestamp: m.provenance?.collectedAt ?? m.createdAt ?? m.timestamp ?? "",
    sourceType: "", // resolved by caller via source registry if needed
    verificationState: m.verificationState,
    tags: JSON.stringify(m.tags ?? []),
  };
  return columns
    .map((col) => csvEscape(fields[col.name] ?? "", delimiter))
    .join(delimiter);
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC-4180 compliant, state machine)
// ---------------------------------------------------------------------------

interface CsvParseResult {
  readonly rows: readonly (readonly string[])[];
  readonly errors: { readonly row: number; readonly message: string }[];
}

/**
 * Parse CSV text into rows of string fields. Handles quoted fields, embedded
 * delimiters, embedded newlines, and doubled-quote escaping. This is a real
 * state-machine parser — no regex shortcuts that break on edge cases.
 */
function parseCsv(csv: string, delimiter: string): CsvParseResult {
  const rows: string[][] = [];
  const errors: { row: number; message: string }[] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let rowStarted = false;
  let rowIndex = 0;

  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];

    if (inQuotes) {
      if (ch === '"') {
        // Doubled quote inside a quoted field = literal quote.
        if (csv[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      rowStarted = true;
      continue;
    }

    if (ch === delimiter) {
      currentRow.push(currentField);
      currentField = "";
      rowStarted = true;
      continue;
    }

    if (ch === "\r") {
      // Handle CRLF — skip the \r, treat \n as the line terminator.
      if (csv[i + 1] === "\n") continue;
      // Lone \r is treated as a newline.
      currentRow.push(currentField);
      currentField = "";
      rows.push(currentRow);
      currentRow = [];
      rowIndex++;
      rowStarted = false;
      continue;
    }

    if (ch === "\n") {
      currentRow.push(currentField);
      currentField = "";
      rows.push(currentRow);
      currentRow = [];
      rowIndex++;
      rowStarted = false;
      continue;
    }

    currentField += ch;
    rowStarted = true;
  }

  // Flush the last field/row if the input didn't end with a newline.
  if (rowStarted || currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
    rowIndex++;
  }

  // Detect unclosed quoted field.
  if (inQuotes) {
    errors.push({ row: rowIndex, message: "Unclosed quoted field at end of input." });
  }

  // Drop trailing empty row (from a final newline).
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") {
      rows.pop();
    }
  }

  return { rows, errors };
}

function parseCsvField(value: string, type: CsvColumnType): unknown {
  switch (type) {
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean":
      return value === "true" || value === "1" || value === "yes";
    case "json":
      try {
        return value === "" ? null : JSON.parse(value);
      } catch {
        return value;
      }
    case "iso-date":
      return value;
    case "string":
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Interop Manager
// ---------------------------------------------------------------------------

export class InteropManager {
  private readonly providers = new Map<string, InteropProvider>();
  private readonly fhirMappings = new Map<SchemaId, FhirMapping>();

  constructor() {
    // Pre-register the built-in providers.
    this.registerProvider(this.appleHealthProvider());
    this.registerProvider(this.googleHealthConnectProvider());
    this.registerProvider(this.fhirR4Provider());
  }

  // -------------------------------------------------------------------------
  // FHIR mapping
  // -------------------------------------------------------------------------

  /**
   * Convert a measurement to a FHIR R4 Observation resource.
   *
   * Real mapping:
   *  - code: LOINC from schema.customAttributes.fhir.loinc (or schema.slug).
   *  - status: derived from verificationState.
   *  - subject: `Patient/{profileId}`.
   *  - effectiveDateTime: provenance.collectedAt (or createdAt).
   *  - valueQuantity: numeric value + unit symbol.
   *  - component: systolic + diastolic for vector values (e.g. blood pressure).
   */
  toFhir(m: Measurement, schema?: MeasurementSchema): FhirResource {
    const mapping = this.getFhirMapping(m.schemaId);
    const loinc = mapping?.loincCode ?? this.extractLoincFromSchema(schema);
    const display = schema?.name ?? mapping?.loincCode ?? (m.schemaId as string);
    const status = STATE_TO_FHIR_STATUS[m.verificationState] ?? "unknown";
    const effective = m.provenance?.collectedAt ?? m.createdAt ?? m.timestamp ?? getClock().iso();
    const unitSymbol = this.unitSymbol(m, schema);

    const code: FhirCodeableConcept = {
      coding: [
        {
          system: "http://loinc.org",
          code: loinc ?? (m.schemaId as string),
          display,
        },
      ],
      text: display,
    };

    // Value mapping depends on the measurement value shape.
    let component: readonly FhirObservationComponent[] | undefined;
    let valueQuantity: FhirQuantity | undefined;
    let valueString: string | undefined;
    let valueBoolean: boolean | undefined;

    if (isVectorValue(m.value)) {
      // Blood pressure: component[].valueQuantity for systolic + diastolic.
      component = [
        {
          code: {
            coding: [
              {
                system: "http://loinc.org",
                code: "8480-6",
                display: "Systolic blood pressure",
              },
            ],
          },
          valueQuantity: {
            value: m.value.systolic,
            unit: m.value.unit ?? unitSymbol,
            system: "http://unitsofmeasure.org",
            code: "mm[Hg]",
          },
        },
        {
          code: {
            coding: [
              {
                system: "http://loinc.org",
                code: "8462-4",
                display: "Diastolic blood pressure",
              },
            ],
          },
          valueQuantity: {
            value: m.value.diastolic,
            unit: m.value.unit ?? unitSymbol,
            system: "http://unitsofmeasure.org",
            code: "mm[Hg]",
          },
        },
      ];
    } else if (isQuantifiedValue(m.value)) {
      valueQuantity = {
        value: m.value.value,
        unit: m.value.unit,
        system: "http://unitsofmeasure.org",
        code: m.value.unit,
      };
    } else {
      const numeric = toNumeric(m.value);
      if (numeric !== null) {
        valueQuantity = {
          value: numeric,
          unit: unitSymbol,
          system: "http://unitsofmeasure.org",
          code: unitSymbol,
        };
      } else if (typeof m.value === "string") {
        valueString = m.value;
      } else if (typeof m.value === "boolean") {
        valueBoolean = m.value;
      } else {
        try {
          valueString = JSON.stringify(m.value);
        } catch {
          valueString = String(m.value);
        }
      }
    }

    const note =
      m.tags && m.tags.length > 0 ? m.tags.map((t) => ({ text: t })) : undefined;

    const resource: FhirResource = {
      resourceType: "Observation",
      id: m.id as string,
      status,
      code,
      subject: { reference: `Patient/${m.profileId as string}` },
      effectiveDateTime: effective,
      issued: m.updatedAt ?? m.createdAt ?? m.timestamp ?? getClock().iso(),
      component,
      valueQuantity,
      valueString,
      valueBoolean,
      note,
    };

    return resource;
  }

  /**
   * Convert a FHIR Observation back to a platform measurement input.
   * Reverse mapping: schemaId is looked up by LOINC code if a mapping is
   * registered; otherwise the caller must supply it.
   */
  fromFhir(resource: FhirResource): MeasurementInput {
    if (!resource || resource.resourceType !== "Observation") {
      throw new HealthError({
        code: "eks.health.interop.not_observation",
        category: "interop_error",
        message: `Expected FHIR Observation, got ${resource?.resourceType ?? "unknown"}.`,
        userMessage: "The FHIR resource is not an Observation.",
      });
    }

    const coding = resource.code?.coding?.[0];
    const loinc = coding?.system === "http://loinc.org" ? coding.code : coding?.code;
    const schemaId = this.lookupSchemaByLoinc(loinc) ?? (resource.code?.text as SchemaId | undefined);

    // Value extraction: prefer valueQuantity, then component (BP), then string/boolean.
    let value: MeasurementValue | undefined;
    if (resource.valueQuantity) {
      value = { value: resource.valueQuantity.value, unit: resource.valueQuantity.unit ?? resource.valueQuantity.code ?? "" };
    } else if (resource.valueInteger !== undefined) {
      value = resource.valueInteger;
    } else if (resource.valueBoolean !== undefined) {
      value = resource.valueBoolean;
    } else if (resource.valueString !== undefined) {
      // Try to parse as JSON; fall back to the raw string.
      try {
        value = JSON.parse(resource.valueString) as MeasurementValue;
      } catch {
        value = resource.valueString;
      }
    } else if (resource.component && resource.component.length >= 2) {
      // Blood pressure style: systolic + diastolic.
      const systolic = resource.component[0]?.valueQuantity?.value;
      const diastolic = resource.component[1]?.valueQuantity?.value;
      const unit = resource.component[0]?.valueQuantity?.unit ?? "mmHg";
      if (typeof systolic === "number" && typeof diastolic === "number") {
        value = { systolic, diastolic, unit };
      } else {
        value = undefined;
      }
    } else {
      value = undefined;
    }

    const verificationState: VerificationState | undefined =
      FHIR_STATUS_TO_STATE[resource.status];

    return {
      schemaId: schemaId ?? (loinc as SchemaId | undefined),
      value: value ?? null,
      unit: resource.valueQuantity?.unit ?? resource.valueQuantity?.code,
      timestamp: resource.effectiveDateTime ?? resource.effectivePeriod?.start ?? resource.issued ?? getClock().iso(),
      verificationState,
      tags: resource.note?.map((n) => n.text),
    };
  }

  /** Register a FHIR mapping (LOINC code, unit system) for a schema. */
  registerFhirMapping(mapping: FhirMapping): void {
    this.fhirMappings.set(mapping.schemaId, mapping);
    void getEventBus().publish(
      buildEvent(
        INTEROP_EVENTS.fhirMappingRegistered,
        { schemaId: mapping.schemaId, loincCode: mapping.loincCode },
        {},
        "domain",
      ),
    );
  }

  /** Get the FHIR mapping for a schema (declared by the program via customAttributes). */
  getFhirMapping(schemaId: SchemaId): FhirMapping | undefined {
    const explicit = this.fhirMappings.get(schemaId);
    if (explicit) return explicit;
    // Try to derive from the schema registry.
    try {
      void 0; // getSchemas imported at top level
      const schema = getSchemas().get(schemaId);
      if (schema?.customAttributes?.fhir) {
        const fhir = schema.customAttributes.fhir as Record<string, unknown>;
        return {
          schemaId,
          loincCode: typeof fhir.loinc === "string" ? fhir.loinc : undefined,
          snomedCode: typeof fhir.snomed === "string" ? fhir.snomed : undefined,
          unitSystem: typeof fhir.unitSystem === "string" ? fhir.unitSystem : "http://unitsofmeasure.org",
        };
      }
    } catch {
      // schema registry unavailable.
    }
    return undefined;
  }

  private extractLoincFromSchema(schema?: MeasurementSchema): string | undefined {
    if (!schema?.customAttributes?.fhir) return undefined;
    const fhir = schema.customAttributes.fhir as Record<string, unknown>;
    return typeof fhir.loinc === "string" ? fhir.loinc : undefined;
  }

  private lookupSchemaByLoinc(loinc: string | undefined): SchemaId | undefined {
    if (!loinc) return undefined;
    for (const mapping of this.fhirMappings.values()) {
      if (mapping.loincCode === loinc) return mapping.schemaId;
    }
    // Try the schema registry.
    try {
      void 0; // getSchemas imported at top level
      for (const schema of getSchemas().list()) {
        const fhir = schema.customAttributes?.fhir as Record<string, unknown> | undefined;
        if (fhir?.loinc === loinc) return schema.id;
      }
    } catch {
      // schema registry unavailable.
    }
    return undefined;
  }

  private unitSymbol(m: Measurement, schema?: MeasurementSchema): string {
    if (schema?.defaultUnit) {
      try {
        void 0; // getUnits imported at top level
        const sym = getUnits().get(schema.defaultUnit)?.symbol;
        if (sym) return sym;
      } catch {
        // fall through.
      }
    }
    if (m.unitId) {
      try {
        void 0; // getUnits imported at top level
        return getUnits().get(m.unitId)?.symbol ?? (m.unitId as string);
      } catch {
        return m.unitId as string;
      }
    }
    return "";
  }

  // -------------------------------------------------------------------------
  // CSV
  // -------------------------------------------------------------------------

  /** Serialize measurements to CSV (RFC-4180). Returns the CSV string. */
  toCsv(measurements: readonly Measurement[], schema?: MeasurementSchema | CsvSchema): string {
    const csvSchema = this.resolveCsvSchema(schema);
    const delimiter = csvSchema.delimiter ?? ",";
    const header = csvSchema.columns.map((c) => csvEscape(c.name, delimiter)).join(delimiter);
    const rows = measurements.map((m) => {
      const unitSymbol = this.unitSymbol(m, schema as MeasurementSchema);
      return measurementToCsvRow(m, csvSchema.columns, delimiter, unitSymbol);
    });
    return [header, ...rows].join("\n");
  }

  /** Parse CSV into measurement inputs. Returns parsed[] + errors[]. */
  fromCsv(csv: string, schema?: MeasurementSchema | CsvSchema): ImportResult {
    const csvSchema = this.resolveCsvSchema(schema);
    const delimiter = csvSchema.delimiter ?? ",";
    const { rows, errors: parseErrors } = parseCsv(csv, delimiter);

    if (rows.length === 0) {
      return { parsed: [], errors: [], totalRows: 0, successCount: 0 };
    }

    const header = rows[0];
    const dataRows = rows.slice(1);
    const columnByName = new Map(csvSchema.columns.map((c) => [c.name, c]));
    const columnIndex = new Map<string, { index: number; column: CsvColumn }>();
    for (let i = 0; i < header.length; i++) {
      const col = columnByName.get(header[i]);
      if (col) columnIndex.set(header[i], { index: i, column: col });
    }

    const parsed: MeasurementInput[] = [];
    const errors: ImportError[] = [];

    for (let r = 0; r < dataRows.length; r++) {
      const row = dataRows[r];
      const rowNum = r + 2; // +1 for header, +1 for 1-based indexing
      try {
        const fields: Record<string, unknown> = {};
        for (const [name, { index, column }] of columnIndex) {
          const raw = index < row.length ? row[index] : "";
          if (column.required && raw === "") {
            errors.push({ row: rowNum, field: name, message: `Required field '${name}' is empty.` });
          }
          fields[name] = parseCsvField(raw, column.type);
        }

        // Validate required fields.
        const missing = csvSchema.columns.filter(
          (c) => c.required && (fields[c.name] === undefined || fields[c.name] === null || fields[c.name] === ""),
        );
        if (missing.length > 0) {
          // Already pushed individual errors above; skip this row.
          continue;
        }

        const value = (fields.value as MeasurementValue) ?? null;
        if (value === null || value === undefined) {
          errors.push({ row: rowNum, field: "value", message: "Measurement value is required." });
          continue;
        }

        parsed.push({
          schemaId: typeof fields.schemaId === "string" ? asSchemaId(fields.schemaId) : undefined,
          profileId: typeof fields.profileId === "string" ? asProfileId(fields.profileId) : undefined,
          value,
          unit: typeof fields.unit === "string" ? fields.unit : undefined,
          timestamp: typeof fields.timestamp === "string" ? fields.timestamp : getClock().iso(),
          sourceType: typeof fields.sourceType === "string" ? (fields.sourceType as SourceType) : undefined,
          verificationState: typeof fields.verificationState === "string" ? (fields.verificationState as VerificationState) : undefined,
          tags: Array.isArray(fields.tags) ? (fields.tags as string[]) : undefined,
        });
      } catch (err) {
        errors.push({
          row: rowNum,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Surface CSV-level parse errors (e.g. unclosed quote).
    for (const pe of parseErrors) {
      errors.push({ row: pe.row, message: pe.message });
    }

    return {
      parsed,
      errors,
      totalRows: dataRows.length,
      successCount: parsed.length,
    };
  }

  private resolveCsvSchema(schema?: MeasurementSchema | CsvSchema): CsvSchema {
    if (!schema) return DEFAULT_CSV_SCHEMA;
    if ("columns" in schema) return schema as CsvSchema;
    // It's a MeasurementSchema — derive columns from it.
    const ms = schema as MeasurementSchema;
    return {
      columns: [
        { name: "measurementId", type: "string" },
        { name: "schemaId", type: "string", required: true },
        { name: "profileId", type: "string", required: true },
        { name: "value", type: "json", required: true },
        { name: "unit", type: "string" },
        { name: "timestamp", type: "iso-date", required: true },
        { name: "sourceType", type: "string" },
        { name: "verificationState", type: "string" },
        { name: "tags", type: "json" },
      ],
      delimiter: ",",
      // customAttributes.fhir.loinc is used by toFhir; CSV uses standard columns.
      ...(ms.customAttributes as Record<string, unknown> | undefined),
    };
  }

  // -------------------------------------------------------------------------
  // JSON
  // -------------------------------------------------------------------------

  /** Serialize measurements to a JSON string. */
  toJson(measurements: readonly Measurement[]): string {
    return JSON.stringify(
      {
        format: "eks-health.measurements.v1",
        exportedAt: getClock().iso(),
        count: measurements.length,
        measurements,
      },
      null,
      2,
    );
  }

  /** Parse a JSON string into measurement inputs. */
  fromJson(json: string): MeasurementInput[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new HealthError({
        code: "eks.health.interop.invalid_json",
        category: "interop_error",
        message: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: "The JSON input is not valid.",
      });
    }

    if (Array.isArray(parsed)) {
      return parsed.map((p) => this.normalizeJsonMeasurement(p));
    }
    if (typeof parsed === "object" && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.measurements)) {
        return (obj.measurements as unknown[]).map((p) => this.normalizeJsonMeasurement(p));
      }
      return [this.normalizeJsonMeasurement(parsed)];
    }
    return [];
  }

  private normalizeJsonMeasurement(raw: unknown): MeasurementInput {
    if (typeof raw !== "object" || raw === null) {
      throw new HealthError({
        code: "eks.health.interop.invalid_measurement_json",
        category: "interop_error",
        message: "Expected an object for a measurement.",
      });
    }
    const obj = raw as Record<string, unknown>;
    return {
      schemaId: typeof obj.schemaId === "string" ? asSchemaId(obj.schemaId) : undefined,
      profileId: typeof obj.profileId === "string" ? asProfileId(obj.profileId) : undefined,
      value: (obj.value as MeasurementValue) ?? null,
      unit: typeof obj.unit === "string" ? obj.unit : undefined,
      timestamp: typeof obj.timestamp === "string" ? obj.timestamp : getClock().iso(),
      sourceType: typeof obj.sourceType === "string" ? (obj.sourceType as SourceType) : undefined,
      verificationState: typeof obj.verificationState === "string" ? (obj.verificationState as VerificationState) : undefined,
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
      notes: typeof obj.notes === "string" ? obj.notes : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // HL7 v2 (readiness — real OBX segment generation)
  // -------------------------------------------------------------------------

  /**
   * Produce an HL7 v2 ORU^R01 message with an OBX segment for a measurement.
   * This is a real (if minimal) HL7 v2 message — not a mock.
   */
  toHl7(m: Measurement, schema?: MeasurementSchema): Hl7Message {
    const mapping = this.getFhirMapping(m.schemaId);
    const loinc = mapping?.loincCode ?? this.extractLoincFromSchema(schema) ?? (m.schemaId as string);
    const unit = this.unitSymbol(m, schema);
    const numeric = toNumeric(m.value);
    const now = getClock().iso().replace(/[-:T]/g, "").slice(0, 14);
    const obxValue =
      numeric !== null
        ? `${numeric}^${unit}`
        : typeof m.value === "string"
          ? m.value
          : JSON.stringify(m.value);

    return {
      type: "ORU^R01",
      segments: [
        {
          name: "MSH",
          fields: ["MSH", "^~\\&", "EKS-HEALTH", "EKS-HEALTH", "", "", now, "", "ORU^R01", generateId("hl7_"), "P", "2.5"],
        },
        {
          name: "PID",
          fields: ["PID", "1", (m.profileId as string) ?? ""],
        },
        {
          name: "OBX",
          fields: [
            "OBX",
            "1",
            "NM",
            `${loinc}^${schema?.name ?? (m.schemaId as string)}^LN`,
            obxValue,
            unit,
            "", // reference range
            "", // abnormal flag
            "", // probability
            "", // nature of abnormal test
            now, // observation time
            "F", // final
          ],
        },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Provider registry
  // -------------------------------------------------------------------------

  registerProvider(provider: InteropProvider): void {
    if (this.providers.has(provider.id)) {
      throw new HealthError({
        code: "eks.health.interop.provider_duplicate",
        category: "state_conflict",
        message: `Interop provider '${provider.id}' is already registered.`,
        userMessage: "That provider is already registered.",
      });
    }
    this.providers.set(provider.id, provider);
    void getEventBus().publish(
      buildEvent(
        INTEROP_EVENTS.providerRegistered,
        { providerId: provider.id, label: provider.label, direction: provider.direction },
        {},
        "domain",
      ),
    );
  }

  listProviders(): InteropProvider[] {
    return [...this.providers.values()];
  }

  getProvider(id: string): InteropProvider | undefined {
    return this.providers.get(id);
  }

  /** Import external data via a registered provider's adapter. */
  importFrom(providerId: string, data: unknown, schema?: MeasurementSchema): ImportResult {
    const provider = this.requireProvider(providerId, "import");
    let parsed: MeasurementInput[];
    try {
      parsed = provider.adapter.fromExternal(data, schema);
    } catch (err) {
      throw new HealthError({
        code: "eks.health.interop.import_failed",
        category: "interop_error",
        message: `Provider '${providerId}' failed to import: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: "The import operation failed.",
        cause: err,
      });
    }
    const result: ImportResult = {
      parsed,
      errors: [],
      totalRows: parsed.length,
      successCount: parsed.length,
    };
    void getEventBus().publish(
      buildEvent(
        INTEROP_EVENTS.importCompleted,
        { providerId, count: parsed.length },
        {},
        "domain",
      ),
    );
    return result;
  }

  /** Export measurements to a provider's external format. */
  exportTo(
    providerId: string,
    measurements: readonly Measurement[],
    schema?: MeasurementSchema,
  ): ExportResult {
    const provider = this.requireProvider(providerId, "export");
    let external: unknown;
    try {
      external = provider.adapter.toExternal(measurements, schema);
    } catch (err) {
      throw new HealthError({
        code: "eks.health.interop.export_failed",
        category: "interop_error",
        message: `Provider '${providerId}' failed to export: ${err instanceof Error ? err.message : String(err)}`,
        userMessage: "The export operation failed.",
        cause: err,
      });
    }
    const body = typeof external === "string" ? external : JSON.stringify(external, null, 2);
    const result: ExportResult = {
      format: provider.format === "fhir" ? "fhir" : provider.format === "csv" ? "csv" : "json",
      body,
      count: measurements.length,
      mime: provider.format === "fhir" ? "application/fhir+json" : provider.format === "csv" ? "text/csv" : "application/json",
      exportedAt: getClock().iso(),
    };
    void getEventBus().publish(
      buildEvent(
        INTEROP_EVENTS.exportCompleted,
        { providerId, count: measurements.length, format: result.format },
        {},
        "domain",
      ),
    );
    return result;
  }

  private requireProvider(id: string, direction: "import" | "export"): InteropProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new HealthError({
        code: "eks.health.interop.provider_not_found",
        category: "not_found",
        message: `Interop provider '${id}' is not registered.`,
        userMessage: "That interop provider is not registered.",
      });
    }
    if (direction === "import" && provider.direction === "export") {
      throw new HealthError({
        code: "eks.health.interop.direction_mismatch",
        category: "state_conflict",
        message: `Provider '${id}' does not support import.`,
        userMessage: "This provider cannot import data.",
      });
    }
    if (direction === "export" && provider.direction === "import") {
      throw new HealthError({
        code: "eks.health.interop.direction_mismatch",
        category: "state_conflict",
        message: `Provider '${id}' does not support export.`,
        userMessage: "This provider cannot export data.",
      });
    }
    return provider;
  }

  // -------------------------------------------------------------------------
  // Built-in providers
  // -------------------------------------------------------------------------

  private appleHealthProvider(): InteropProvider {
    return {
      id: "apple_health",
      label: "Apple Health",
      description: "Bidirectional JSON adapter for Apple HealthKit exports.",
      direction: "bidirectional",
      format: "json",
      adapter: {
        toExternal: (measurements) => {
          return {
            source: "apple_health",
            exportedAt: getClock().iso(),
            data: measurements.map((m) => {
              const numeric = toNumeric(m.value);
              return {
                type: this.appleHealthType(m),
                unit: this.unitSymbol(m),
                value: numeric ?? String(m.value),
                startDate: m.provenance?.collectedAt ?? m.createdAt ?? m.timestamp ?? getClock().iso(),
                endDate: m.updatedAt ?? m.createdAt ?? m.timestamp ?? getClock().iso(),
                source: {
                  name: "Eks-Health",
                  version: "1.0",
                },
                metadata: {
                  schemaId: m.schemaId as string,
                  verificationState: m.verificationState,
                  tags: m.tags,
                },
              };
            }),
          };
        },
        fromExternal: (data) => {
          if (typeof data !== "object" || data === null) return [];
          const obj = data as Record<string, unknown>;
          const records = Array.isArray(obj.data) ? obj.data : Array.isArray(data) ? data : [];
          return (records as unknown[]).map((r) => {
            const rec = r as Record<string, unknown>;
            return {
              value: typeof rec.value === "number" ? rec.value : (rec.value as MeasurementValue),
              unit: typeof rec.unit === "string" ? rec.unit : undefined,
              timestamp: typeof rec.startDate === "string" ? rec.startDate : getClock().iso(),
              sourceType: "wearable" as SourceType,
              tags: ["apple_health"],
            };
          });
        },
      },
    };
  }

  private googleHealthConnectProvider(): InteropProvider {
    return {
      id: "google_health_connect",
      label: "Google Health Connect",
      description: "Bidirectional JSON adapter for Google Health Connect exports.",
      direction: "bidirectional",
      format: "json",
      adapter: {
        toExternal: (measurements) => {
          return {
            source: "google_health_connect",
            exportedAt: getClock().iso(),
            records: measurements.map((m) => {
              const numeric = toNumeric(m.value);
              return {
                dataType: this.googleHealthType(m),
                value: numeric ?? String(m.value),
                unit: this.unitSymbol(m),
                time: m.provenance?.collectedAt ?? m.createdAt ?? m.timestamp ?? getClock().iso(),
                metadata: {
                  schemaId: m.schemaId as string,
                  verificationState: m.verificationState,
                },
              };
            }),
          };
        },
        fromExternal: (data) => {
          if (typeof data !== "object" || data === null) return [];
          const obj = data as Record<string, unknown>;
          const records = Array.isArray(obj.records) ? obj.records : Array.isArray(data) ? data : [];
          return (records as unknown[]).map((r) => {
            const rec = r as Record<string, unknown>;
            return {
              value: typeof rec.value === "number" ? rec.value : (rec.value as MeasurementValue),
              unit: typeof rec.unit === "string" ? rec.unit : undefined,
              timestamp: typeof rec.time === "string" ? rec.time : getClock().iso(),
              sourceType: "wearable" as SourceType,
              tags: ["google_health_connect"],
            };
          });
        },
      },
    };
  }

  private fhirR4Provider(): InteropProvider {
    return {
      id: "fhir_r4",
      label: "FHIR R4",
      description: "Bidirectional adapter for HL7 FHIR R4 Observation resources.",
      direction: "bidirectional",
      format: "fhir",
      adapter: {
        toExternal: (measurements, schema) => {
          return {
            resourceType: "Bundle",
            type: "collection",
            entry: measurements.map((m) => {
              const s = schema && schema.id === m.schemaId ? schema : undefined;
              return { resource: this.toFhir(m, s) };
            }),
          };
        },
        fromExternal: (data) => {
          if (typeof data !== "object" || data === null) return [];
          const obj = data as Record<string, unknown>;
          // Bundle of Observations.
          if (Array.isArray(obj.entry)) {
            return (obj.entry as unknown[])
              .map((e) => {
                const entry = e as Record<string, unknown>;
                const resource = entry.resource as FhirResource | undefined;
                if (!resource || resource.resourceType !== "Observation") return null;
                try {
                  return this.fromFhir(resource);
                } catch {
                  return null;
                }
              })
              .filter((x): x is MeasurementInput => x !== null);
          }
          // Single Observation.
          if ((obj as { resourceType?: string }).resourceType === "Observation") {
            try {
              return [this.fromFhir(obj as unknown as FhirResource)];
            } catch {
              return [];
            }
          }
          // Array of Observations.
          if (Array.isArray(data)) {
            return (data as unknown[])
              .map((r) => {
                try {
                  return this.fromFhir(r as unknown as FhirResource);
                } catch {
                  return null;
                }
              })
              .filter((x): x is MeasurementInput => x !== null);
          }
          return [];
        },
      },
    };
  }

  private appleHealthType(m: Measurement): string {
    const slug = (m.schemaId as string).toLowerCase();
    if (slug.includes("heart_rate") || slug.includes("heartrate")) return "HKQuantityTypeIdentifierHeartRate";
    if (slug.includes("step")) return "HKQuantityTypeIdentifierStepCount";
    if (slug.includes("weight") || slug.includes("mass")) return "HKQuantityTypeIdentifierBodyMass";
    if (slug.includes("blood_pressure")) return "HKCorrelationTypeIdentifierBloodPressure";
    if (slug.includes("glucose")) return "HKQuantityTypeIdentifierBloodGlucose";
    if (slug.includes("oxygen") || slug.includes("spo2")) return "HKQuantityTypeIdentifierOxygenSaturation";
    return `HKQuantityTypeIdentifier${(m.schemaId as string).replace(/[^a-zA-Z0-9]/g, "")}`;
  }

  private googleHealthType(m: Measurement): string {
    const slug = (m.schemaId as string).toLowerCase();
    if (slug.includes("heart_rate")) return "HeartRate";
    if (slug.includes("step")) return "Steps";
    if (slug.includes("weight")) return "Weight";
    if (slug.includes("blood_pressure")) return "BloodPressure";
    if (slug.includes("glucose")) return "BloodGlucose";
    if (slug.includes("oxygen")) return "OxygenSaturation";
    return (m.schemaId as string).replace(/[^a-zA-Z0-9]/g, "");
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _interop: InteropManager | null = null;

export function getInterop(): InteropManager {
  if (!_interop) _interop = new InteropManager();
  return _interop;
}

export function setInterop(mgr: InteropManager): void {
  _interop = mgr;
}

export function resetInterop(): void {
  _interop = null;
}

// Re-export branded-id helpers for callers.
export { asSchemaId, asProfileId, asMeasurementId, asSourceId, asUnitId };
