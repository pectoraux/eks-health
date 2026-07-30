/**
 * Eks-Health Universal Health Data Platform — Composite Measurements
 *
 * Programs define composite metrics (e.g. "Metabolic Health Score" composed of
 * weight, waist circumference, blood pressure, HbA1c, triglycerides, HDL).
 * Programs define formulas; the platform executes them generically.
 *
 * Capabilities:
 *  - Register composite metric definitions (components, formula, scale).
 *  - Compute a composite for a participant at the latest time or at a past time.
 *  - Compute all registered composites for a participant.
 *  - Validate a formula references only declared components.
 *
 * Formula evaluation uses a SAFE recursive-descent parser (NO eval). Supported:
 *  - Numbers (int, float, scientific)
 *  - Variables (component slugs / short names)
 *  - Operators: + - * / with precedence and parentheses
 *  - Unary minus
 *  - Functions: min, max, avg, sum, pow, abs, sqrt, log, exp, floor, ceil, round
 *
 * Component transforms: normalize, log, inverse — applied to the raw component
 * value before the formula is evaluated.
 */

import "server-only";
import {
  type CompositeMetricId,
  type ProfileId,
  type MeasurementId,
  type SchemaId,
  type UnitId,
  type MeasurementValue,
  HealthError,
  HEALTH_EVENTS,
  asCompositeMetricId,
} from "../core";
import type { CompositeComponent, MeasurementSchema } from "../schemas";
import { getSchemas } from "../schemas";
import { getUnits } from "../units";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Composite types
// ---------------------------------------------------------------------------

export type CompositeScale = "0-100" | "0-1" | "custom";

export interface CompositeMetric {
  readonly id: CompositeMetricId;
  readonly schemaId?: SchemaId; // the schema that defines this composite (if any)
  readonly programId?: string;
  readonly name: string;
  readonly description: string;
  readonly components: CompositeComponent[];
  readonly formula: string; // arithmetic expression referencing component slugs
  readonly scale: CompositeScale;
  readonly unit?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompositeInput {
  readonly schemaId?: SchemaId;
  readonly programId?: string;
  readonly name: string;
  readonly description: string;
  readonly components: CompositeComponent[];
  readonly formula: string;
  readonly scale?: CompositeScale;
  readonly unit?: string;
}

export interface CompositeComponentValue {
  readonly schemaSlug: string;
  readonly schemaId?: SchemaId;
  readonly rawValue: number | null;
  readonly transformedValue: number | null;
  readonly transform?: string;
  readonly timestamp: string | null;
  readonly missing: boolean;
}

export interface CompositeResult {
  readonly metricId: CompositeMetricId;
  readonly profileId: ProfileId;
  readonly score: number;
  readonly unit?: string;
  readonly scale: CompositeScale;
  readonly componentValues: readonly CompositeComponentValue[];
  readonly computedAt: string;
  readonly atTime?: string;
  readonly trace: readonly string[];
  readonly warnings: readonly string[];
}

export type { CompositeComponent } from "../schemas";

// ---------------------------------------------------------------------------
// Defensive measurements loader (m4-2 ships ../measurements in parallel).
// ---------------------------------------------------------------------------

interface MeasurementLike {
  readonly id: MeasurementId;
  readonly profileId: ProfileId;
  readonly schemaId: SchemaId;
  readonly value: MeasurementValue;
  readonly unitId?: UnitId;
  readonly timestamp: string;
  readonly [k: string]: unknown;
}

interface MeasurementsApi {
  list(filter?: Record<string, unknown>): MeasurementLike[] | Promise<MeasurementLike[]>;
  listByProfile(profileId: ProfileId): MeasurementLike[] | Promise<MeasurementLike[]>;
  getTrend?(
    profileId: ProfileId,
    schemaId: SchemaId,
    from: string,
    to: string,
  ): MeasurementLike[] | Promise<MeasurementLike[]>;
}

const MEASUREMENTS_PATH = "../measurements";
let _measurementsCache: MeasurementsApi | null | undefined;

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

async function resolveArray<T>(v: T[] | Promise<T[]> | undefined | null): Promise<T[]> {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  return await v;
}

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

// ---------------------------------------------------------------------------
// Safe expression parser (recursive descent, NO eval)
// ---------------------------------------------------------------------------

type Token =
  | { type: "num"; value: number }
  | { type: "ident"; value: string }
  | { type: "op"; value: "+" | "-" | "*" | "/" }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" };

const KNOWN_FUNCTIONS = new Set([
  "min", "max", "avg", "sum", "pow", "abs", "sqrt", "log", "exp", "floor", "ceil", "round",
]);

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const isDigit = (ch: string) => ch >= "0" && ch <= "9";
    if (isDigit(c) || (c === "." && isDigit(expr[i + 1] ?? ""))) {
      let num = "";
      while (i < expr.length && (isDigit(expr[i]) || expr[i] === ".")) { num += expr[i]; i++; }
      if (expr[i] === "e" || expr[i] === "E") {
        num += expr[i]; i++;
        if (expr[i] === "+" || expr[i] === "-") { num += expr[i]; i++; }
        while (i < expr.length && isDigit(expr[i])) { num += expr[i]; i++; }
      }
      const v = Number.parseFloat(num);
      if (!Number.isFinite(v)) {
        throw new HealthError({ code: "eks.health.expr.bad_number", category: "schema_invalid", message: `Invalid number '${num}'.` });
      }
      tokens.push({ type: "num", value: v });
      continue;
    }
    const isAlpha = (ch: string) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
    if (isAlpha(c)) {
      let id = "";
      while (i < expr.length && (isAlpha(expr[i]) || isDigit(expr[i]))) { id += expr[i]; i++; }
      tokens.push({ type: "ident", value: id });
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/") { tokens.push({ type: "op", value: c }); i++; continue; }
    if (c === "(") { tokens.push({ type: "lparen" }); i++; continue; }
    if (c === ")") { tokens.push({ type: "rparen" }); i++; continue; }
    if (c === ",") { tokens.push({ type: "comma" }); i++; continue; }
    throw new HealthError({ code: "eks.health.expr.bad_char", category: "schema_invalid", message: `Unexpected character '${c}' in expression.` });
  }
  return tokens;
}

class ExprParser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly vars: Map<string, number>) {}

  parse(): number {
    if (this.tokens.length === 0) {
      throw new HealthError({ code: "eks.health.expr.empty", category: "schema_invalid", message: "Empty expression." });
    }
    const v = this.parseExpr();
    if (this.pos < this.tokens.length) {
      throw new HealthError({ code: "eks.health.expr.trailing", category: "schema_invalid", message: "Unexpected trailing tokens." });
    }
    return v;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    while (this.peekIsOp("+") || this.peekIsOp("-")) {
      const op = (this.next() as { type: "op"; value: "+" | "-" }).value;
      const right = this.parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    while (this.peekIsOp("*") || this.peekIsOp("/")) {
      const op = (this.next() as { type: "op"; value: "*" | "/" }).value;
      const right = this.parseFactor();
      if (op === "*") left = left * right;
      else {
        if (right === 0) throw new HealthError({ code: "eks.health.expr.div_zero", category: "schema_invalid", message: "Division by zero." });
        left = left / right;
      }
    }
    return left;
  }

  private parseFactor(): number {
    const t = this.peek();
    if (!t) throw new HealthError({ code: "eks.health.expr.unexpected_end", category: "schema_invalid", message: "Unexpected end of expression." });
    if (t.type === "num") { this.next(); return t.value; }
    if (t.type === "op" && t.value === "-") { this.next(); return -this.parseFactor(); }
    if (t.type === "op" && t.value === "+") { this.next(); return this.parseFactor(); }
    if (t.type === "ident") {
      this.next();
      if (this.peek()?.type === "lparen") {
        this.next();
        const args: number[] = [];
        if (this.peek()?.type !== "rparen") {
          args.push(this.parseExpr());
          while (this.peek()?.type === "comma") {
            this.next();
            args.push(this.parseExpr());
          }
        }
        if (this.peek()?.type !== "rparen") {
          throw new HealthError({ code: "eks.health.expr.missing_paren", category: "schema_invalid", message: "Expected ')' after function arguments." });
        }
        this.next();
        return this.applyFunction(t.value, args);
      }
      if (!this.vars.has(t.value)) {
        throw new HealthError({ code: "eks.health.expr.unknown_var", category: "schema_invalid", message: `Unknown variable '${t.value}'.` });
      }
      return this.vars.get(t.value)!;
    }
    if (t.type === "lparen") {
      this.next();
      const v = this.parseExpr();
      if (this.peek()?.type !== "rparen") {
        throw new HealthError({ code: "eks.health.expr.missing_paren", category: "schema_invalid", message: "Expected ')'." });
      }
      this.next();
      return v;
    }
    throw new HealthError({ code: "eks.health.expr.unexpected_token", category: "schema_invalid", message: "Unexpected token in expression." });
  }

  private applyFunction(name: string, args: number[]): number {
    switch (name) {
      case "min": this.requireArgs(name, args, 1); return Math.min(...args);
      case "max": this.requireArgs(name, args, 1); return Math.max(...args);
      case "avg": this.requireArgs(name, args, 1); return args.reduce((a, b) => a + b, 0) / args.length;
      case "sum": this.requireArgs(name, args, 1); return args.reduce((a, b) => a + b, 0);
      case "pow": this.requireArgs(name, args, 2); return Math.pow(args[0], args[1]);
      case "abs": this.requireArgs(name, args, 1); return Math.abs(args[0]);
      case "sqrt": this.requireArgs(name, args, 1); return Math.sqrt(args[0]);
      case "log": this.requireArgs(name, args, 1); return Math.log(args[0]);
      case "exp": this.requireArgs(name, args, 1); return Math.exp(args[0]);
      case "floor": this.requireArgs(name, args, 1); return Math.floor(args[0]);
      case "ceil": this.requireArgs(name, args, 1); return Math.ceil(args[0]);
      case "round": this.requireArgs(name, args, 1); return Math.round(args[0]);
      default: throw new HealthError({ code: "eks.health.expr.unknown_func", category: "schema_invalid", message: `Unknown function '${name}'.` });
    }
  }

  private requireArgs(name: string, args: number[], min: number): void {
    if (args.length < min) {
      throw new HealthError({ code: "eks.health.expr.few_args", category: "schema_invalid", message: `Function '${name}' requires at least ${min} argument(s).` });
    }
  }

  private peek(): Token | null { return this.tokens[this.pos] ?? null; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private peekIsOp(v: "+" | "-" | "*" | "/"): boolean {
    const t = this.peek();
    return !!t && t.type === "op" && t.value === v;
  }
}

function evaluateExpression(expr: string, vars: Map<string, number>): number {
  const tokens = tokenize(expr);
  const parser = new ExprParser(tokens, vars);
  return parser.parse();
}

// ---------------------------------------------------------------------------
// Composite engine
// ---------------------------------------------------------------------------

export class CompositeEngine {
  private readonly metrics = new Map<CompositeMetricId, CompositeMetric>();
  private readonly bySchema = new Map<SchemaId, CompositeMetricId[]>();

  /** Register a composite metric definition. */
  register(input: CompositeInput): CompositeMetric {
    this.validateFormula(input.formula, input.components.map((c) => c.schemaSlug));
    const now = getClock().iso();
    const metric: CompositeMetric = {
      id: asCompositeMetricId(generateId("cmp_")),
      schemaId: input.schemaId,
      programId: input.programId,
      name: input.name,
      description: input.description,
      components: input.components,
      formula: input.formula,
      scale: input.scale ?? "0-100",
      unit: input.unit,
      createdAt: now,
      updatedAt: now,
    };
    this.metrics.set(metric.id, metric);
    if (metric.schemaId) {
      const list = this.bySchema.get(metric.schemaId) ?? [];
      this.bySchema.set(metric.schemaId, [...list, metric.id]);
    }
    return metric;
  }

  list(): CompositeMetric[] {
    return [...this.metrics.values()];
  }

  get(id: CompositeMetricId): CompositeMetric | undefined {
    return this.metrics.get(id);
  }

  getBySchema(schemaId: SchemaId): CompositeMetric[] {
    const ids = this.bySchema.get(schemaId) ?? [];
    return ids.map((id) => this.metrics.get(id)!).filter(Boolean);
  }

  /**
   * Compute a composite for a participant. Fetches the latest (or at-time)
   * value of each component measurement, applies transforms, evaluates the
   * formula, and returns a CompositeResult with a full computation trace.
   */
  async compute(profileId: ProfileId, metricId: CompositeMetricId, atTime?: string): Promise<CompositeResult> {
    const metric = this.metrics.get(metricId);
    if (!metric) {
      throw new HealthError({
        code: "eks.health.composite.not_found",
        category: "not_found",
        message: `Composite metric ${metricId} not found.`,
        userMessage: "Composite metric not found.",
      });
    }
    const api = await loadMeasurements();
    const trace: string[] = [];
    const warnings: string[] = [];
    trace.push(`computing composite '${metric.name}' for profile ${profileId}${atTime ? ` at ${atTime}` : " (latest)"}`);

    if (!api) {
      warnings.push("measurements subsystem unavailable; all components will be missing");
      trace.push("WARNING: measurements subsystem unavailable");
    }

    const vars = new Map<string, number>();
    const componentValues: CompositeComponentValue[] = [];

    for (const comp of metric.components) {
      const schema = this.findSchemaBySlug(comp.schemaSlug);
      if (!schema) {
        warnings.push(`component '${comp.schemaSlug}': schema not found`);
        trace.push(`component '${comp.schemaSlug}': schema NOT FOUND`);
        componentValues.push({
          schemaSlug: comp.schemaSlug,
          rawValue: null,
          transformedValue: null,
          transform: comp.transform,
          timestamp: null,
          missing: true,
        });
        continue;
      }

      const raw = await this.fetchLatest(profileId, schema, api, atTime);
      if (!raw) {
        warnings.push(`component '${comp.schemaSlug}': no measurement found${atTime ? ` at/before ${atTime}` : ""}`);
        trace.push(`component '${comp.schemaSlug}' (${schema.id}): no measurement`);
        componentValues.push({
          schemaSlug: comp.schemaSlug,
          schemaId: schema.id,
          rawValue: null,
          transformedValue: null,
          transform: comp.transform,
          timestamp: null,
          missing: true,
        });
        continue;
      }

      const rawNum = numericValue(raw.value);
      if (rawNum === null) {
        warnings.push(`component '${comp.schemaSlug}': value not numeric`);
        trace.push(`component '${comp.schemaSlug}': value=${JSON.stringify(raw.value)} (non-numeric)`);
        componentValues.push({
          schemaSlug: comp.schemaSlug,
          schemaId: schema.id,
          rawValue: null,
          transformedValue: null,
          transform: comp.transform,
          timestamp: raw.timestamp,
          missing: false,
        });
        continue;
      }

      const transformed = applyTransform(rawNum, comp.transform, schema);
      trace.push(`component '${comp.schemaSlug}': raw=${rawNum} → transform='${comp.transform ?? "identity"}' → ${transformed}`);
      // Bind both the slug and a stripped short name (e.g. weight_kg → weight).
      vars.set(comp.schemaSlug, transformed);
      const short = stripUnitSuffix(comp.schemaSlug);
      if (short !== comp.schemaSlug) vars.set(short, transformed);

      componentValues.push({
        schemaSlug: comp.schemaSlug,
        schemaId: schema.id,
        rawValue: rawNum,
        transformedValue: transformed,
        transform: comp.transform,
        timestamp: raw.timestamp,
        missing: false,
      });
    }

    let score: number;
    try {
      score = evaluateExpression(metric.formula, vars);
      trace.push(`formula '${metric.formula}' evaluated → ${score}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace.push(`formula evaluation FAILED: ${msg}`);
      throw new HealthError({
        code: "eks.health.composite.formula_error",
        category: "schema_invalid",
        message: `Formula evaluation failed: ${msg}`,
        userMessage: "Composite formula could not be evaluated.",
        metadata: { formula: metric.formula, trace },
      });
    }

    // Apply scale normalization.
    if (metric.scale === "0-100") {
      score = clamp(score, 0, 100);
      trace.push(`scale 0-100: clamped → ${score}`);
    } else if (metric.scale === "0-1") {
      score = clamp(score, 0, 1);
      trace.push(`scale 0-1: clamped → ${score}`);
    }

    const result: CompositeResult = {
      metricId: metric.id,
      profileId,
      score,
      unit: metric.unit,
      scale: metric.scale,
      componentValues,
      computedAt: getClock().iso(),
      atTime,
      trace,
      warnings,
    };

    void getEventBus().publish(
      buildEvent(
        HEALTH_EVENTS.compositeComputed,
        { metricId: metric.id, profileId, score, scale: metric.scale, atTime },
        {},
        "domain",
      ),
    );

    return result;
  }

  /** Compute all registered composites for a participant. */
  async computeAll(profileId: ProfileId, atTime?: string): Promise<CompositeResult[]> {
    const out: CompositeResult[] = [];
    for (const metric of this.metrics.values()) {
      try {
        out.push(await this.compute(profileId, metric.id, atTime));
      } catch (e) {
        // Skip a metric that fails to compute (e.g. missing components); report it in warnings.
        out.push({
          metricId: metric.id,
          profileId,
          score: NaN,
          unit: metric.unit,
          scale: metric.scale,
          componentValues: [],
          computedAt: getClock().iso(),
          atTime,
          trace: [`compute skipped: ${e instanceof Error ? e.message : String(e)}`],
          warnings: [`failed to compute: ${e instanceof Error ? e.message : String(e)}`],
        });
      }
    }
    return out;
  }

  /**
   * Validate a formula references only declared components (real validation).
   * Returns the list of unknown identifiers (empty if valid).
   */
  validateFormula(formula: string, componentNames: string[]): { valid: boolean; unknown: string[]; error?: string } {
    const known = new Set<string>();
    for (const n of componentNames) {
      known.add(n);
      const short = stripUnitSuffix(n);
      if (short !== n) known.add(short);
    }
    let tokens: Token[];
    try {
      tokens = tokenize(formula);
    } catch (e) {
      return { valid: false, unknown: [], error: e instanceof Error ? e.message : String(e) };
    }
    const unknown: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === "ident") {
        const isFunc = tokens[i + 1]?.type === "lparen";
        if (isFunc) {
          if (!KNOWN_FUNCTIONS.has(t.value) && !known.has(t.value)) unknown.push(t.value);
        } else if (!known.has(t.value)) {
          unknown.push(t.value);
        }
      }
    }
    // Validate structural integrity via a dry-run parse with distinct dummy values.
    if (unknown.length === 0) {
      try {
        const dummyVars = new Map<string, number>();
        let i = 0;
        for (const v of known) {
          dummyVars.set(v, PRIMES[i % PRIMES.length]);
          i++;
        }
        // Suppress runtime math errors by ignoring the result; we only care that it parses.
        void evaluateExpression(formula, dummyVars);
      } catch (e) {
        return { valid: false, unknown: [], error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { valid: unknown.length === 0, unknown };
  }

  // --- internals -----------------------------------------------------------

  private findSchemaBySlug(slug: string): MeasurementSchema | undefined {
    const all = getSchemas().list();
    return all.find((s) => s.slug === slug);
  }

  private async fetchLatest(
    profileId: ProfileId,
    schema: MeasurementSchema,
    api: MeasurementsApi | null,
    atTime?: string,
  ): Promise<MeasurementLike | null> {
    if (!api) return null;
    let list: MeasurementLike[] = [];
    if (atTime && typeof api.getTrend === "function") {
      const from = new Date(0).toISOString();
      list = await resolveArray(api.getTrend(profileId, schema.id, from, atTime));
    } else {
      list = await resolveArray(api.listByProfile(profileId));
      list = list.filter((m) => m.schemaId === schema.id);
      if (atTime) list = list.filter((m) => Date.parse(m.timestamp) <= Date.parse(atTime));
    }
    if (list.length === 0) return null;
    // Latest by timestamp.
    return list.reduce((best, m) => (!best || Date.parse(m.timestamp) > Date.parse(best.timestamp) ? m : best));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];

const UNIT_SUFFIXES = [
  "_kg", "_g", "_lb", "_oz",
  "_m", "_cm", "_mm", "_ft", "_in",
  "_c", "_f", "_k",
  "_mmhg", "_kpa", "_psi",
  "_bpm",
  "_l", "_ml",
  "_s", "_min", "_h", "_d",
  "_pct",
  "_mgdl", "_mg_dl", "_mmoll", "_mmol_l", "_ugml",
  "_kcal", "_kj",
  "_hz",
];

function stripUnitSuffix(slug: string): string {
  for (const suf of UNIT_SUFFIXES) {
    if (slug.endsWith(suf) && slug.length > suf.length) {
      return slug.slice(0, slug.length - suf.length);
    }
  }
  return slug;
}

function applyTransform(value: number, transform: string | undefined, schema: MeasurementSchema | undefined): number {
  if (!transform) return value;
  switch (transform) {
    case "log":
      if (value <= 0) return NaN;
      return Math.log(value);
    case "inverse":
      if (value === 0) return NaN;
      return 1 / value;
    case "normalize": {
      const min = schema?.validation.min;
      const max = schema?.validation.max;
      if (typeof min === "number" && typeof max === "number" && max > min) {
        return clamp((value - min) / (max - min), 0, 1);
      }
      // Without reference bounds, fall back to value/100 (assume percentage scale).
      return clamp(value / 100, 0, 1);
    }
    default:
      return value;
  }
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return v;
  return Math.max(min, Math.min(max, v));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: CompositeEngine | null = null;
export function getComposite(): CompositeEngine {
  if (!_engine) _engine = new CompositeEngine();
  return _engine;
}
export function resetComposite(): void {
  _engine = null;
}

export { HEALTH_EVENTS, asCompositeMetricId };
export type { CompositeMetricId, ProfileId };
