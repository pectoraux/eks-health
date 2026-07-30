/**
 * Eks-Health Universal Health Data Platform — Derived Measurements
 *
 * Automatic calculations derived from raw measurements: BMI, Body Surface
 * Area, risk scores, moving averages, improvement rates, compliance
 * percentages, trend indicators. Programs define derivation logic; the
 * platform executes it generically.
 *
 * Pre-registered built-in derived metrics:
 *  1. bmi                    — weight / (height²)
 *  2. body_surface_area      — Du Bois formula
 *  3. moving_average_7d      — mean of last 7 days of a schema
 *  4. improvement_rate       — (latest − first) / first × 100
 *  5. compliance_pct         — count in period / expected × 100
 *  6. trend_indicator        — up | down | stable from linear-regression slope
 *
 * Formula evaluation uses the SAME safe recursive-descent parser as the
 * composite engine (duplicated here to keep each subsystem self-contained).
 */

import "server-only";
import {
  type DerivedMetricId,
  type ProfileId,
  type MeasurementId,
  type SchemaId,
  type UnitId,
  type MeasurementValue,
  HealthError,
  HEALTH_EVENTS,
  asDerivedMetricId,
} from "../core";
import type { MeasurementSchema } from "../schemas";
import { getSchemas } from "../schemas";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Derived types
// ---------------------------------------------------------------------------

export type DerivedCategory =
  | "anthropometric"
  | "vital"
  | "metabolic"
  | "trend"
  | "compliance"
  | "risk"
  | "custom";

export type DerivationFunction =
  | { readonly kind: "formula"; readonly expression: string }
  | { readonly kind: "builtin"; readonly name: BuiltinName };

export type BuiltinName =
  | "moving_average_7d"
  | "improvement_rate"
  | "compliance_pct"
  | "trend_indicator";

export interface DerivedMetric {
  readonly id: DerivedMetricId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: string[]; // input schema slugs
  readonly outputUnit?: string;
  readonly function: DerivationFunction;
  readonly category: DerivedCategory;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DerivationInput {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly inputs: string[];
  readonly outputUnit?: string;
  readonly function: DerivationFunction;
  readonly category?: DerivedCategory;
  readonly params?: Record<string, unknown>;
}

export interface DerivationResult {
  readonly metricId: DerivedMetricId;
  readonly slug: string;
  readonly profileId: ProfileId;
  readonly value: number | string;
  readonly unit?: string;
  readonly inputs: ReadonlyArray<{
    readonly slug: string;
    readonly schemaId?: SchemaId;
    readonly value: number | null;
    readonly timestamp: string | null;
    readonly missing: boolean;
  }>;
  readonly computedAt: string;
  readonly atTime?: string;
  readonly trace: readonly string[];
  readonly warnings: readonly string[];
}

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
// Safe expression parser (recursive descent, NO eval) — duplicated from
// composite to keep each subsystem self-contained.
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
// Derived engine
// ---------------------------------------------------------------------------

export class DerivedEngine {
  private readonly metrics = new Map<DerivedMetricId, DerivedMetric>();
  private readonly bySlug = new Map<string, DerivedMetricId>();

  constructor() {
    this.registerBuiltins();
  }

  /** Register a derived metric. */
  register(input: DerivationInput): DerivedMetric {
    if (!/^[a-z0-9_]+$/.test(input.slug)) {
      throw new HealthError({
        code: "eks.health.derived.invalid_slug",
        category: "schema_invalid",
        message: "Slug must be lowercase snake_case.",
      });
    }
    if (this.bySlug.has(input.slug)) {
      throw new HealthError({
        code: "eks.health.derived.duplicate_slug",
        category: "state_conflict",
        message: `Derived metric slug '${input.slug}' already registered.`,
      });
    }
    if (input.function.kind === "formula") {
      this.validateFormula(input.function.expression, input.inputs);
    }
    const now = getClock().iso();
    const metric: DerivedMetric = {
      id: asDerivedMetricId(generateId("der_")),
      slug: input.slug,
      name: input.name,
      description: input.description,
      inputs: input.inputs,
      outputUnit: input.outputUnit,
      function: input.function,
      category: input.category ?? "custom",
      params: input.params,
      createdAt: now,
      updatedAt: now,
    };
    this.metrics.set(metric.id, metric);
    this.bySlug.set(metric.slug, metric.id);
    return metric;
  }

  list(): DerivedMetric[] {
    return [...this.metrics.values()];
  }

  get(id: DerivedMetricId): DerivedMetric | undefined {
    return this.metrics.get(id);
  }

  getBySlug(slug: string): DerivedMetric | undefined {
    const id = this.bySlug.get(slug);
    return id ? this.metrics.get(id) : undefined;
  }

  /** Compute a derived metric for a participant. */
  async compute(profileId: ProfileId, metricId: DerivedMetricId, atTime?: string): Promise<DerivationResult> {
    const metric = this.metrics.get(metricId);
    if (!metric) {
      throw new HealthError({
        code: "eks.health.derived.not_found",
        category: "not_found",
        message: `Derived metric ${metricId} not found.`,
        userMessage: "Derived metric not found.",
      });
    }
    const api = await loadMeasurements();
    const trace: string[] = [];
    const warnings: string[] = [];
    trace.push(`computing derived '${metric.slug}' for profile ${profileId}${atTime ? ` at ${atTime}` : " (latest)"}`);

    if (!api) {
      warnings.push("measurements subsystem unavailable");
      trace.push("WARNING: measurements subsystem unavailable");
    }

    // Fetch all input measurements for this profile.
    const inputMeasurements = new Map<string, MeasurementLike[]>();
    for (const slug of metric.inputs) {
      const schema = this.findSchemaBySlug(slug);
      if (!schema) {
        warnings.push(`input '${slug}': schema not found`);
        trace.push(`input '${slug}': schema NOT FOUND`);
        inputMeasurements.set(slug, []);
        continue;
      }
      const list = await this.fetchForSchema(profileId, schema, api, atTime);
      inputMeasurements.set(slug, list);
      trace.push(`input '${slug}' (${schema.id}): ${list.length} measurement(s)`);
    }

    let value: number | string;
    if (metric.function.kind === "formula") {
      value = this.computeFormula(metric, inputMeasurements, trace, warnings);
    } else {
      value = this.computeBuiltin(metric, inputMeasurements, trace, warnings, atTime);
    }

    const inputs: DerivationResult["inputs"] = metric.inputs.map((slug) => {
      const list = inputMeasurements.get(slug) ?? [];
      if (list.length === 0) {
        return { slug, value: null, timestamp: null, missing: true };
      }
      const latest = list.reduce((b, m) => (!b || Date.parse(m.timestamp) > Date.parse(b.timestamp) ? m : b));
      return {
        slug,
        schemaId: this.findSchemaBySlug(slug)?.id,
        value: numericValue(latest.value),
        timestamp: latest.timestamp,
        missing: false,
      };
    });

    const result: DerivationResult = {
      metricId: metric.id,
      slug: metric.slug,
      profileId,
      value,
      unit: metric.outputUnit,
      inputs,
      computedAt: getClock().iso(),
      atTime,
      trace,
      warnings,
    };

    void getEventBus().publish(
      buildEvent(
        HEALTH_EVENTS.derivedComputed,
        { metricId: metric.id, slug: metric.slug, profileId, value },
        {},
        "domain",
      ),
    );

    return result;
  }

  /** Compute all registered derived metrics for a participant. */
  async computeAll(profileId: ProfileId, atTime?: string): Promise<DerivationResult[]> {
    const out: DerivationResult[] = [];
    for (const metric of this.metrics.values()) {
      try {
        out.push(await this.compute(profileId, metric.id, atTime));
      } catch (e) {
        out.push({
          metricId: metric.id,
          slug: metric.slug,
          profileId,
          value: NaN,
          unit: metric.outputUnit,
          inputs: [],
          computedAt: getClock().iso(),
          atTime,
          trace: [`compute skipped: ${e instanceof Error ? e.message : String(e)}`],
          warnings: [`failed: ${e instanceof Error ? e.message : String(e)}`],
        });
      }
    }
    return out;
  }

  /** Validate a formula references only declared inputs. */
  validateFormula(formula: string, inputSlugs: string[]): { valid: boolean; unknown: string[]; error?: string } {
    const known = new Set<string>();
    for (const s of inputSlugs) {
      known.add(s);
      const short = stripUnitSuffix(s);
      if (short !== s) known.add(short);
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
    if (unknown.length === 0) {
      try {
        const dummyVars = new Map<string, number>();
        let i = 0;
        for (const v of known) {
          dummyVars.set(v, PRIMES[i % PRIMES.length]);
          i++;
        }
        void evaluateExpression(formula, dummyVars);
      } catch (e) {
        return { valid: false, unknown: [], error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { valid: unknown.length === 0, unknown };
  }

  // --- formula computation -------------------------------------------------

  private computeFormula(
    metric: DerivedMetric,
    inputMeasurements: Map<string, MeasurementLike[]>,
    trace: string[],
    warnings: string[],
  ): number {
    const vars = new Map<string, number>();
    for (const slug of metric.inputs) {
      const list = inputMeasurements.get(slug) ?? [];
      if (list.length === 0) {
        warnings.push(`input '${slug}' missing — formula will fail`);
        continue;
      }
      const latest = list.reduce((b, m) => (!b || Date.parse(m.timestamp) > Date.parse(b.timestamp) ? m : b));
      const num = numericValue(latest.value);
      if (num === null) {
        warnings.push(`input '${slug}' non-numeric`);
        continue;
      }
      vars.set(slug, num);
      const short = stripUnitSuffix(slug);
      if (short !== slug) vars.set(short, num);
    }
    try {
      const v = evaluateExpression(metric.function.kind === "formula" ? metric.function.expression : "", vars);
      trace.push(`formula evaluated → ${v}`);
      return v;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      trace.push(`formula FAILED: ${msg}`);
      throw new HealthError({
        code: "eks.health.derived.formula_error",
        category: "schema_invalid",
        message: `Derivation formula failed: ${msg}`,
        userMessage: "Could not compute derived value.",
        metadata: { slug: metric.slug },
      });
    }
  }

  // --- builtin computation -------------------------------------------------

  private computeBuiltin(
    metric: DerivedMetric,
    inputMeasurements: Map<string, MeasurementLike[]>,
    trace: string[],
    warnings: string[],
    atTime?: string,
  ): number | string {
    const name = metric.function.kind === "builtin" ? metric.function.name : "";
    const primarySlug = metric.inputs[0];
    const list = primarySlug ? (inputMeasurements.get(primarySlug) ?? []) : [];
    const numericSeries = list
      .map((m) => ({ t: Date.parse(m.timestamp), v: numericValue(m.value) }))
      .filter((x): x is { t: number; v: number } => !Number.isNaN(x.t) && x.v !== null)
      .sort((a, b) => a.t - b.t);

    switch (name) {
      case "moving_average_7d": {
        const nowMs = atTime ? Date.parse(atTime) : getClock().epochMs();
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const recent = numericSeries.filter((x) => x.t >= nowMs - sevenDaysMs && x.t <= nowMs);
        if (recent.length === 0) {
          warnings.push("no measurements in last 7 days");
          trace.push("moving_average_7d: 0 samples → NaN");
          return NaN;
        }
        const mean = recent.reduce((s, x) => s + x.v, 0) / recent.length;
        trace.push(`moving_average_7d: ${recent.length} samples → mean ${mean}`);
        return mean;
      }
      case "improvement_rate": {
        if (numericSeries.length < 2) {
          warnings.push("need ≥2 measurements to compute improvement rate");
          trace.push("improvement_rate: <2 samples → NaN");
          return NaN;
        }
        const first = numericSeries[0]!;
        const last = numericSeries[numericSeries.length - 1]!;
        if (first.v === 0) {
          warnings.push("first value is zero; cannot compute percent change");
          trace.push("improvement_rate: first=0 → NaN");
          return NaN;
        }
        const pct = ((last.v - first.v) / Math.abs(first.v)) * 100;
        trace.push(`improvement_rate: (${last.v} − ${first.v}) / |${first.v}| × 100 = ${pct}`);
        return pct;
      }
      case "compliance_pct": {
        const periodDays = typeof metric.params?.periodDays === "number" ? metric.params.periodDays : 7;
        const expected = typeof metric.params?.expectedCount === "number" ? metric.params.expectedCount : periodDays;
        const nowMs = atTime ? Date.parse(atTime) : getClock().epochMs();
        const windowMs = periodDays * 24 * 60 * 60 * 1000;
        const inWindow = numericSeries.filter((x) => x.t >= nowMs - windowMs && x.t <= nowMs);
        if (expected <= 0) {
          warnings.push("expectedCount must be > 0");
          trace.push("compliance_pct: expected=0 → NaN");
          return NaN;
        }
        const pct = (inWindow.length / expected) * 100;
        trace.push(`compliance_pct: ${inWindow.length}/${expected} in ${periodDays}d → ${pct}%`);
        return pct;
      }
      case "trend_indicator": {
        if (numericSeries.length < 2) {
          warnings.push("need ≥2 measurements to compute trend");
          trace.push("trend_indicator: <2 samples → 'stable'");
          return "stable";
        }
        const slope = linearRegressionSlope(numericSeries);
        if (!Number.isFinite(slope)) {
          trace.push("trend_indicator: slope undefined → 'stable'");
          return "stable";
        }
        // Threshold: 1% of the mean absolute value per millisecond-day, or a tiny epsilon.
        const meanAbs = numericSeries.reduce((s, x) => s + Math.abs(x.v), 0) / numericSeries.length;
        const dayMs = 24 * 60 * 60 * 1000;
        const dailySlope = slope * dayMs;
        const threshold = Math.max(meanAbs * 0.01, 1e-9);
        let trend: "up" | "down" | "stable";
        if (dailySlope > threshold) trend = "up";
        else if (dailySlope < -threshold) trend = "down";
        else trend = "stable";
        trace.push(`trend_indicator: slope=${slope}/ms, daily=${dailySlope}, threshold=${threshold} → '${trend}'`);
        return trend;
      }
      default:
        throw new HealthError({
          code: "eks.health.derived.unknown_builtin",
          category: "schema_invalid",
          message: `Unknown builtin '${name}'.`,
        });
    }
  }

  // --- internals -----------------------------------------------------------

  private findSchemaBySlug(slug: string): MeasurementSchema | undefined {
    return getSchemas().list().find((s) => s.slug === slug);
  }

  private async fetchForSchema(
    profileId: ProfileId,
    schema: MeasurementSchema,
    api: MeasurementsApi | null,
    atTime?: string,
  ): Promise<MeasurementLike[]> {
    if (!api) return [];
    if (atTime && typeof api.getTrend === "function") {
      const from = new Date(0).toISOString();
      return resolveArray(api.getTrend(profileId, schema.id, from, atTime));
    }
    const all = await resolveArray(api.listByProfile(profileId));
    let list = all.filter((m) => m.schemaId === schema.id);
    if (atTime) list = list.filter((m) => Date.parse(m.timestamp) <= Date.parse(atTime));
    return list;
  }

  private registerBuiltins(): void {
    const now = getClock().iso();
    const builtins: DerivedMetric[] = [
      {
        id: asDerivedMetricId("der_builtin_bmi"),
        slug: "bmi",
        name: "Body Mass Index",
        description: "BMI = weight (kg) / height (m)²",
        inputs: ["weight_kg", "height_m"],
        outputUnit: "kg/m²",
        function: { kind: "formula", expression: "weight / (height * height)" },
        category: "anthropometric",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: asDerivedMetricId("der_builtin_bsa"),
        slug: "body_surface_area",
        name: "Body Surface Area (Du Bois)",
        description: "BSA = 0.007184 × weight^0.425 × height^0.725 (weight kg, height cm)",
        inputs: ["weight_kg", "height_cm"],
        outputUnit: "m²",
        function: { kind: "formula", expression: "0.007184 * pow(weight, 0.425) * pow(height, 0.725)" },
        category: "anthropometric",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: asDerivedMetricId("der_builtin_ma7"),
        slug: "moving_average_7d",
        name: "7-Day Moving Average",
        description: "Mean of the input schema's measurements in the last 7 days.",
        inputs: [], // bound dynamically; programs override `inputs` when registering a custom instance
        function: { kind: "builtin", name: "moving_average_7d" },
        category: "trend",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: asDerivedMetricId("der_builtin_impr"),
        slug: "improvement_rate",
        name: "Improvement Rate (%)",
        description: "(latest − first) / first × 100 over the input schema's series.",
        inputs: [],
        outputUnit: "%",
        function: { kind: "builtin", name: "improvement_rate" },
        category: "trend",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: asDerivedMetricId("der_builtin_comp"),
        slug: "compliance_pct",
        name: "Compliance (%)",
        description: "Count of measurements in period ÷ expected count × 100.",
        inputs: [],
        outputUnit: "%",
        function: { kind: "builtin", name: "compliance_pct" },
        category: "compliance",
        params: { periodDays: 7, expectedCount: 7 },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: asDerivedMetricId("der_builtin_trend"),
        slug: "trend_indicator",
        name: "Trend Indicator",
        description: "Up / down / stable from the linear-regression slope of the input series.",
        inputs: [],
        function: { kind: "builtin", name: "trend_indicator" },
        category: "trend",
        createdAt: now,
        updatedAt: now,
      },
    ];
    for (const m of builtins) {
      this.metrics.set(m.id, m);
      this.bySlug.set(m.slug, m.id);
    }
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

/**
 * Least-squares linear regression slope for series of (t, v) points.
 * Returns slope in units of v-per-millisecond.
 */
function linearRegressionSlope(points: ReadonlyArray<{ t: number; v: number }>): number {
  const n = points.length;
  if (n < 2) return NaN;
  let sumT = 0;
  let sumV = 0;
  for (const p of points) { sumT += p.t; sumV += p.v; }
  const meanT = sumT / n;
  const meanV = sumV / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - meanT) * (p.v - meanV);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) return NaN;
  return num / den;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: DerivedEngine | null = null;
export function getDerived(): DerivedEngine {
  if (!_engine) _engine = new DerivedEngine();
  return _engine;
}
export function resetDerived(): void {
  _engine = null;
}

export { HEALTH_EVENTS, asDerivedMetricId };
export type { DerivedMetricId, ProfileId };
