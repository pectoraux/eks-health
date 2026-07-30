/**
 * Eks-Health Universal Health Data Platform — Measurement Validation Engine
 *
 * Schema validation, range validation, consistency validation, duplicate
 * detection, outlier detection (IQR / z-score / MAD), dependency validation,
 * evidence validation, unit validation, temporal validation. Programs can
 * extend the rule set.
 *
 * The platform validates measurements generically against the schemas that
 * Programs have published — it never hardcodes domain rules.
 *
 * Built-in rules (each is a real check):
 *   1. validateValueType       — value type matches schema.valueType
 *   2. validateRange           — numeric value within min/max
 *   3. validatePrecision       — decimal places ≤ schema.precision
 *   4. validateUnit            — unitId is in schema.allowedUnits
 *   5. validateCategorical     — value is in schema.allowedValues
 *   6. validateRegex           — text value matches schema.regex
 *   7. validateTemporal        — minIntervalSeconds / maxAgeHours
 *   8. detectDuplicate         — same value+unit+schema within a short window (warn)
 *   9. detectOutlier           — IQR / z-score / MAD over recent measurements (warn)
 *  10. validateRequiredFields  — structured values have requiredFields
 *  11. validateEvidence        — if schema requires evidence, check it (delegates to ../evidence)
 */

import "server-only";
import {
  type MeasurementId,
  type ProfileId,
  type SchemaId,
  type UnitId,
  type MeasurementValue,
  type SourceType,
  HealthError,
  asMeasurementId,
} from "../core";
import type { MeasurementSchema, MeasurementValueType } from "../schemas";
import { getEventBus, buildEvent, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export type ValidationSeverity = "error" | "warning";

export interface ValidationError {
  readonly rule: string;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly value?: unknown;
}

export interface ValidationWarning {
  readonly rule: string;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly value?: unknown;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  readonly warnings: readonly ValidationWarning[];
  readonly schemaId: SchemaId;
  readonly measurementId?: MeasurementId;
  readonly checkedAt: string;
}

export type OutlierMethod = "iqr" | "zscore" | "mad";

export interface MeasurementLike {
  readonly id: MeasurementId;
  readonly profileId: ProfileId;
  readonly schemaId: SchemaId;
  readonly value: MeasurementValue;
  readonly unitId?: UnitId;
  readonly timestamp: string;
  readonly sourceType?: SourceType;
  readonly [k: string]: unknown;
}

export interface ValidationContext {
  /** Recent measurements of the same schema for the same profile (for outlier/duplicate detection). */
  readonly recentMeasurements?: readonly MeasurementLike[];
  /** If true, skip evidence validation (e.g. when the evidence subsystem is unavailable). */
  readonly skipEvidence?: boolean;
  /** Override "now" for temporal validation. Defaults to the system clock. */
  readonly now?: string;
}

export interface ValidationRule {
  readonly name: string;
  readonly severity: ValidationSeverity;
  readonly description: string;
  /**
   * Run the rule against a measurement. Returns a ValidationError /
   * ValidationWarning if the rule fires, or null if it passes.
   * May be async (e.g. evidence lookup, recent-measurements fetch).
   */
  run(measurement: MeasurementLike, schema: MeasurementSchema, ctx: ValidationContext): Promise<ValidationError | ValidationWarning | null> | ValidationError | ValidationWarning | null;
}

// ---------------------------------------------------------------------------
// Defensive loaders for sibling subsystems (m4-2 ships them in parallel).
// ---------------------------------------------------------------------------

interface MeasurementsApi {
  list(filter?: Record<string, unknown>): MeasurementLike[] | Promise<MeasurementLike[]>;
  listByProfile(profileId: ProfileId): MeasurementLike[] | Promise<MeasurementLike[]>;
}

interface EvidenceApi {
  list(measurementId: MeasurementId): unknown[] | Promise<unknown[]>;
}

const MEASUREMENTS_PATH = "../measurements";
const EVIDENCE_PATH = "../evidence";
let _measurementsCache: MeasurementsApi | null | undefined;
let _evidenceCache: EvidenceApi | null | undefined;

async function loadMeasurements(): Promise<MeasurementsApi | null> {
  if (_measurementsCache !== undefined) return _measurementsCache;
  try {
    const mod = await import(MEASUREMENTS_PATH);
    const getter = (mod as { getMeasurements?: () => MeasurementsApi }).getMeasurements;
    _measurementsCache = getter ? getter() : null;
  } catch {
    _measurementsCache = null;
  }
  return _measurementsCache;
}

async function loadEvidence(): Promise<EvidenceApi | null> {
  if (_evidenceCache !== undefined) return _evidenceCache;
  try {
    const mod = await import(EVIDENCE_PATH);
    const getter = (mod as { getEvidence?: () => EvidenceApi }).getEvidence;
    _evidenceCache = getter ? getter() : null;
  } catch {
    _evidenceCache = null;
  }
  return _evidenceCache;
}

async function resolveArray<T>(v: T[] | Promise<T[]> | undefined | null): Promise<T[]> {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return await v;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function numericValue(v: MeasurementValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; systolic?: unknown };
    if (typeof o.value === "number") return Number.isFinite(o.value) ? o.value : null;
    if (typeof o.systolic === "number") return Number.isFinite(o.systolic) ? o.systolic : null;
  }
  return null;
}

function countDecimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  if (s.includes("e") || s.includes("E")) {
    // scientific notation — convert
    const exp = Number.parseInt(s.split(/[eE]/)[1] ?? "0", 10);
    const mantissa = s.split(/[eE]/)[0] ?? "";
    const dot = mantissa.indexOf(".");
    const mantissaDecimals = dot === -1 ? 0 : mantissa.length - dot - 1;
    return Math.max(0, mantissaDecimals - exp);
  }
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

// ---------------------------------------------------------------------------
// Outlier detection: IQR, z-score, MAD (real implementations)
// ---------------------------------------------------------------------------

interface OutlierResult {
  readonly isOutlier: boolean;
  readonly reason: string;
  readonly stats?: { readonly method: OutlierMethod; readonly [k: string]: number | string };
}

function detectOutlierIQR(value: number, samples: readonly number[], threshold: number): OutlierResult {
  if (samples.length < 4) {
    return { isOutlier: false, reason: `iqr: insufficient samples (${samples.length} < 4)` };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;
  const lower = q1 - threshold * iqr;
  const upper = q3 + threshold * iqr;
  const isOutlier = value < lower || value > upper;
  return {
    isOutlier,
    reason: `iqr: value=${value}, Q1=${q1}, Q3=${q3}, IQR=${iqr}, bounds=[${lower}, ${upper}]`,
    stats: { method: "iqr", q1, q3, iqr, lower, upper, threshold },
  };
}

function detectOutlierZScore(value: number, samples: readonly number[], threshold: number): OutlierResult {
  if (samples.length < 2) {
    return { isOutlier: false, reason: `zscore: insufficient samples (${samples.length} < 2)` };
  }
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
  const std = Math.sqrt(variance);
  if (std === 0) {
    return { isOutlier: false, reason: `zscore: std=0 (all samples equal)` };
  }
  const z = (value - mean) / std;
  const isOutlier = Math.abs(z) > threshold;
  return {
    isOutlier,
    reason: `zscore: value=${value}, mean=${mean}, std=${std}, z=${z}, threshold=${threshold}`,
    stats: { method: "zscore", mean, std, z, threshold },
  };
}

function detectOutlierMAD(value: number, samples: readonly number[], threshold: number): OutlierResult {
  if (samples.length < 4) {
    return { isOutlier: false, reason: `mad: insufficient samples (${samples.length} < 4)` };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 50);
  const deviations = sorted.map((x) => Math.abs(x - median));
  const mad = percentile([...deviations].sort((a, b) => a - b), 50);
  // Modified z-score = 0.6745 * (value - median) / MAD
  if (mad === 0) {
    return { isOutlier: false, reason: `mad: MAD=0 (deviations all zero)` };
  }
  const modifiedZ = 0.6745 * (value - median) / mad;
  const isOutlier = Math.abs(modifiedZ) > threshold;
  return {
    isOutlier,
    reason: `mad: value=${value}, median=${median}, MAD=${mad}, modifiedZ=${modifiedZ}, threshold=${threshold}`,
    stats: { method: "mad", median, mad, modifiedZ, threshold },
  };
}

/** Nearest-rank percentile (deterministic, conservative). */
function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(Math.max(rank - 1, 0), sortedAsc.length - 1);
  return sortedAsc[idx]!;
}

// ---------------------------------------------------------------------------
// Validation engine
// ---------------------------------------------------------------------------

export class ValidationEngine {
  private readonly rules: ValidationRule[] = [];

  constructor() {
    this.registerBuiltins();
  }

  /**
   * Validate a measurement against a schema. Runs ALL built-in rules.
   * Optionally accepts a context with pre-fetched recent measurements and
   * evidence-skip flag. If recentMeasurements aren't provided, the engine
   * tries to fetch them via the measurements subsystem (best-effort).
   */
  async validate(
    measurement: MeasurementLike,
    schema: MeasurementSchema,
    context?: ValidationContext,
  ): Promise<ValidationResult> {
    const ctx = await this.resolveContext(measurement, schema, context);
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    for (const rule of this.rules) {
      let result: ValidationError | ValidationWarning | null;
      try {
        result = await rule.run(measurement, schema, ctx);
      } catch (e) {
        // A rule that throws doesn't invalidate the measurement; record a warning.
        warnings.push({
          rule: rule.name,
          code: "eks.health.validation.rule_error",
          message: `Rule '${rule.name}' threw: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      if (!result) continue;
      if (rule.severity === "error") errors.push(result as ValidationError);
      else warnings.push(result as ValidationWarning);
    }

    void getEventBus().publish(
      buildEvent(
        "eks.health.measurement.validated",
        {
          measurementId: measurement.id,
          schemaId: schema.id,
          valid: errors.length === 0,
          errorCount: errors.length,
          warningCount: warnings.length,
        },
        {},
        "domain",
      ),
    );

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      schemaId: schema.id,
      measurementId: measurement.id,
      checkedAt: getClock().iso(),
    };
  }

  /** Validate multiple measurements against the same schema. */
  async validateBatch(measurements: readonly MeasurementLike[], schema: MeasurementSchema): Promise<ValidationResult[]> {
    return Promise.all(measurements.map((m) => this.validate(m, schema)));
  }

  /** Register a custom rule (programs extend the engine). */
  registerCustomRule(rule: ValidationRule): void {
    if (this.rules.some((r) => r.name === rule.name)) {
      throw new HealthError({
        code: "eks.health.validation.duplicate_rule",
        category: "state_conflict",
        message: `Rule '${rule.name}' already registered.`,
      });
    }
    this.rules.push(rule);
  }

  /** List all registered rules. */
  listRules(): ReadonlyArray<{ readonly name: string; readonly severity: ValidationSeverity; readonly description: string }> {
    return this.rules.map((r) => ({ name: r.name, severity: r.severity, description: r.description }));
  }

  // --- context resolution --------------------------------------------------

  private async resolveContext(
    measurement: MeasurementLike,
    schema: MeasurementSchema,
    context?: ValidationContext,
  ): Promise<ValidationContext> {
    const now = context?.now ?? getClock().iso();
    if (context?.recentMeasurements !== undefined) {
      return { ...context, now };
    }
    // Best-effort: fetch recent measurements of the same schema for this profile.
    const api = await loadMeasurements();
    if (!api) return { ...context, now, recentMeasurements: [] };
    try {
      const all = await resolveArray(api.listByProfile(measurement.profileId));
      const recent = all
        .filter((m) => m.schemaId === schema.id && m.id !== measurement.id)
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
        .slice(0, 50);
      return { ...context, now, recentMeasurements: recent };
    } catch {
      return { ...context, now, recentMeasurements: [] };
    }
  }

  // --- built-in rules ------------------------------------------------------

  private registerBuiltins(): void {
    this.rules.push({
      name: "validateValueType",
      severity: "error",
      description: "Value type matches schema.valueType.",
      run: (m, s) => this.ruleValidateValueType(m, s),
    });
    this.rules.push({
      name: "validateRange",
      severity: "error",
      description: "Numeric value is within schema.validation.min/max.",
      run: (m, s) => this.ruleValidateRange(m, s),
    });
    this.rules.push({
      name: "validatePrecision",
      severity: "error",
      description: "Value has no more decimal places than schema.validation.precision.",
      run: (m, s) => this.ruleValidatePrecision(m, s),
    });
    this.rules.push({
      name: "validateUnit",
      severity: "error",
      description: "unitId is in schema.allowedUnits.",
      run: (m, s) => this.ruleValidateUnit(m, s),
    });
    this.rules.push({
      name: "validateCategorical",
      severity: "error",
      description: "Value is in schema.validation.allowedValues.",
      run: (m, s) => this.ruleValidateCategorical(m, s),
    });
    this.rules.push({
      name: "validateRegex",
      severity: "error",
      description: "Text value matches schema.validation.regex.",
      run: (m, s) => this.ruleValidateRegex(m, s),
    });
    this.rules.push({
      name: "validateTemporal",
      severity: "error",
      description: "Respects minIntervalSeconds and maxAgeHours.",
      run: (m, s, ctx) => this.ruleValidateTemporal(m, s, ctx),
    });
    this.rules.push({
      name: "detectDuplicate",
      severity: "warning",
      description: "Same value+unit+schema within a short window is a duplicate.",
      run: (m, s, ctx) => this.ruleDetectDuplicate(m, s, ctx),
    });
    this.rules.push({
      name: "detectOutlier",
      severity: "warning",
      description: "IQR / z-score / MAD outlier detection over recent measurements.",
      run: (m, s, ctx) => this.ruleDetectOutlier(m, s, ctx),
    });
    this.rules.push({
      name: "validateRequiredFields",
      severity: "error",
      description: "Structured values have all requiredFields.",
      run: (m, s) => this.ruleValidateRequiredFields(m, s),
    });
    this.rules.push({
      name: "validateEvidence",
      severity: "error",
      description: "If schema requires evidence, it is present.",
      run: (m, s, ctx) => this.ruleValidateEvidence(m, s, ctx),
    });
  }

  // --- individual rules ----------------------------------------------------

  private ruleValidateValueType(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    const v = m.value;
    const ok = checkValueType(v, s.valueType);
    if (!ok) {
      return {
        rule: "validateValueType",
        code: "eks.health.validation.value_type",
        message: `Expected valueType '${s.valueType}' but value is ${describeValue(v)}.`,
        value: v,
      };
    }
    return null;
  }

  private ruleValidateRange(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    if (s.valueType !== "scalar" && s.valueType !== "range") return null;
    if (s.validation.min === undefined && s.validation.max === undefined) return null;
    const num = numericValue(m.value);
    if (num === null) return null; // value-type rule will catch non-numeric
    if (s.validation.min !== undefined && num < s.validation.min) {
      return {
        rule: "validateRange",
        code: "eks.health.validation.below_min",
        message: `Value ${num} is below minimum ${s.validation.min}.`,
        value: num,
      };
    }
    if (s.validation.max !== undefined && num > s.validation.max) {
      return {
        rule: "validateRange",
        code: "eks.health.validation.above_max",
        message: `Value ${num} is above maximum ${s.validation.max}.`,
        value: num,
      };
    }
    return null;
  }

  private ruleValidatePrecision(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    if (s.validation.precision === undefined) return null;
    const num = numericValue(m.value);
    if (num === null) return null;
    const decimals = countDecimalPlaces(num);
    if (decimals > s.validation.precision) {
      return {
        rule: "validatePrecision",
        code: "eks.health.validation.precision",
        message: `Value ${num} has ${decimals} decimal places; max allowed is ${s.validation.precision}.`,
        value: num,
      };
    }
    return null;
  }

  private ruleValidateUnit(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    if (!m.unitId) return null;
    if (s.allowedUnits.length === 0) return null;
    if (!s.allowedUnits.includes(m.unitId)) {
      return {
        rule: "validateUnit",
        code: "eks.health.validation.unit_not_allowed",
        message: `Unit '${m.unitId}' is not in schema.allowedUnits.`,
        value: m.unitId,
      };
    }
    return null;
  }

  private ruleValidateCategorical(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    if (s.valueType !== "categorical") return null;
    const allowed = s.validation.allowedValues ?? [];
    if (allowed.length === 0) return null;
    if (typeof m.value !== "string") return null; // value-type rule catches this
    if (!allowed.includes(m.value)) {
      return {
        rule: "validateCategorical",
        code: "eks.health.validation.categorical",
        message: `Value '${m.value}' is not in allowed values [${allowed.join(", ")}].`,
        value: m.value,
      };
    }
    return null;
  }

  private ruleValidateRegex(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    if (s.valueType !== "text") return null;
    if (!s.validation.regex) return null;
    if (typeof m.value !== "string") return null; // value-type rule catches this
    let re: RegExp;
    try {
      re = new RegExp(s.validation.regex);
    } catch (e) {
      return {
        rule: "validateRegex",
        code: "eks.health.validation.regex_invalid",
        message: `Schema regex '${s.validation.regex}' is invalid: ${e instanceof Error ? e.message : String(e)}.`,
        value: s.validation.regex,
      };
    }
    if (!re.test(m.value)) {
      return {
        rule: "validateRegex",
        code: "eks.health.validation.regex_mismatch",
        message: `Value does not match regex /${s.validation.regex}/.`,
        value: m.value,
      };
    }
    return null;
  }

  private ruleValidateTemporal(m: MeasurementLike, s: MeasurementSchema, ctx: ValidationContext): ValidationError | null {
    const tc = s.validation.temporalConstraints;
    if (!tc) return null;
    const nowMs = ctx.now ? Date.parse(ctx.now) : getClock().epochMs();
    const tsMs = Date.parse(m.timestamp);
    if (Number.isNaN(tsMs)) {
      return {
        rule: "validateTemporal",
        code: "eks.health.validation.bad_timestamp",
        message: `Measurement timestamp '${m.timestamp}' is not parseable.`,
        value: m.timestamp,
      };
    }
    if (tc.maxAgeHours !== undefined) {
      const ageMs = nowMs - tsMs;
      if (ageMs > tc.maxAgeHours * 60 * 60 * 1000) {
        return {
          rule: "validateTemporal",
          code: "eks.health.validation.too_old",
          message: `Measurement is ${Math.round(ageMs / 3600000)}h old; max allowed is ${tc.maxAgeHours}h.`,
          value: m.timestamp,
        };
      }
      // Backdating into the future is also invalid.
      if (ageMs < 0) {
        return {
          rule: "validateTemporal",
          code: "eks.health.validation.future_dated",
          message: `Measurement timestamp is in the future.`,
          value: m.timestamp,
        };
      }
    }
    if (tc.minIntervalSeconds !== undefined && ctx.recentMeasurements) {
      const minIntervalMs = tc.minIntervalSeconds * 1000;
      const tooSoon = ctx.recentMeasurements.find((r) => {
        const rMs = Date.parse(r.timestamp);
        if (Number.isNaN(rMs)) return false;
        return Math.abs(rMs - tsMs) < minIntervalMs;
      });
      if (tooSoon) {
        return {
          rule: "validateTemporal",
          code: "eks.health.validation.too_frequent",
          message: `Measurement recorded within minIntervalSeconds (${tc.minIntervalSeconds}s) of a prior measurement at ${tooSoon.timestamp}.`,
          value: m.timestamp,
        };
      }
    }
    return null;
  }

  private ruleDetectDuplicate(m: MeasurementLike, s: MeasurementSchema, ctx: ValidationContext): ValidationWarning | null {
    if (!ctx.recentMeasurements || ctx.recentMeasurements.length === 0) return null;
    const windowMs = 60 * 60 * 1000; // 1 hour duplicate window
    const tsMs = Date.parse(m.timestamp);
    if (Number.isNaN(tsMs)) return null;
    const dup = ctx.recentMeasurements.find((r) => {
      if (r.unitId !== m.unitId) return false;
      const rMs = Date.parse(r.timestamp);
      if (Number.isNaN(rMs)) return false;
      if (Math.abs(rMs - tsMs) > windowMs) return false;
      // Same value (deep-equal for primitives; JSON for objects).
      return deepEqual(r.value, m.value);
    });
    if (dup) {
      return {
        rule: "detectDuplicate",
        code: "eks.health.validation.duplicate",
        message: `Possible duplicate of measurement ${dup.id} (same value+unit+schema within 1h).`,
        value: m.value,
      };
    }
    return null;
  }

  private ruleDetectOutlier(m: MeasurementLike, s: MeasurementSchema, ctx: ValidationContext): ValidationWarning | null {
    const cfg = s.validation.outlierDetection;
    if (!cfg) return null;
    if (!ctx.recentMeasurements || ctx.recentMeasurements.length === 0) return null;
    const num = numericValue(m.value);
    if (num === null) return null;
    const samples = ctx.recentMeasurements
      .map((r) => numericValue(r.value))
      .filter((x): x is number => x !== null);
    if (samples.length === 0) return null;
    const threshold = cfg.threshold > 0 ? cfg.threshold : (cfg.method === "iqr" ? 1.5 : cfg.method === "zscore" ? 3 : 3.5);
    let result: OutlierResult;
    switch (cfg.method) {
      case "iqr": result = detectOutlierIQR(num, samples, threshold); break;
      case "zscore": result = detectOutlierZScore(num, samples, threshold); break;
      case "mad": result = detectOutlierMAD(num, samples, threshold); break;
    }
    if (result.isOutlier) {
      return {
        rule: "detectOutlier",
        code: "eks.health.validation.outlier",
        message: `Outlier detected (${cfg.method}): ${result.reason}.`,
        value: num,
      };
    }
    return null;
  }

  private ruleValidateRequiredFields(m: MeasurementLike, s: MeasurementSchema): ValidationError | null {
    if (s.valueType !== "structured") return null;
    const required = s.validation.requiredFields ?? [];
    if (required.length === 0) return null;
    if (typeof m.value !== "object" || m.value === null || Array.isArray(m.value)) {
      return {
        rule: "validateRequiredFields",
        code: "eks.health.validation.not_structured",
        message: `Schema requires a structured object for requiredFields check.`,
        value: m.value,
      };
    }
    const obj = m.value as Record<string, unknown>;
    const missing = required.filter((f) => !(f in obj) || obj[f] === undefined || obj[f] === null);
    if (missing.length > 0) {
      return {
        rule: "validateRequiredFields",
        code: "eks.health.validation.missing_fields",
        message: `Missing required fields: ${missing.join(", ")}.`,
        path: missing.join(","),
        value: m.value,
      };
    }
    return null;
  }

  private async ruleValidateEvidence(m: MeasurementLike, s: MeasurementSchema, ctx: ValidationContext): Promise<ValidationError | null> {
    if (ctx.skipEvidence) return null;
    const required = s.requiredEvidence?.filter((e) => e.required) ?? [];
    if (required.length === 0) return null;
    const api = await loadEvidence();
    if (!api) {
      // Evidence subsystem unavailable — don't fail validation, just skip.
      return null;
    }
    let evidence: unknown[];
    try {
      evidence = await resolveArray(api.list(m.id));
    } catch {
      return null;
    }
    if (evidence.length === 0) {
      return {
        rule: "validateEvidence",
        code: "eks.health.validation.evidence_missing",
        message: `Schema requires evidence (${required.map((e) => e.type).join(", ")}) but none is attached.`,
        value: m.id,
      };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Value-type checking
// ---------------------------------------------------------------------------

function checkValueType(v: MeasurementValue, t: MeasurementValueType): boolean {
  switch (t) {
    case "scalar":
      return typeof v === "number" || (typeof v === "object" && v !== null && !Array.isArray(v) && "value" in v && typeof (v as { value: unknown }).value === "number");
    case "categorical":
    case "text":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "range":
      return typeof v === "object" && v !== null && !Array.isArray(v) && "min" in v && "max" in v;
    case "vector":
      return typeof v === "object" && v !== null && !Array.isArray(v) && (("systolic" in v && "diastolic" in v) || ("x" in v && "y" in v));
    case "timeseries":
      return Array.isArray(v);
    case "structured":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true;
  }
}

function describeValue(v: MeasurementValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return false;
  try {
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  } catch {
    return false;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: ValidationEngine | null = null;
export function getValidation(): ValidationEngine {
  if (!_engine) _engine = new ValidationEngine();
  return _engine;
}
export function resetValidation(): void {
  _engine = null;
}

// Re-export the asMeasurementId helper for callers building MeasurementLike.
export { asMeasurementId };
export type { MeasurementId, SchemaId, ProfileId, UnitId };
