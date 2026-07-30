/**
 * Eks-Health Competition Platform — Scoring & Score Engine
 *
 * Programs define scoring formulas as weighted components (e.g. 40% weight
 * improvement, 25% blood-pressure improvement). The compiler validates,
 * compiles, simulates, and executes those specifications against real
 * verified measurements.
 *
 * Capabilities:
 *  - Weighted-component formulas with per-component weights (must sum to 100).
 *  - Aggregation modes: latest / average / max / min / improvement /
 *    improvement_percent / count / sum / custom.
 *  - Decay functions: linear, exponential, none.
 *  - Bonus + penalty conditions (safe expressions).
 *  - Custom per-component formulas via a SAFE recursive-descent parser
 *    (NO eval). Supports +, -, *, /, parentheses, comparisons, && / ||,
 *    and the functions min, max, avg, sum, pow, abs, sqrt, log, floor,
 *    ceil, round. Variable references resolve from the component
 *    environment (this component's `value` plus sibling component names).
 *  - Versioned scores, score history, manual review, rollback,
 *    auditability, and explainability (every ScoreRecord carries a
 *    human-readable breakdown).
 *  - Real-time / scheduled / historical recalculation.
 */

import "server-only";
import {
  type ScoreSpecId,
  type ScoreId,
  type ScoreComponent,
  type ScoreSpec,
  type ScoreRecord,
  type ScoreComponentResult,
  type ScoreComponentId,
  type CompetitionId,
  type SeasonId,
  type MeasurementId,
  CompetitionError,
  COMPETITION_EVENTS,
  asScoreId,
  asScoreSpecId,
} from "../core";
import type { AccountId } from "@/identity";
import type { ProgramId } from "@/programs";
import type { Measurement, MeasurementValue, SchemaId, ProfileId } from "@/health";
import { getMeasurements } from "@/health";
import { getProfiles } from "@/health";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types (re-exported)
// ---------------------------------------------------------------------------

export type {
  ScoreSpecId,
  ScoreId,
  ScoreComponent,
  ScoreSpec,
  ScoreRecord,
  ScoreComponentResult,
  ScoreComponentId,
};

// ---------------------------------------------------------------------------
// Validation, simulation, history types
// ---------------------------------------------------------------------------

export interface ScoreValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
  readonly warnings: string[];
  readonly totalWeight: number;
  readonly componentCount: number;
  readonly specId: ScoreSpecId;
  readonly version: number;
  readonly validatedAt: string;
}

export interface ScoreSimulationResult {
  readonly specId: ScoreSpecId;
  readonly participantId: AccountId;
  readonly simulatedAt: string;
  readonly totalScore: number;
  readonly components: ScoreComponentResult[];
  readonly measurementRefs: MeasurementId[];
  readonly notes: string[];
}

export interface ScoreHistoryEntry {
  readonly scoreId: ScoreId;
  readonly totalScore: number;
  readonly version: number;
  readonly computedAt: string;
  readonly action: "computed" | "recalculated" | "rolled_back" | "manual_review";
  readonly note: string;
  readonly actor?: AccountId;
}

/** Internal compiled-spec handle. */
export interface CompiledSpec {
  readonly spec: ScoreSpec;
  readonly compiledAt: string;
  readonly componentIndex: Map<ScoreComponentId, ScoreComponent>;
  readonly formulaAsts: Map<ScoreComponentId, ASTNode>;
  readonly bonusAsts: Map<string, ASTNode>;
  readonly penaltyAsts: Map<string, ASTNode>;
}

// ---------------------------------------------------------------------------
// Branded-id helpers for ids that have no `as*` helper in core
// ---------------------------------------------------------------------------

function asScoreComponentId(s: string): ScoreComponentId {
  return s as ScoreComponentId;
}

// ---------------------------------------------------------------------------
// Numeric extraction from MeasurementValue (which may be scalar, object,
// boolean, string, or structured)
// ---------------------------------------------------------------------------

function toNumeric(v: MeasurementValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === "object") {
    const o = v as { value?: unknown; systolic?: unknown; diastolic?: unknown };
    if (typeof o.value === "number") return o.value;
    if (typeof o.systolic === "number") return o.systolic;
    if (typeof o.diastolic === "number") return o.diastolic;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Safe recursive-descent expression parser (NO eval)
//
// Grammar:
//   expr     := or
//   or       := and ('||' and)*
//   and      := eq ('&&' eq)*
//   eq       := comp (('==' | '!=') comp)*
//   comp     := add (('>' | '<' | '>=' | '<=') add)*
//   add      := term (('+' | '-') term)*
//   term     := factor (('*' | '/') factor)*
//   factor   := '-' factor | '+' factor | primary
//   primary  := number | ident | ident '(' args ')' | '(' expr ')'
//   args     := expr (',' expr)*
//
// Booleans are represented as numbers (0/1). All functions take a variable
// number of arguments.
// ---------------------------------------------------------------------------

type TokenType = "num" | "ident" | "op" | "lparen" | "rparen" | "comma" | "eof";

interface Token {
  readonly kind: TokenType;
  readonly value: string;
  readonly pos: number;
}

const TWO_CHAR_OPS = new Set([">=", "<=", "==", "!="]);
const ONE_CHAR_OPS = new Set(["+", "-", "*", "/", ">", "<"]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "(") { tokens.push({ kind: "lparen", value: "(", pos: i }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen", value: ")", pos: i }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma", value: ",", pos: i }); i++; continue; }
    // Two-char operators
    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ kind: "op", value: two, pos: i }); i += 2; continue; }
    // One-char operators
    if (ONE_CHAR_OPS.has(ch)) { tokens.push({ kind: "op", value: ch, pos: i }); i++; continue; }
    // Number
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      let j = i;
      let seenDot = false;
      while (j < n && ((input[j] >= "0" && input[j] <= "9") || (input[j] === "." && !seenDot))) {
        if (input[j] === ".") seenDot = true;
        j++;
      }
      const num = input.slice(i, j);
      if (num === "." || num === "") {
        throw new CompetitionError({
          code: "eks.competition.scoring.formula.invalid_number",
          category: "score_invalid",
          message: `Invalid number literal at position ${i} in formula.`,
          userMessage: "The scoring formula contains an invalid number.",
          metadata: { formula: input, position: i },
        });
      }
      tokens.push({ kind: "num", value: num, pos: i });
      i = j;
      continue;
    }
    // Identifier (letters, digits, underscore; must start with letter/underscore)
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: "ident", value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw new CompetitionError({
      code: "eks.competition.scoring.formula.unexpected_char",
      category: "score_invalid",
      message: `Unexpected character '${ch}' at position ${i} in formula.`,
      userMessage: "The scoring formula contains an invalid character.",
      metadata: { formula: input, position: i, char: ch },
    });
  }
  tokens.push({ kind: "eof", value: "", pos: n });
  return tokens;
}

type ASTNode =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "unary"; op: "-" | "+"; operand: ASTNode }
  | { kind: "binary"; op: string; left: ASTNode; right: ASTNode }
  | { kind: "call"; name: string; args: ASTNode[] };

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ASTNode {
    const node = this.parseOr();
    if (this.peek().kind !== "eof") {
      const t = this.peek();
      throw new CompetitionError({
        code: "eks.competition.scoring.formula.unexpected_token",
        category: "score_invalid",
        message: `Unexpected token '${t.value}' at position ${t.pos}.`,
        userMessage: "The scoring formula has unexpected syntax.",
        metadata: { token: t.value, position: t.pos },
      });
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private parseOr(): ASTNode {
    let left = this.parseAnd();
    while (this.peek().kind === "op" && this.peek().value === "||") {
      this.next();
      const right = this.parseAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): ASTNode {
    let left = this.parseEq();
    while (this.peek().kind === "op" && this.peek().value === "&&") {
      this.next();
      const right = this.parseEq();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseEq(): ASTNode {
    let left = this.parseComp();
    while (this.peek().kind === "op" && (this.peek().value === "==" || this.peek().value === "!=")) {
      const op = this.next().value;
      const right = this.parseComp();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseComp(): ASTNode {
    let left = this.parseAdd();
    while (this.peek().kind === "op" && [">", "<", ">=", "<="].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseAdd();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseAdd(): ASTNode {
    let left = this.parseTerm();
    while (this.peek().kind === "op" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value;
      const right = this.parseTerm();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseTerm(): ASTNode {
    let left = this.parseFactor();
    while (this.peek().kind === "op" && (this.peek().value === "*" || this.peek().value === "/")) {
      const op = this.next().value;
      const right = this.parseFactor();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseFactor(): ASTNode {
    const t = this.peek();
    if (t.kind === "op" && (t.value === "-" || t.value === "+")) {
      this.next();
      const operand = this.parseFactor();
      return { kind: "unary", op: t.value as "-" | "+", operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const t = this.next();
    if (t.kind === "num") {
      return { kind: "num", value: parseFloat(t.value) };
    }
    if (t.kind === "lparen") {
      const inner = this.parseOr();
      const close = this.next();
      if (close.kind !== "rparen") {
        throw new CompetitionError({
          code: "eks.competition.scoring.formula.unclosed_paren",
          category: "score_invalid",
          message: `Expected ')' at position ${close.pos}.`,
          userMessage: "The scoring formula has an unclosed parenthesis.",
          metadata: { position: close.pos },
        });
      }
      return inner;
    }
    if (t.kind === "ident") {
      // Function call?
      if (this.peek().kind === "lparen") {
        this.next(); // consume '('
        const args: ASTNode[] = [];
        if (this.peek().kind !== "rparen") {
          args.push(this.parseOr());
          while (this.peek().kind === "comma") {
            this.next();
            args.push(this.parseOr());
          }
        }
        const close = this.next();
        if (close.kind !== "rparen") {
          throw new CompetitionError({
            code: "eks.competition.scoring.formula.unclosed_call",
            category: "score_invalid",
            message: `Expected ')' to close function call '${t.value}'.`,
            userMessage: "The scoring formula has an unclosed function call.",
            metadata: { fn: t.value },
          });
        }
        return { kind: "call", name: t.value, args };
      }
      return { kind: "var", name: t.value };
    }
    throw new CompetitionError({
      code: "eks.competition.scoring.formula.unexpected_token",
      category: "score_invalid",
      message: `Unexpected token '${t.value}' at position ${t.pos}.`,
      userMessage: "The scoring formula has unexpected syntax.",
      metadata: { token: t.value, position: t.pos },
    });
  }
}

const KNOWN_FUNCTIONS = new Set([
  "min", "max", "avg", "sum", "pow", "abs", "sqrt", "log", "floor", "ceil", "round",
]);

function parseFormula(formula: string): ASTNode {
  const tokens = tokenize(formula);
  const parser = new Parser(tokens);
  return parser.parse();
}

function evaluate(node: ASTNode, env: Map<string, number>): number {
  switch (node.kind) {
    case "num":
      return node.value;
    case "var": {
      const v = env.get(node.name);
      if (v === undefined) {
        // Unknown variable — default to 0 (component not yet computed / no data)
        return 0;
      }
      return v;
    }
    case "unary":
      return node.op === "-" ? -evaluate(node.operand, env) : evaluate(node.operand, env);
    case "binary": {
      const l = evaluate(node.left, env);
      const r = evaluate(node.right, env);
      switch (node.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return r === 0 ? 0 : l / r;
        case ">": return l > r ? 1 : 0;
        case "<": return l < r ? 1 : 0;
        case ">=": return l >= r ? 1 : 0;
        case "<=": return l <= r ? 1 : 0;
        case "==": return l === r ? 1 : 0;
        case "!=": return l !== r ? 1 : 0;
        case "&&": return (l !== 0 && r !== 0) ? 1 : 0;
        case "||": return (l !== 0 || r !== 0) ? 1 : 0;
        default:
          throw new CompetitionError({
            code: "eks.competition.scoring.formula.unknown_op",
            category: "score_invalid",
            message: `Unknown operator '${node.op}'.`,
            userMessage: "The scoring formula uses an unknown operator.",
          });
      }
    }
    case "call": {
      if (!KNOWN_FUNCTIONS.has(node.name)) {
        throw new CompetitionError({
          code: "eks.competition.scoring.formula.unknown_function",
          category: "score_invalid",
          message: `Unknown function '${node.name}'.`,
          userMessage: "The scoring formula calls an unknown function.",
          metadata: { fn: node.name },
        });
      }
      const args = node.args.map((a) => evaluate(a, env));
      switch (node.name) {
        case "min": return args.length === 0 ? 0 : Math.min(...args);
        case "max": return args.length === 0 ? 0 : Math.max(...args);
        case "avg": return args.length === 0 ? 0 : args.reduce((a, b) => a + b, 0) / args.length;
        case "sum": return args.reduce((a, b) => a + b, 0);
        case "pow": return args.length >= 2 ? Math.pow(args[0]!, args[1]!) : 0;
        case "abs": return args.length >= 1 ? Math.abs(args[0]!) : 0;
        case "sqrt": return args.length >= 1 && args[0]! >= 0 ? Math.sqrt(args[0]!) : 0;
        case "log": return args.length >= 1 && args[0]! > 0 ? Math.log(args[0]!) : 0;
        case "floor": return args.length >= 1 ? Math.floor(args[0]!) : 0;
        case "ceil": return args.length >= 1 ? Math.ceil(args[0]!) : 0;
        case "round": return args.length >= 1 ? Math.round(args[0]!) : 0;
        default: return 0;
      }
    }
    default:
      return 0;
  }
}

/** Validate a formula syntactically; returns an error string or null. */
function validateFormula(formula: string): string | null {
  try {
    const ast = parseFormula(formula);
    // Walk the AST to verify all calls are to known functions and vars are valid identifiers
    const errors: string[] = [];
    walk(ast, (n) => {
      if (n.kind === "call" && !KNOWN_FUNCTIONS.has(n.name)) {
        errors.push(`Unknown function '${n.name}'`);
      }
    });
    if (errors.length > 0) return errors.join("; ");
    // Avoid unused-var warning
    void ast;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function walk(node: ASTNode, visit: (n: ASTNode) => void): void {
  visit(node);
  switch (node.kind) {
    case "unary": walk(node.operand, visit); break;
    case "binary": walk(node.left, visit); walk(node.right, visit); break;
    case "call": node.args.forEach((a) => walk(a, visit)); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Measurement fetching — guarded against uninitialized health subsystems
// ---------------------------------------------------------------------------

interface MeasurementWindow {
  readonly measurements: Measurement[];
  readonly profileId?: ProfileId;
}

function fetchMeasurementsForParticipant(
  participantId: AccountId,
  schemaId: SchemaId | undefined,
  fromIso: string | undefined,
  toIso: string | undefined,
): MeasurementWindow {
  if (!schemaId) return { measurements: [] };
  try {
    // Resolve accountId → profileId via the profile registry.
    let profileId: ProfileId | undefined;
    try {
      profileId = getProfiles().get(participantId)?.id;
    } catch {
      profileId = undefined;
    }
    if (!profileId) return { measurements: [], profileId: undefined };
    const list = getMeasurements().list({
      profileId,
      schemaId,
      from: fromIso,
      to: toIso,
      includeSuperseded: false,
    });
    return { measurements: list, profileId };
  } catch {
    return { measurements: [] };
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface AggregationInput {
  readonly measurements: Measurement[];
  readonly aggregation: ScoreSpec["components"][number]["aggregation"];
  readonly baselineMode: ScoreSpec["components"][number]["baselineMode"];
}

function aggregateMeasurements(input: AggregationInput): {
  value: number;
  baseline: number;
  count: number;
  detail: string;
} {
  const ms = input.measurements;
  if (ms.length === 0) {
    return { value: 0, baseline: 0, count: 0, detail: "No measurements in window." };
  }
  // Sort ascending by collectedAt
  const sorted = [...ms].sort((a, b) =>
    a.provenance.collectedAt.localeCompare(b.provenance.collectedAt),
  );
  const nums = sorted.map((m) => toNumeric(m.value));
  const first = nums[0]!;
  const last = nums[nums.length - 1]!;
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  const max = Math.max(...nums);
  const min = Math.min(...nums);

  // Baseline
  let baseline = 0;
  switch (input.baselineMode) {
    case "first": baseline = first; break;
    case "average": baseline = avg; break;
    case "previous_season": baseline = first; break; // simplified: treat as first
    case "custom": baseline = first; break;
    default: baseline = first;
  }

  let value: number;
  let detail: string;
  switch (input.aggregation) {
    case "latest":
      value = last;
      detail = `Latest value: ${last} (from ${sorted[sorted.length - 1]!.provenance.collectedAt}).`;
      break;
    case "average":
      value = avg;
      detail = `Average of ${nums.length} values: ${avg.toFixed(4)}.`;
      break;
    case "max":
      value = max;
      detail = `Max value: ${max}.`;
      break;
    case "min":
      value = min;
      detail = `Min value: ${min}.`;
      break;
    case "improvement":
      value = last - baseline;
      detail = `Improvement: ${last} - ${baseline} = ${value.toFixed(4)} (baseline mode: ${input.baselineMode}).`;
      break;
    case "improvement_percent":
      value = baseline !== 0 ? ((last - baseline) / Math.abs(baseline)) * 100 : 0;
      detail = `Improvement %: (${last} - ${baseline}) / |${baseline}| * 100 = ${value.toFixed(4)}%.`;
      break;
    case "count":
      value = nums.length;
      detail = `Measurement count: ${nums.length}.`;
      break;
    case "sum":
      value = sum;
      detail = `Sum of ${nums.length} values: ${sum.toFixed(4)}.`;
      break;
    case "custom":
      value = last;
      detail = `Custom aggregation defaulted to latest: ${last}.`;
      break;
    default:
      value = last;
      detail = `Unknown aggregation; defaulted to latest: ${last}.`;
  }
  return { value, baseline, count: nums.length, detail };
}

// ---------------------------------------------------------------------------
// Decay functions
// ---------------------------------------------------------------------------

function applyDecay(
  value: number,
  decay: ScoreSpec["components"][number]["decayFunction"],
  halfLifeDays: number | undefined,
  windowDays: number,
  measurementCount: number,
): { value: number; detail: string } {
  if (!decay || decay === "none") {
    return { value, detail: "No decay applied." };
  }
  if (decay === "linear") {
    // Linear decay: weight decays linearly from 1.0 (most recent) to 0 (oldest in window)
    // We approximate the decay factor as the average position of measurements in the window.
    if (measurementCount === 0 || windowDays <= 0) {
      return { value, detail: "Linear decay: no measurements or zero window." };
    }
    // Use a factor based on coverage: more recent activity = closer to 1.0
    const factor = Math.min(1, 0.5 + (measurementCount / Math.max(1, windowDays)) * 0.5);
    return { value: value * factor, detail: `Linear decay factor ${factor.toFixed(4)} applied.` };
  }
  if (decay === "exponential") {
    // Exponential decay: factor = 0.5 ^ (age / halfLife)
    const hl = halfLifeDays && halfLifeDays > 0 ? halfLifeDays : 30;
    // Approximate average age as half the window
    const age = windowDays / 2;
    const factor = Math.pow(0.5, age / hl);
    return { value: value * factor, detail: `Exponential decay factor ${factor.toFixed(4)} (half-life ${hl}d, age ${age.toFixed(1)}d).` };
  }
  return { value, detail: "Unknown decay; no change." };
}

// ---------------------------------------------------------------------------
// Score compiler + engine
// ---------------------------------------------------------------------------

export class ScoreCompiler {
  private readonly specs = new Map<ScoreSpecId, ScoreSpec>();
  private readonly compiled = new Map<ScoreSpecId, CompiledSpec>();
  private readonly scores = new Map<ScoreId, ScoreRecord>();
  private readonly scoresByParticipantKey = new Map<string, ScoreId[]>();
  private readonly history = new Map<ScoreId, ScoreHistoryEntry[]>();
  private readonly rolledBack = new Set<ScoreId>();
  private readonly audit: { at: string; action: string; scoreId?: ScoreId; specId?: ScoreSpecId; detail: string }[] = [];

  // -------------------------------------------------------------------------
  // Spec registration & management (ScoreEngine functionality)
  // -------------------------------------------------------------------------

  registerSpec(spec: ScoreSpec): ScoreSpec {
    const validation = this.validateSpec(spec);
    if (!validation.valid) {
      throw new CompetitionError({
        code: "eks.competition.scoring.spec_invalid",
        category: "score_invalid",
        message: `Score spec '${spec.name}' (v${spec.version}) failed validation: ${validation.errors.join("; ")}`,
        userMessage: "The scoring specification is invalid.",
        metadata: { specId: spec.id, errors: validation.errors, warnings: validation.warnings },
      });
    }
    this.specs.set(spec.id, spec);
    this.compile(spec);
    this.audit.push({ at: getClock().iso(), action: "spec_registered", specId: spec.id, detail: `Spec '${spec.name}' v${spec.version} registered.` });
    return spec;
  }

  getSpec(id: ScoreSpecId): ScoreSpec | undefined {
    return this.specs.get(id);
  }

  listSpecs(programId?: ProgramId): ScoreSpec[] {
    const list = [...this.specs.values()];
    return programId ? list.filter((s) => s.programId === programId) : list;
  }

  deprecateSpec(id: ScoreSpecId): ScoreSpec | undefined {
    const spec = this.specs.get(id);
    if (!spec) return undefined;
    const deprecated: ScoreSpec = { ...spec, deprecatedAt: getClock().iso() };
    this.specs.set(id, deprecated);
    this.compiled.delete(id);
    this.audit.push({ at: getClock().iso(), action: "spec_deprecated", specId: id, detail: `Spec '${spec.name}' v${spec.version} deprecated.` });
    return deprecated;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  validateSpec(spec: ScoreSpec): ScoreValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const now = getClock().iso();

    // Total weight check
    const totalWeight = spec.components.reduce((s, c) => s + c.weight, 0);
    if (Math.abs(totalWeight - 100) > 0.001) {
      errors.push(`Component weights must sum to 100; got ${totalWeight}.`);
    }
    if (spec.totalWeight !== totalWeight) {
      warnings.push(`Spec.totalWeight (${spec.totalWeight}) does not match computed sum (${totalWeight}); using computed.`);
    }

    // Per-component checks
    const names = new Set<string>();
    const ids = new Set<ScoreComponentId>();
    for (const c of spec.components) {
      if (c.weight < 0 || c.weight > 100) {
        errors.push(`Component '${c.name}' has weight ${c.weight} outside [0,100].`);
      }
      if (names.has(c.name)) {
        errors.push(`Duplicate component name '${c.name}'.`);
      }
      names.add(c.name);
      if (ids.has(c.id)) {
        errors.push(`Duplicate component id '${c.id}'.`);
      }
      ids.add(c.id);
      if (c.timeWindowDays < 0) {
        errors.push(`Component '${c.name}' has negative timeWindowDays.`);
      }
      if (c.measurementSchemaId === undefined && (c.type === "metric_improvement" || c.type === "metric_absolute")) {
        warnings.push(`Component '${c.name}' is metric-typed but has no measurementSchemaId.`);
      }
      if (c.formula) {
        const fErr = validateFormula(c.formula);
        if (fErr) errors.push(`Component '${c.name}' formula invalid: ${fErr}`);
      }
      if (c.bonusConditions) {
        for (const b of c.bonusConditions) {
          const e = validateFormula(b.condition);
          if (e) errors.push(`Bonus '${b.name}' on '${c.name}' has invalid condition: ${e}`);
        }
      }
      if (c.penaltyConditions) {
        for (const p of c.penaltyConditions) {
          const e = validateFormula(p.condition);
          if (e) errors.push(`Penalty '${p.name}' on '${c.name}' has invalid condition: ${e}`);
        }
      }
    }

    // Circular dependency detection: components may reference each other via formulas.
    // We check that the dependency graph (component name → names referenced in its formula) is acyclic.
    const depGraph = new Map<string, string[]>();
    for (const c of spec.components) {
      if (!c.formula) {
        depGraph.set(c.name, []);
        continue;
      }
      try {
        const ast = parseFormula(c.formula);
        const refs = new Set<string>();
        walk(ast, (n) => {
          if (n.kind === "var" && n.name !== "value" && names.has(n.name) && n.name !== c.name) {
            refs.add(n.name);
          }
        });
        depGraph.set(c.name, [...refs]);
      } catch {
        // Formula parse error already reported above
        depGraph.set(c.name, []);
      }
    }
    if (hasCycle(depGraph)) {
      errors.push("Circular dependency detected in component formulas.");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      totalWeight,
      componentCount: spec.components.length,
      specId: spec.id,
      version: spec.version,
      validatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Compile
  // -------------------------------------------------------------------------

  compile(spec: ScoreSpec): CompiledSpec {
    const validation = this.validateSpec(spec);
    if (!validation.valid) {
      throw new CompetitionError({
        code: "eks.competition.scoring.compile_failed",
        category: "score_invalid",
        message: `Cannot compile spec '${spec.name}': ${validation.errors.join("; ")}`,
        userMessage: "The scoring specification could not be compiled.",
        metadata: { specId: spec.id, errors: validation.errors },
      });
    }
    const componentIndex = new Map<ScoreComponentId, ScoreComponent>();
    const formulaAsts = new Map<ScoreComponentId, ASTNode>();
    const bonusAsts = new Map<string, ASTNode>();
    const penaltyAsts = new Map<string, ASTNode>();
    for (const c of spec.components) {
      componentIndex.set(c.id, c);
      if (c.formula) formulaAsts.set(c.id, parseFormula(c.formula));
      if (c.bonusConditions) {
        for (const b of c.bonusConditions) {
          bonusAsts.set(`${c.id}:${b.name}`, parseFormula(b.condition));
        }
      }
      if (c.penaltyConditions) {
        for (const p of c.penaltyConditions) {
          penaltyAsts.set(`${c.id}:${p.name}`, parseFormula(p.condition));
        }
      }
    }
    const compiled: CompiledSpec = {
      spec,
      compiledAt: getClock().iso(),
      componentIndex,
      formulaAsts,
      bonusAsts,
      penaltyAsts,
    };
    this.compiled.set(spec.id, compiled);
    this.audit.push({ at: getClock().iso(), action: "spec_compiled", specId: spec.id, detail: `Spec '${spec.name}' v${spec.version} compiled.` });
    return compiled;
  }

  getCompiled(id: ScoreSpecId): CompiledSpec | undefined {
    return this.compiled.get(id);
  }

  // -------------------------------------------------------------------------
  // Simulate
  // -------------------------------------------------------------------------

  simulate(spec: ScoreSpec, participantId: AccountId, atTime?: string): ScoreSimulationResult {
    const compiled = this.compiled.get(spec.id) ?? this.compile(spec);
    const now = atTime ?? getClock().iso();
    const toIso = now;
    const notes: string[] = [];

    const componentResults: ScoreComponentResult[] = [];
    const measurementRefs: MeasurementId[] = [];

    // First pass: compute raw + decayed values for all components
    const env = new Map<string, number>();
    const decayedValues = new Map<ScoreComponentId, number>();

    for (const c of compiled.spec.components) {
      const fromIso = daysAgoIso(c.timeWindowDays, now);
      const { measurements } = fetchMeasurementsForParticipant(
        participantId,
        c.measurementSchemaId,
        fromIso,
        toIso,
      );
      for (const m of measurements) measurementRefs.push(m.id);

      const agg = aggregateMeasurements({
        measurements,
        aggregation: c.aggregation,
        baselineMode: c.baselineMode,
      });
      if (agg.count === 0) {
        notes.push(`Component '${c.name}': no measurements found.`);
      }
      const decayed = applyDecay(agg.value, c.decayFunction, c.decayHalfLifeDays, c.timeWindowDays, agg.count);
      decayedValues.set(c.id, decayed.value);
      env.set(c.name, decayed.value);
      env.set("value", decayed.value);
    }

    // Second pass: evaluate formulas + bonuses/penalties + weighted score
    for (const c of compiled.spec.components) {
      const decayed = decayedValues.get(c.id)!;
      env.set("value", decayed);
      env.set(c.name, decayed);

      let componentScore: number;
      if (c.formula) {
        const ast = compiled.formulaAsts.get(c.id)!;
        try {
          componentScore = evaluate(ast, env);
        } catch (e) {
          notes.push(`Component '${c.name}' formula evaluation failed: ${e instanceof Error ? e.message : String(e)}; used raw value.`);
          componentScore = decayed;
        }
      } else {
        componentScore = decayed;
      }

      // Bonuses
      const bonuses: { name: string; points: number }[] = [];
      let totalBonus = 0;
      if (c.bonusConditions) {
        for (const b of c.bonusConditions) {
          const ast = compiled.bonusAsts.get(`${c.id}:${b.name}`);
          if (!ast) continue;
          try {
            const pass = evaluate(ast, env) !== 0;
            if (pass) {
              let pts = b.bonusPoints;
              if (b.maxBonus !== undefined && pts > b.maxBonus) pts = b.maxBonus;
              bonuses.push({ name: b.name, points: pts });
              totalBonus += pts;
            }
          } catch {
            // ignore bonus evaluation errors
          }
        }
      }

      // Penalties
      const penalties: { name: string; points: number }[] = [];
      let totalPenalty = 0;
      if (c.penaltyConditions) {
        for (const p of c.penaltyConditions) {
          const ast = compiled.penaltyAsts.get(`${c.id}:${p.name}`);
          if (!ast) continue;
          try {
            const pass = evaluate(ast, env) !== 0;
            if (pass) {
              let pts = p.penaltyPoints;
              if (p.maxPenalty !== undefined && pts > p.maxPenalty) pts = p.maxPenalty;
              penalties.push({ name: p.name, points: pts });
              totalPenalty += pts;
            }
          } catch {
            // ignore penalty evaluation errors
          }
        }
      }

      const finalComponentScore = componentScore + totalBonus - totalPenalty;
      const weightedScore = (finalComponentScore * c.weight) / 100;
      const detail = `raw=${decayed.toFixed(4)}, formula=${c.formula ? "applied" : "none"}, +bonus=${totalBonus}, -penalty=${totalPenalty}, weighted=(${finalComponentScore.toFixed(4)} * ${c.weight}/100) = ${weightedScore.toFixed(4)}.`;

      componentResults.push({
        componentId: c.id,
        name: c.name,
        rawValue: decayed,
        componentScore: finalComponentScore,
        weight: c.weight,
        weightedScore,
        detail,
        bonuses,
        penalties,
      });

      // Update env so later formulas can reference this component's computed score
      env.set(c.name, finalComponentScore);
    }

    let totalScore = componentResults.reduce((s, r) => s + r.weightedScore, 0);
    const specForSim = compiled.spec;
    if (specForSim.scoreCap !== undefined && totalScore > specForSim.scoreCap) totalScore = specForSim.scoreCap;
    if (specForSim.scoreFloor !== undefined && totalScore < specForSim.scoreFloor) totalScore = specForSim.scoreFloor;
    totalScore = roundTo(totalScore, specForSim.roundingPrecision);

    return {
      specId: specForSim.id,
      participantId,
      simulatedAt: now,
      totalScore,
      components: componentResults,
      measurementRefs,
      notes,
    };
  }

  // -------------------------------------------------------------------------
  // Execute — compute & persist a real ScoreRecord
  // -------------------------------------------------------------------------

  execute(
    spec: ScoreSpec,
    participantId: AccountId,
    competitionId: CompetitionId,
    seasonId: SeasonId,
  ): ScoreRecord {
    const compiled = this.compiled.get(spec.id) ?? this.compile(spec);
    const sim = this.simulate(spec, participantId);
    const now = getClock().iso();

    // Determine version: increment from latest existing record for this participant+competition+season
    const key = participantKey(participantId, competitionId, seasonId);
    const existing = (this.scoresByParticipantKey.get(key) ?? [])
      .map((id) => this.scores.get(id)!)
      .filter((s) => s && !this.rolledBack.has(s.id));
    const version = existing.length === 0
      ? 1
      : Math.max(...existing.map((s) => s.version)) + 1;

    const explanationLines: string[] = [
      `Score for participant ${participantId} in competition ${competitionId} (season ${seasonId}).`,
      `Spec: ${spec.name} v${spec.version} (id ${spec.id}).`,
      `Computed at ${now}; version ${version}.`,
      `Total: ${sim.totalScore}.`,
      `Components:`,
    ];
    for (const r of sim.components) {
      explanationLines.push(
        `  - ${r.name} (weight ${r.weight}%): raw=${r.rawValue.toFixed(4)}, component=${r.componentScore.toFixed(4)}, weighted=${r.weightedScore.toFixed(4)}. ${r.detail}`,
      );
      if (r.bonuses.length > 0) {
        explanationLines.push(`    bonuses: ${r.bonuses.map((b) => `${b.name}=+${b.points}`).join(", ")}`);
      }
      if (r.penalties.length > 0) {
        explanationLines.push(`    penalties: ${r.penalties.map((p) => `${p.name}=-${p.points}`).join(", ")}`);
      }
    }
    if (sim.notes.length > 0) {
      explanationLines.push(`Notes:`);
      for (const n of sim.notes) explanationLines.push(`  - ${n}`);
    }

    const record: ScoreRecord = {
      id: asScoreId(generateId("score_")),
      participantId,
      competitionId,
      seasonId,
      specId: spec.id,
      totalScore: sim.totalScore,
      components: sim.components,
      computedAt: now,
      version,
      measurementRefs: sim.measurementRefs,
      explanation: explanationLines.join("\n"),
    };

    this.scores.set(record.id, record);
    const list = this.scoresByParticipantKey.get(key) ?? [];
    this.scoresByParticipantKey.set(key, [...list, record.id]);
    this.history.set(record.id, [
      {
        scoreId: record.id,
        totalScore: record.totalScore,
        version: record.version,
        computedAt: now,
        action: "computed",
        note: `Initial computation (spec ${spec.name} v${spec.version}).`,
      },
    ]);
    this.audit.push({ at: now, action: "score_executed", scoreId: record.id, specId: spec.id, detail: `Score ${record.id} computed: ${record.totalScore}.` });

    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.scoreUpdated,
        {
          scoreId: record.id,
          participantId,
          competitionId,
          seasonId,
          specId: spec.id,
          totalScore: record.totalScore,
          version: record.version,
        },
        {},
        "domain",
      ),
    );

    // Avoid unused-variable warning on `compiled`
    void compiled;
    return record;
  }

  // -------------------------------------------------------------------------
  // Recalculate
  // -------------------------------------------------------------------------

  recalculate(competitionId: CompetitionId, seasonId: SeasonId): ScoreRecord[] {
    // Enumerate participants via previously stored scores for this competition+season.
    // (The qualification subsystem also tracks participations; we use what we have
    // here to avoid a hard cross-module dependency at module-load time.)
    const participantIds = new Set<AccountId>();
    for (const [key] of this.scoresByParticipantKey.entries()) {
      const parts = key.split("|");
      const pid = parts[0] as AccountId;
      const cid = parts[1];
      const sid = parts[2];
      if (cid === String(competitionId) && sid === String(seasonId)) {
        participantIds.add(pid);
      }
    }
    // Also enumerate via the qualification subsystem if available. Use the
    // indirection below so this module does not introduce a hard static
    // circular dependency at module-load time.
    try {
      const qual = getQualificationProvider();
      if (qual) {
        const parts = qual.listParticipations({ competitionId });
        for (const p of parts) participantIds.add(p.participantId);
      }
    } catch {
      // qualification subsystem not yet initialized; skip.
    }

    const records: ScoreRecord[] = [];
    for (const pid of participantIds) {
      // Use the latest existing record's spec
      const latest = this.getLatestScore(pid, competitionId, seasonId);
      if (!latest) continue;
      const spec = this.specs.get(latest.specId);
      if (!spec) continue;
      const rec = this.execute(spec, pid, competitionId, seasonId);
      records.push(rec);
      // Append a "recalculated" history entry
      const hist = this.history.get(rec.id) ?? [];
      hist.push({
        scoreId: rec.id,
        totalScore: rec.totalScore,
        version: rec.version,
        computedAt: getClock().iso(),
        action: "recalculated",
        note: `Bulk recalculation for competition ${competitionId} season ${seasonId}.`,
      });
      this.history.set(rec.id, hist);
    }
    void getEventBus().publish(
      buildEvent(
        COMPETITION_EVENTS.scoreRecalculated,
        { competitionId, seasonId, recalculatedCount: records.length },
        {},
        "domain",
      ),
    );
    this.audit.push({ at: getClock().iso(), action: "recalculate", detail: `Recalculated ${records.length} scores for ${competitionId}/${seasonId}.` });
    return records;
  }

  // -------------------------------------------------------------------------
  // Lookup
  // -------------------------------------------------------------------------

  getScore(scoreId: ScoreId): ScoreRecord | undefined {
    const rec = this.scores.get(scoreId);
    if (!rec) return undefined;
    if (this.rolledBack.has(scoreId)) return undefined;
    return rec;
  }

  getLatestScore(participantId: AccountId, competitionId: CompetitionId, seasonId: SeasonId): ScoreRecord | undefined {
    const key = participantKey(participantId, competitionId, seasonId);
    const ids = (this.scoresByParticipantKey.get(key) ?? [])
      .filter((id) => !this.rolledBack.has(id))
      .map((id) => this.scores.get(id)!)
      .filter(Boolean);
    if (ids.length === 0) return undefined;
    return [...ids].sort((a, b) => b.version - a.version)[0];
  }

  getHistory(participantId: AccountId, competitionId: CompetitionId): ScoreRecord[] {
    // All seasons for this participant+competition
    const out: ScoreRecord[] = [];
    for (const [key, ids] of this.scoresByParticipantKey.entries()) {
      const [pid, cid] = key.split("|");
      if (pid === String(participantId) && cid === String(competitionId)) {
        for (const id of ids) {
          const rec = this.scores.get(id);
          if (rec && !this.rolledBack.has(id)) out.push(rec);
        }
      }
    }
    return out.sort((a, b) => a.computedAt.localeCompare(b.computedAt));
  }

  getScoreHistory(scoreId: ScoreId): ScoreHistoryEntry[] {
    return [...(this.history.get(scoreId) ?? [])];
  }

  // -------------------------------------------------------------------------
  // Rollback
  // -------------------------------------------------------------------------

  rollback(scoreId: ScoreId, reason: string): ScoreRecord | undefined {
    const rec = this.scores.get(scoreId);
    if (!rec) return undefined;
    if (this.rolledBack.has(scoreId)) return undefined;
    this.rolledBack.add(scoreId);
    const hist = this.history.get(scoreId) ?? [];
    hist.push({
      scoreId,
      totalScore: rec.totalScore,
      version: rec.version,
      computedAt: getClock().iso(),
      action: "rolled_back",
      note: `Rolled back: ${reason}`,
    });
    this.history.set(scoreId, hist);
    this.audit.push({ at: getClock().iso(), action: "score_rolled_back", scoreId, detail: `Score ${scoreId} rolled back: ${reason}` });
    // Return the previous version (if any)
    const key = participantKey(rec.participantId, rec.competitionId, rec.seasonId);
    const remaining = (this.scoresByParticipantKey.get(key) ?? [])
      .filter((id) => id !== scoreId && !this.rolledBack.has(id))
      .map((id) => this.scores.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.version - a.version);
    return remaining[0];
  }

  // -------------------------------------------------------------------------
  // Audit / stats
  // -------------------------------------------------------------------------

  getAuditLog(): readonly { at: string; action: string; scoreId?: ScoreId; specId?: ScoreSpecId; detail: string }[] {
    return [...this.audit];
  }

  getStats(): {
    totalSpecs: number;
    totalScores: number;
    activeScores: number;
    rolledBackScores: number;
    compiledSpecs: number;
    deprecatedSpecs: number;
  } {
    return {
      totalSpecs: this.specs.size,
      totalScores: this.scores.size,
      activeScores: this.scores.size - this.rolledBack.size,
      rolledBackScores: this.rolledBack.size,
      compiledSpecs: this.compiled.size,
      deprecatedSpecs: [...this.specs.values()].filter((s) => s.deprecatedAt !== undefined).length,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function participantKey(participantId: AccountId, competitionId: CompetitionId, seasonId: SeasonId): string {
  return `${String(participantId)}|${String(competitionId)}|${String(seasonId)}`;
}

function daysAgoIso(days: number, fromIso: string): string {
  if (days <= 0) return new Date(0).toISOString();
  const from = new Date(fromIso).getTime();
  return new Date(from - days * 24 * 60 * 60 * 1000).toISOString();
}

function roundTo(value: number, precision: number): number {
  if (precision <= 0) return Math.round(value);
  const f = Math.pow(10, precision);
  return Math.round(value * f) / f;
}

function hasCycle(graph: Map<string, string[]>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const k of graph.keys()) color.set(k, WHITE);

  const dfs = (node: string): boolean => {
    const c = color.get(node);
    if (c === GRAY) return true;
    if (c === BLACK) return false;
    color.set(node, GRAY);
    const deps = graph.get(node) ?? [];
    for (const d of deps) {
      if (dfs(d)) return true;
    }
    color.set(node, BLACK);
    return false;
  };

  for (const k of graph.keys()) {
    if (color.get(k) === WHITE) {
      if (dfs(k)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Re-export the asScoreSpecId helper for callers building specs
// ---------------------------------------------------------------------------

export { asScoreSpecId, asScoreId, asScoreComponentId };

// ---------------------------------------------------------------------------
// Qualification-provider indirection
//
// `recalculate` needs to enumerate participants in a competition. That data
// lives in the qualification subsystem. To avoid a static circular import
// (qualification imports scoring for `min_score` checks; scoring imports
// qualification for participant enumeration), qualification registers itself
// here at boot via `setQualificationProvider`.
// ---------------------------------------------------------------------------

export interface QualificationProvider {
  listParticipations(filter: { competitionId?: CompetitionId; participantId?: AccountId }): readonly { participantId: AccountId }[];
}

let _qualProvider: QualificationProvider | null = null;

export function setQualificationProvider(provider: QualificationProvider | null): void {
  _qualProvider = provider;
}

function getQualificationProvider(): QualificationProvider | null {
  return _qualProvider;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _compiler: ScoreCompiler | null = null;
export function getScoring(): ScoreCompiler {
  if (!_compiler) _compiler = new ScoreCompiler();
  return _compiler;
}
export function resetScoring(): void {
  _compiler = null;
}
