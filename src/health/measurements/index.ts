/**
 * Eks-Health Universal Health Data Platform — Measurement Store
 *
 * The core measurement store. Programs define schemas; participants own an
 * immutable measurement timeline. Version history, corrections, superseded
 * records, source tracking, time-travel queries, trend analysis. Nothing
 * is permanently overwritten.
 */

import "server-only";
import {
  type MeasurementId,
  type SchemaId,
  type ProfileId,
  type SourceId,
  type UnitId,
  type MeasurementValue,
  type VerificationState,
  type Provenance,
  HealthError,
  asMeasurementId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { HEALTH_EVENTS } from "../core";
import type { MeasurementSchema } from "../schemas";
import { getSchemas } from "../schemas";
import { getSources } from "../sources";

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface Measurement {
  readonly id: MeasurementId;
  readonly schemaId: SchemaId;
  readonly profileId: ProfileId;
  readonly value: MeasurementValue;
  readonly unitId: UnitId;
  readonly sourceId: SourceId;
  readonly provenance: Provenance;
  readonly verificationState: VerificationState;
  readonly evidenceIds: string[];
  readonly tags: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supersededBy?: MeasurementId;
  readonly version: number;
  readonly previousVersionId?: MeasurementId;
}

export interface MeasurementRecord {
  readonly id: MeasurementId;
  readonly schemaId: SchemaId;
  readonly profileId: ProfileId;
  readonly value: MeasurementValue;
  readonly unitId: UnitId;
  readonly unitSymbol: string;
  readonly sourceId: SourceId;
  readonly sourceLabel: string;
  readonly sourceType: string;
  readonly verificationState: VerificationState;
  readonly evidenceCount: number;
  readonly tags: string[];
  readonly collectedAt: string;
  readonly createdAt: string;
  readonly superseded: boolean;
  readonly version: number;
}

export interface MeasurementFilter {
  readonly schemaId?: SchemaId;
  readonly profileId?: ProfileId;
  readonly sourceId?: SourceId;
  readonly verificationState?: VerificationState;
  readonly from?: string;
  readonly to?: string;
  readonly dateRange?: { from: string; to: string };
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TrendResult {
  readonly values: { timestamp: string; value: number }[];
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly slope: number; // per day
  readonly changePercent: number;
  readonly count: number;
}

export interface MeasurementStats {
  readonly total: number;
  readonly bySchema: Record<string, number>;
  readonly byVerification: Record<string, number>;
  readonly bySource: Record<string, number>;
  readonly dateRange?: { from: string; to: string };
}

// ---------------------------------------------------------------------------
// Measurement store
// ---------------------------------------------------------------------------

export class MeasurementStore {
  private readonly measurements = new Map<MeasurementId, Measurement>();
  private readonly byProfile = new Map<ProfileId, MeasurementId[]>();
  private readonly bySchema = new Map<SchemaId, MeasurementId[]>();

  record(input: {
    schemaId: SchemaId;
    profileId: ProfileId;
    value: MeasurementValue;
    unitId: UnitId;
    sourceId: SourceId;
    provenance: Provenance;
    evidenceIds?: string[];
    tags?: string[];
  }): Measurement {
    const schema = getSchemas().get(input.schemaId);
    if (!schema) {
      throw new HealthError({ code: "eks.health.measurement.schema_not_found", category: "not_found", message: `Schema ${input.schemaId} not found.`, userMessage: "Measurement type not found." });
    }
    // Validate unit
    if (!schema.allowedUnits.includes(input.unitId)) {
      throw new HealthError({ code: "eks.health.measurement.invalid_unit", category: "unit_mismatch", message: `Unit ${input.unitId} not allowed for schema ${schema.slug}.`, userMessage: "This unit is not valid for this measurement type." });
    }
    // Validate source acceptability
    const source = getSources().get(input.sourceId);
    if (!source) {
      throw new HealthError({ code: "eks.health.measurement.unknown_source", category: "not_found", message: `Source ${input.sourceId} not found.` });
    }
    if (!getSources().isAcceptable(source, schema.allowedSources)) {
      throw new HealthError({ code: "eks.health.measurement.source_not_allowed", category: "validation_failed", message: `Source type ${source.type} not allowed for schema ${schema.slug}.`, userMessage: "This source is not accepted for this measurement." });
    }
    // Basic value-type validation
    this.validateValueType(input.value, schema);

    const now = getClock().iso();
    const measurement: Measurement = {
      id: asMeasurementId(generateId("msr_")),
      schemaId: input.schemaId,
      profileId: input.profileId,
      value: input.value,
      unitId: input.unitId,
      sourceId: input.sourceId,
      provenance: input.provenance,
      verificationState: schema.verificationWorkflow.initial,
      evidenceIds: input.evidenceIds ?? [],
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.measurements.set(measurement.id, measurement);
    const pList = this.byProfile.get(input.profileId) ?? [];
    this.byProfile.set(input.profileId, [...pList, measurement.id]);
    const sList = this.bySchema.get(input.schemaId) ?? [];
    this.bySchema.set(input.schemaId, [...sList, measurement.id]);
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.measurementCreated, { measurementId: measurement.id, schemaId: input.schemaId, profileId: input.profileId }, {}, "domain"));
    return measurement;
  }

  get(id: MeasurementId): Measurement | undefined {
    return this.measurements.get(id);
  }

  list(filter?: MeasurementFilter): Measurement[] {
    let list = [...this.measurements.values()];
    if (filter?.schemaId) list = list.filter((m) => m.schemaId === filter.schemaId);
    if (filter?.profileId) list = list.filter((m) => m.profileId === filter.profileId);
    if (filter?.sourceId) list = list.filter((m) => m.sourceId === filter.sourceId);
    if (filter?.verificationState) list = list.filter((m) => m.verificationState === filter.verificationState);
    const from = filter?.from ?? filter?.dateRange?.from;
    const to = filter?.to ?? filter?.dateRange?.to;
    if (from) list = list.filter((m) => m.provenance.collectedAt >= from);
    if (to) list = list.filter((m) => m.provenance.collectedAt <= to);
    // Exclude superseded by default (unless includeSuperseded is true)
    if (!filter?.includeSuperseded) {
      list = list.filter((m) => !m.supersededBy);
    }
    list.sort((a, b) => b.provenance.collectedAt.localeCompare(a.provenance.collectedAt));
    if (filter?.offset) list = list.slice(filter.offset);
    if (filter?.limit) list = list.slice(0, filter.limit);
    return list;
  }

  listByProfile(profileId: ProfileId, filter?: Omit<MeasurementFilter, "profileId">): Measurement[] {
    return this.list({ ...filter, profileId });
  }

  /** Correct a measurement — creates a new version, marks old as superseded. */
  correct(id: MeasurementId, newValue: MeasurementValue, reason: string, _by: string): Measurement {
    const original = this.measurements.get(id);
    if (!original) throw new HealthError({ code: "eks.health.measurement.not_found", category: "not_found", message: "Measurement not found." });
    const now = getClock().iso();
    // Mark original as superseded
    this.measurements.set(id, { ...original, supersededBy: undefined, updatedAt: now });
    const corrected: Measurement = {
      ...original,
      id: asMeasurementId(generateId("msr_")),
      value: newValue,
      previousVersionId: id,
      version: original.version + 1,
      createdAt: now,
      updatedAt: now,
    };
    this.measurements.set(corrected.id, corrected);
    // Link original to its successor
    this.measurements.set(id, { ...this.measurements.get(id)!, supersededBy: corrected.id });
    // Update indexes
    const pList = this.byProfile.get(original.profileId) ?? [];
    this.byProfile.set(original.profileId, [...pList, corrected.id]);
    const sList = this.bySchema.get(original.schemaId) ?? [];
    this.bySchema.set(original.schemaId, [...sList, corrected.id]);
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.measurementCorrected, { measurementId: corrected.id, correctedFrom: id, reason }, {}, "domain"));
    return corrected;
  }

  supersede(id: MeasurementId, newMeasurementId: MeasurementId): void {
    const m = this.measurements.get(id);
    if (!m) return;
    this.measurements.set(id, { ...m, supersededBy: newMeasurementId, updatedAt: getClock().iso() });
    void getEventBus().publish(buildEvent(HEALTH_EVENTS.measurementSuperseded, { measurementId: id, by: newMeasurementId }, {}, "domain"));
  }

  getVersions(id: MeasurementId): Measurement[] {
    const versions: Measurement[] = [];
    let current = this.measurements.get(id);
    // Walk forward to find the latest
    while (current?.supersededBy) {
      current = this.measurements.get(current.supersededBy);
    }
    if (!current) return versions;
    // Walk backward via previousVersionId
    let node: Measurement | undefined = current;
    while (node) {
      versions.unshift(node);
      node = node.previousVersionId ? this.measurements.get(node.previousVersionId) : undefined;
    }
    return versions;
  }

  /** Time-travel query: the measurement that was current at a given time. */
  getAtTime(profileId: ProfileId, schemaId: SchemaId, timestamp: string): Measurement | undefined {
    const ids = this.byProfile.get(profileId) ?? [];
    const candidates = ids
      .map((id) => this.measurements.get(id)!)
      .filter((m) => m && m.schemaId === schemaId && m.provenance.collectedAt <= timestamp)
      .sort((a, b) => b.provenance.collectedAt.localeCompare(a.provenance.collectedAt));
    // Return the most recent one at that time that wasn't superseded before the timestamp
    return candidates.find((m) => !m.supersededBy || this.measurements.get(m.supersededBy)!.provenance.collectedAt > timestamp);
  }

  getTrend(profileId: ProfileId, schemaId: SchemaId, from: string, to: string): TrendResult {
    const ids = this.byProfile.get(profileId) ?? [];
    const measurements = ids
      .map((id) => this.measurements.get(id)!)
      .filter((m) => m && m.schemaId === schemaId && !m.supersededBy && m.provenance.collectedAt >= from && m.provenance.collectedAt <= to)
      .sort((a, b) => a.provenance.collectedAt.localeCompare(b.provenance.collectedAt));
    const values = measurements.map((m) => ({ timestamp: m.provenance.collectedAt, value: typeof m.value === "number" ? m.value : (m.value as { value?: number }).value ?? 0 }));
    if (values.length === 0) {
      return { values: [], min: 0, max: 0, avg: 0, slope: 0, changePercent: 0, count: 0 };
    }
    const nums = values.map((v) => v.value);
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    // Linear regression: slope per day
    const n = values.length;
    const xs = values.map((v) => new Date(v.timestamp).getTime() / (1000 * 60 * 60 * 24));
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = nums.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((acc, x, i) => acc + x * nums[i], 0);
    const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
    const slope = n > 1 ? (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX) : 0;
    const changePercent = nums[0] !== 0 ? ((nums[n - 1] - nums[0]) / Math.abs(nums[0])) * 100 : 0;
    return { values, min, max, avg, slope, changePercent, count: n };
  }

  count(filter?: MeasurementFilter): number {
    return this.list(filter).length;
  }

  getStats(profileId?: ProfileId): MeasurementStats {
    let list = [...this.measurements.values()].filter((m) => !m.supersededBy);
    if (profileId) list = list.filter((m) => m.profileId === profileId);
    const bySchema: Record<string, number> = {};
    const byVerification: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    let minTime = "", maxTime = "";
    for (const m of list) {
      bySchema[m.schemaId] = (bySchema[m.schemaId] ?? 0) + 1;
      byVerification[m.verificationState] = (byVerification[m.verificationState] ?? 0) + 1;
      bySource[m.sourceId] = (bySource[m.sourceId] ?? 0) + 1;
      if (!minTime || m.provenance.collectedAt < minTime) minTime = m.provenance.collectedAt;
      if (!maxTime || m.provenance.collectedAt > maxTime) maxTime = m.provenance.collectedAt;
    }
    return { total: list.length, bySchema, byVerification, bySource, dateRange: list.length > 0 ? { from: minTime, to: maxTime } : undefined };
  }

  setVerificationState(id: MeasurementId, state: VerificationState, _by?: string): void {
    const m = this.measurements.get(id);
    if (!m) return;
    this.measurements.set(id, { ...m, verificationState: state, updatedAt: getClock().iso() });
    const eventMap: Partial<Record<VerificationState, string>> = {
      verified: HEALTH_EVENTS.measurementVerified,
      rejected: HEALTH_EVENTS.measurementRejected,
    };
    const evt = eventMap[state];
    if (evt) void getEventBus().publish(buildEvent(evt, { measurementId: id, state }, {}, "domain"));
  }

  toRecord(m: Measurement): MeasurementRecord {
    const source = getSources().get(m.sourceId);
    return {
      id: m.id,
      schemaId: m.schemaId,
      profileId: m.profileId,
      value: m.value,
      unitId: m.unitId,
      unitSymbol: m.unitId,
      sourceId: m.sourceId,
      sourceLabel: source?.label ?? m.sourceId,
      sourceType: source?.type ?? "custom",
      verificationState: m.verificationState,
      evidenceCount: m.evidenceIds.length,
      tags: m.tags,
      collectedAt: m.provenance.collectedAt,
      createdAt: m.createdAt,
      superseded: !!m.supersededBy,
      version: m.version,
    };
  }

  private validateValueType(value: MeasurementValue, schema: MeasurementSchema): void {
    switch (schema.valueType) {
      case "scalar":
        if (typeof value !== "number") {
          throw new HealthError({ code: "eks.health.measurement.value_type", category: "validation_failed", message: "Scalar requires a number.", userMessage: "This measurement requires a numeric value." });
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new HealthError({ code: "eks.health.measurement.value_type", category: "validation_failed", message: "Boolean required." });
        }
        break;
      case "categorical":
        if (typeof value !== "string" || !schema.validation.allowedValues?.includes(value)) {
          throw new HealthError({ code: "eks.health.measurement.value_type", category: "validation_failed", message: `Value must be one of: ${schema.validation.allowedValues?.join(", ")}`, userMessage: "This value is not allowed." });
        }
        break;
      case "text":
        if (typeof value !== "string") {
          throw new HealthError({ code: "eks.health.measurement.value_type", category: "validation_failed", message: "Text required." });
        }
        break;
      default:
        // structured, vector, range, timeseries — accept objects/arrays
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: MeasurementStore | null = null;
export function getMeasurements(): MeasurementStore {
  if (!_store) _store = new MeasurementStore();
  return _store;
}
