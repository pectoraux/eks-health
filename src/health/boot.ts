/**
 * Eks-Health Universal Health Data Platform — Boot Sequence
 *
 * Idempotently initializes the health data platform, seeds demo
 * measurement schemas and sample measurements, and emits the platform
 * started health event.
 */

import "server-only";
import { getEventBus, buildEvent, getClock, bootKernel } from "@/kernel";
import { bootIdentity, asAccountId } from "@/identity";
import { bootPrograms, asProgramId, asDeveloperId } from "@/programs";
import { getSchemas } from "./schemas";
import { getUnits } from "./units";
import { getSources } from "./sources";
import { getMeasurements } from "./measurements";
import { getEvidence } from "./evidence";
import { getVerification } from "./verification";
import { getProvenance } from "./provenance";
import { getTimeline } from "./timeline";
import { getComposite } from "./composite";
import { getDerived } from "./derived";
import { getValidation } from "./validation";
import { getProfiles } from "./profiles";
import { getHealthSearch } from "./search";
import { getInterop } from "./interop";
import { getVersioning } from "./versioning";
import { getAnalytics } from "./analytics";
import { HEALTH_EVENTS, asSchemaId, asProfileId, asSourceId, asUnitId } from "./core";

export interface HealthInfo {
  readonly name: string;
  readonly version: string;
  readonly bootedAt: string;
  readonly subsystems: string[];
}

let _booted = false;
let _info: HealthInfo | null = null;

export function bootHealth(): HealthInfo {
  if (_booted && _info) return _info;
  bootKernel();
  bootIdentity();
  bootPrograms();

  getSchemas();
  getUnits();
  getSources();
  getMeasurements();
  getEvidence();
  getVerification();
  getProvenance();
  getTimeline();
  getComposite();
  getDerived();
  getValidation();
  getProfiles();
  getHealthSearch();
  getInterop();
  getVersioning();
  getAnalytics();

  _booted = true;
  _info = {
    name: "Eks-Health Universal Health Data Platform",
    version: "4.0.0-m4",
    bootedAt: getClock().iso(),
    subsystems: [
      "core", "schemas", "units", "sources", "measurements", "evidence",
      "verification", "provenance", "timeline", "composite", "derived",
      "validation", "profiles", "search", "interop", "versioning", "analytics",
    ],
  };
  void getEventBus().publish(buildEvent(HEALTH_EVENTS.measurementCreated, { version: _info.version }, {}, "system"));
  return _info;
}

export function healthInfo(): HealthInfo {
  if (!_info) {
    _info = {
      name: "Eks-Health Universal Health Data Platform",
      version: "4.0.0-m4",
      bootedAt: getClock().iso(),
      subsystems: [],
    };
  }
  return _info;
}

/** Compact diagnostic snapshot for the console. */
export function healthSnapshot() {
  ensureBooted();
  const schemas = getSchemas();
  const units = getUnits();
  const sources = getSources();
  const measurements = getMeasurements();
  const evidence = getEvidence();
  const verification = getVerification();
  const profiles = getProfiles();
  const composite = getComposite();
  const derived = getDerived();
  const analytics = getAnalytics();
  const interop = getInterop();

  return {
    info: healthInfo(),
    schemas: schemas.list().map((s) => ({
      id: s.id, slug: s.slug, name: s.name, category: s.category,
      valueType: s.valueType, programId: s.programId,
      unitCount: s.allowedUnits.length, allowedSources: s.allowedSources,
      verificationRequired: s.verificationWorkflow.required,
      visibility: s.visibility, tags: s.tags,
      derivedFrom: s.derivedFrom, isComposite: !!s.compositeComponents,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
    })),
    units: {
      total: units.list().length,
      categories: units.listCategories(),
      systems: ["metric", "imperial", "medical", "custom"],
      sample: units.list().slice(0, 12).map((u) => ({ id: u.id, symbol: u.symbol, name: u.name, category: u.category, system: u.system })),
    },
    sources: sources.list().map((s) => ({
      id: s.id, type: s.type, label: s.label, trustLevel: s.trustLevel,
      verified: s.verified, orgId: s.orgId, deviceModel: s.deviceModel,
    })),
    sourceTypes: sources.listTypes(),
    measurements: {
      stats: measurements.getStats(),
      recent: measurements.list({ limit: 20 }).map((m) => measurements.toRecord(m)),
    },
    evidence: evidence.getStats(),
    verification: {
      pending: verification.list({ state: "pending" }).length,
      verified: verification.list({ state: "verified" }).length,
      rejected: verification.list({ state: "rejected" }).length,
      recent: verification.list().slice(-10).map((r) => ({
        id: r.id, measurementId: r.measurementId, state: r.currentState, requestedAt: r.requestedAt,
      })),
    },
    profiles: profiles.list().map((p) => ({
      id: p.id, accountId: p.accountId, programCount: p.programs.length,
      deviceCount: p.devices.length, customAttributeCount: Object.keys(p.customAttributes).length,
      createdAt: p.createdAt,
    })),
    composite: {
      metrics: composite.list().map((m) => ({ id: m.id, name: m.name, componentCount: m.components.length, scale: m.scale })),
    },
    derived: {
      metrics: derived.list().map((m) => ({ id: m.id, slug: m.slug, name: m.name, inputs: m.inputs, outputUnit: m.outputUnit })),
    },
    analytics: {
      unitCount: 1,
      interopProviders: interop.listProviders().map((p) => ({ id: p.id, label: p.label, direction: p.direction })),
    },
  };
}

function ensureBooted() {
  if (!_booted) bootHealth();
}

// ---------------------------------------------------------------------------
// Demo data seeding — generic schemas (NO disease-specific platform logic)
// ---------------------------------------------------------------------------

let _seeded = false;

export async function seedHealthDemoData(): Promise<void> {
  if (_seeded) return;
  ensureBooted();

  const schemas = getSchemas();
  const sources = getSources();
  const measurements = getMeasurements();

  // Hydrate measurements from DB first. If rows already exist (from a
  // previous server lifetime), skip demo seeding to avoid duplicates.
  await measurements.hydrateFromDb();
  if (measurements.list().length > 0) {
    _seeded = true;
    return;
  }
  _seeded = true;
  const profiles = getProfiles();
  const programId = asProgramId("prg_cardio_care");
  const accountId = asAccountId("acc_demo_1");
  const profileId = asProfileId("prof_demo_1");

  // Register a demo source (wearable)
  const source = sources.register({
    type: "wearable",
    label: "Demo Smartwatch",
    trustLevel: "verified",
    verified: true,
    deviceId: "watch_demo_1",
    deviceModel: "EksWatch Pro",
    capabilities: ["heart_rate", "steps", "sleep"],
  });

  // Register a demo technician source
  const techSource = sources.register({
    type: "health_technician",
    label: "Demo Clinic Technician",
    trustLevel: "clinical",
    verified: true,
  });

  // Define demo measurement schemas (Program-owned, platform stores generically)
  const demoSchemas = [
    {
      slug: "resting_heart_rate",
      name: "Resting Heart Rate",
      description: "Morning resting heart rate measured upon waking.",
      category: "cardiovascular",
      valueType: "scalar" as const,
      allowedUnits: ["bpm"],
      validation: { min: 30, max: 220, precision: 0 },
      allowedSources: ["wearable", "health_technician", "manual_entry"] as const,
      verificationWorkflow: { required: false, initial: "pending" as const, verifiedBy: ["health_technician"], autoVerifyIfSource: ["health_technician"], disputeAllowed: true },
      visibility: "program" as const,
      retention: { retentionDays: 365, action: "anonymize" as const },
      tags: ["cardiovascular", "vitals"],
    },
    {
      slug: "body_weight",
      name: "Body Weight",
      description: "Total body weight.",
      category: "anthropometric",
      valueType: "scalar" as const,
      allowedUnits: ["kg", "lb"],
      validation: { min: 20, max: 500, precision: 1 },
      allowedSources: ["wearable", "health_technician", "manual_entry"] as const,
      verificationWorkflow: { required: false, initial: "pending" as const, verifiedBy: ["health_technician"], autoVerifyIfSource: [], disputeAllowed: false },
      visibility: "program" as const,
      retention: { retentionDays: 2555, action: "archive" as const },
      tags: ["anthropometric", "body_composition"],
    },
    {
      slug: "blood_pressure",
      name: "Blood Pressure",
      description: "Systolic and diastolic blood pressure.",
      category: "cardiovascular",
      valueType: "vector" as const,
      allowedUnits: ["mmhg"],
      validation: { precision: 0 },
      allowedSources: ["medical_device", "health_technician"] as const,
      verificationWorkflow: { required: true, initial: "pending" as const, verifiedBy: ["health_technician"], autoVerifyIfSource: ["medical_device"], expiryDays: 365, disputeAllowed: true },
      requiredEvidence: [{ type: "machine_output" as const, required: true, minCount: 1, description: "Device reading screenshot" }],
      visibility: "program" as const,
      retention: { retentionDays: 3650, action: "archive" as const },
      tags: ["cardiovascular", "vitals"],
    },
    {
      slug: "sleep_duration",
      name: "Sleep Duration",
      description: "Total sleep duration in hours.",
      category: "sleep",
      valueType: "scalar" as const,
      allowedUnits: ["h"],
      validation: { min: 0, max: 24, precision: 1 },
      allowedSources: ["wearable", "mobile_app", "manual_entry"] as const,
      verificationWorkflow: { required: false, initial: "pending" as const, verifiedBy: [], autoVerifyIfSource: ["wearable"], disputeAllowed: false },
      visibility: "program" as const,
      retention: { retentionDays: 730, action: "anonymize" as const },
      tags: ["sleep", "recovery"],
    },
    {
      slug: "daily_steps",
      name: "Daily Steps",
      description: "Total step count for the day.",
      category: "activity",
      valueType: "scalar" as const,
      allowedUnits: ["steps"],
      validation: { min: 0, max: 100000, precision: 0 },
      allowedSources: ["wearable", "mobile_app"] as const,
      verificationWorkflow: { required: false, initial: "pending" as const, verifiedBy: [], autoVerifyIfSource: ["wearable"], disputeAllowed: false },
      visibility: "program" as const,
      retention: { retentionDays: 365, action: "anonymize" as const },
      tags: ["activity", "fitness"],
    },
    {
      slug: "mood_score",
      name: "Mood Score",
      description: "Self-reported mood on a 1-10 scale.",
      category: "mental_wellness",
      valueType: "categorical" as const,
      allowedUnits: ["count"],
      validation: { allowedValues: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"] },
      allowedSources: ["manual_entry", "mobile_app"] as const,
      verificationWorkflow: { required: false, initial: "pending" as const, verifiedBy: [], autoVerifyIfSource: [], disputeAllowed: false },
      visibility: "private" as const,
      retention: { retentionDays: 365, action: "anonymize" as const },
      tags: ["mental_wellness", "self_reported"],
    },
  ];

  const schemaIds: Record<string, string> = {};
  for (const s of demoSchemas) {
    try {
      const schema = schemas.publish({
        programId,
        slug: s.slug,
        name: s.name,
        description: s.description,
        category: s.category,
        valueType: s.valueType,
        defaultUnit: s.allowedUnits[0] as never,
        allowedUnits: s.allowedUnits as never[],
        validation: s.validation,
        collectionMethods: ["sensor", "manual"],
        allowedSources: [...s.allowedSources] as never[],
        verificationWorkflow: s.verificationWorkflow as never,
        requiredEvidence: (s as { requiredEvidence?: unknown[] }).requiredEvidence as never,
        visibility: s.visibility,
        retention: s.retention,
        tags: s.tags,
      });
      schemaIds[s.slug] = schema.id;
    } catch {
      // already exists
    }
  }

  // Create a demo profile
  try {
    profiles.getOrCreate(accountId);
  } catch {
    // already exists
  }

  // Record some demo measurements
  const now = Date.now();
  const demoMeasurements = [
    { schema: "resting_heart_rate", value: 68, unit: "bpm", sourceId: source.id, daysAgo: 0 },
    { schema: "resting_heart_rate", value: 65, unit: "bpm", sourceId: source.id, daysAgo: 1 },
    { schema: "resting_heart_rate", value: 70, unit: "bpm", sourceId: source.id, daysAgo: 2 },
    { schema: "body_weight", value: 75.5, unit: "kg", sourceId: techSource.id, daysAgo: 0 },
    { schema: "body_weight", value: 76.2, unit: "kg", sourceId: techSource.id, daysAgo: 7 },
    { schema: "sleep_duration", value: 7.5, unit: "h", sourceId: source.id, daysAgo: 0 },
    { schema: "sleep_duration", value: 6.8, unit: "h", sourceId: source.id, daysAgo: 1 },
    { schema: "daily_steps", value: 8500, unit: "steps", sourceId: source.id, daysAgo: 0 },
    { schema: "daily_steps", value: 10200, unit: "steps", sourceId: source.id, daysAgo: 1 },
    { schema: "mood_score", value: "7", unit: "count", sourceId: source.id, daysAgo: 0 },
  ];

  for (const dm of demoMeasurements) {
    const schemaId = schemaIds[dm.schema];
    if (!schemaId) continue;
    try {
      measurements.record({
        schemaId: schemaId as never,
        profileId,
        value: dm.value,
        unitId: dm.unit as never,
        sourceId: dm.sourceId as never,
        provenance: {
          collectedBy: accountId,
          sourceId: dm.sourceId as never,
          collectedAt: new Date(now - dm.daysAgo * 86400000).toISOString(),
          verificationHistory: [],
        },
      });
    } catch {
      // already exists or invalid
    }
  }

  _seeded = true;
}
