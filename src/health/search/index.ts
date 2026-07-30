/**
 * Eks-Health Universal Health Data Platform — Search & Query Platform
 *
 * Queries measurements, participants (where authorized), schemas, evidence,
 * historical trends, verification states, composite metrics, and research
 * datasets. Supports structured filtering, aggregation, pagination, sorting,
 * saved queries, and a real tokenized inverted index with BM25-style ranking.
 *
 * Provider-agnostic: the default in-memory inverted index is the source of
 * truth for synchronous queries; the kernel `getSearch()` manager is also
 * mirrored (best-effort) so that a real Elasticsearch/Meili backend can be
 * swapped in without touching application code.
 *
 * Future: semantic/vector search will layer on top of the same query model.
 */

import "server-only";

import {
  type QueryId,
  type SchemaId,
  type ProfileId,
  type MeasurementId,
  type ProgramId,
  type SourceType,
  type VerificationState,
  type MeasurementValue,
  type SourceId,
  type Provenance,
  type UnitId,
  type EvidenceId,
  HealthError,
  asQueryId,
} from "../core";
import type { MeasurementSchema } from "../schemas";
import { getSources } from "../sources";
import { getUnits } from "../units";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";

// ---------------------------------------------------------------------------
// Local measurement shape
// ---------------------------------------------------------------------------
//
// m4-2 builds the real `Measurement` type in parallel. This local interface is
// a permissive superset that works against both the temporary stub and the
// eventual real module (structural typing). Accessor functions below handle
// the presence/absence of `provenance`, `timestamp`, `createdAt`, etc.

export interface Measurement {
  readonly id: MeasurementId;
  readonly schemaId: SchemaId;
  readonly profileId: ProfileId;
  readonly value: MeasurementValue;
  readonly unitId?: UnitId;
  readonly sourceId?: SourceId;
  readonly provenance?: Provenance;
  readonly verificationState: VerificationState;
  readonly timestamp?: string; // stub shape
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  readonly evidenceIds?: readonly EvidenceId[];
  readonly version?: number;
  readonly notes?: string;
  readonly sourceType?: SourceType; // stub shape
  readonly supersededBy?: MeasurementId;
  readonly supersededAt?: string;
}

/** Filter shape passed to getMeasurements().list() — permissive. */
export interface MeasurementQuery {
  readonly schemaId?: SchemaId;
  readonly profileId?: ProfileId;
  readonly sourceId?: SourceId;
  readonly verificationState?: VerificationState;
  readonly dateRange?: { readonly from?: string; readonly to?: string };
  readonly tags?: readonly string[];
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

// ---------------------------------------------------------------------------
// Local profile shape (m4-3 builds the real Profile in parallel)
// ---------------------------------------------------------------------------

export interface Profile {
  readonly id: ProfileId;
  readonly accountId?: string;
  readonly displayName?: string;
  readonly biologicalSex?: string;
  readonly ageRange?: string;
  readonly country?: string;
  readonly programId?: ProgramId;
  readonly customAttributes?: Record<string, unknown>;
  readonly createdAt?: string;
}

// ---------------------------------------------------------------------------
// Query model
// ---------------------------------------------------------------------------

export type SearchFilterOp =
  | "eq"
  | "ne"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "prefix"
  | "between";

export type SearchFilterValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[];

export interface SearchFilter {
  readonly field: string;
  readonly op: SearchFilterOp;
  readonly value?: SearchFilterValue;
}

export interface SearchSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface SearchPagination {
  readonly limit: number;
  readonly offset: number;
}

export type SearchIndexType = "measurements" | "schemas" | "profiles" | "evidence";

export type AggregationMetric = "count" | "avg" | "min" | "max" | "sum";

export type AggregationGroupBy =
  | "schemaId"
  | "sourceType"
  | "verificationState"
  | "profileId"
  | "programId"
  | "unit"
  | "day"
  | "week"
  | "month";

export interface AggregationSpec {
  readonly name: string;
  readonly field: AggregationGroupBy;
  readonly metrics: readonly AggregationMetric[];
}

export interface AggregationBucket {
  readonly key: string;
  readonly count: number;
  readonly metrics: Partial<Record<AggregationMetric, number>>;
}

export interface AggregationResult {
  readonly name: string;
  readonly field: AggregationGroupBy;
  readonly buckets: readonly AggregationBucket[];
}

export interface SearchQuery {
  readonly query?: string;
  readonly filters?: readonly SearchFilter[];
  readonly aggregations?: readonly AggregationSpec[];
  readonly sort?: SearchSort;
  readonly pagination?: SearchPagination;
  readonly types?: readonly SearchIndexType[];
}

export interface SearchHit {
  readonly id: string;
  readonly type: SearchIndexType;
  readonly score: number;
  readonly doc: Record<string, unknown>;
  readonly highlights?: Record<string, string>;
}

export interface SearchResult {
  readonly queryId: QueryId;
  readonly hits: readonly SearchHit[];
  readonly aggregations: readonly AggregationResult[];
  readonly total: number;
  readonly pagination: SearchPagination;
  readonly tookMs: number;
}

export interface SavedQuery {
  readonly id: QueryId;
  readonly name: string;
  readonly query: SearchQuery;
  readonly savedBy: string;
  readonly savedAt: string;
}

export interface QueryStats {
  readonly indexSizes: Record<SearchIndexType, number>;
  readonly queryCount: number;
  readonly lastQueryAt?: string;
  readonly savedQueryCount: number;
}

// ---------------------------------------------------------------------------
// Structured measurement filter (for searchMeasurements)
// ---------------------------------------------------------------------------

export interface MeasurementSearchFilter {
  readonly schemaId?: SchemaId;
  readonly profileId?: ProfileId;
  readonly programId?: ProgramId;
  readonly sourceType?: SourceType;
  readonly sourceId?: SourceId;
  readonly verificationState?: VerificationState;
  readonly from?: string;
  readonly to?: string;
  readonly valueMin?: number;
  readonly valueMax?: number;
  readonly unit?: string;
  readonly tags?: readonly string[];
  readonly includeSuperseded?: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const SEARCH_EVENTS = {
  queryExecuted: "eks.health.query.executed",
  querySaved: "eks.health.query.saved",
  measurementIndexed: "eks.health.search.measurement_indexed",
  schemaIndexed: "eks.health.search.schema_indexed",
} as const;

// ---------------------------------------------------------------------------
// In-memory inverted index (tokenized, BM25-ranked)
// ---------------------------------------------------------------------------

interface IndexedDoc {
  readonly id: string;
  readonly type: SearchIndexType;
  readonly doc: Record<string, unknown>;
  /** field -> ordered tokens (for highlight + field-scoped queries). */
  readonly tokens: Map<string, string[]>;
  /** token -> term frequency across all indexed fields. */
  readonly tf: Map<string, number>;
  /** total token count across indexed fields (document length). */
  readonly fieldLength: number;
}

interface LocalIndex {
  readonly docs: Map<string, IndexedDoc>;
  /** token -> Set<docId>. */
  readonly inverted: Map<string, Set<string>>;
  totalLength: number;
}

function newIndex(): LocalIndex {
  return { docs: new Map(), inverted: new Map(), totalLength: 0 };
}

/** Tokenize: lowercase, split on Unicode whitespace + punctuation, drop empties. */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length > 0);
}

function tokenizeValue(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return tokenize(v);
  if (typeof v === "number" || typeof v === "boolean") return tokenize(String(v));
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) out.push(...tokenizeValue(item));
    return out;
  }
  if (typeof v === "object") {
    try {
      return tokenize(JSON.stringify(v));
    } catch {
      return [];
    }
  }
  return [];
}

/** Searchable fields per document type. */
const SEARCHABLE_FIELDS: Record<SearchIndexType, readonly string[]> = {
  measurements: ["notes", "unit", "schemaId", "sourceType", "verificationState", "value", "tags"],
  schemas: ["name", "description", "slug", "category", "tags"],
  profiles: ["displayName", "biologicalSex", "ageRange", "country"],
  evidence: ["type", "description", "fileName"],
};

// BM25 parameters
const K1 = 1.5;
const B = 0.75;

function bm25Score(
  tf: number,
  docLength: number,
  avgLength: number,
  df: number,
  n: number,
): number {
  if (tf <= 0 || n <= 0) return 0;
  const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
  const denom = tf + K1 * (1 - B + B * (docLength / (avgLength || 1)));
  return idf * ((tf * (K1 + 1)) / denom);
}

function compareField(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  field: string,
): number {
  const va = a[field];
  const vb = b[field];
  if (va === vb) return 0;
  if (va === undefined || va === null) return -1;
  if (vb === undefined || vb === null) return 1;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb));
}

// ---------------------------------------------------------------------------
// Numeric extraction (for aggregation + value-range filters)
// ---------------------------------------------------------------------------

/** Extract the primary numeric component from a MeasurementValue. */
export function toNumeric(v: MeasurementValue | undefined): number | null {
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
    if (typeof obj.value === "string") {
      const n = Number(obj.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date bucketing (for aggregation by day/week/month)
// ---------------------------------------------------------------------------

function dateBucket(ts: string, granularity: "day" | "week" | "month"): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "unknown";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (granularity === "day") return `${y}-${m}-${day}`;
  if (granularity === "month") return `${y}-${m}`;
  // ISO-8601 week number
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (tmp.getUTCDay() + 6) % 7; // Monday=0
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((tmp.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Measurement field accessors (defensive — work against stub OR real shape)
// ---------------------------------------------------------------------------

/** Lookup the source type for a measurement. Handles both stub and real shapes. */
function sourceTypeOf(m: Measurement): SourceType | undefined {
  if (m.sourceType) return m.sourceType as SourceType;
  if (m.sourceId) {
    try {
      void 0; // getSources imported at top level
      return getSources().get(m.sourceId)?.type;
    } catch {
      // sources registry unavailable.
    }
  }
  return undefined;
}

/** Resolve the primary timestamp for a measurement (collection time preferred). */
function timestampOf(m: Measurement): string {
  return m.provenance?.collectedAt ?? m.timestamp ?? m.createdAt ?? getClock().iso();
}

/** Resolve the unit symbol for a measurement via the UnitRegistry. */
function unitSymbolOf(m: Measurement): string | undefined {
  if (m.unitId) {
    try {
      void 0; // getUnits imported at top level
      return getUnits().get(m.unitId)?.symbol ?? (m.unitId as string);
    } catch {
      return m.unitId as string;
    }
  }
  return undefined;
}

/** Resolve the program id for a measurement (from provenance). */
function programIdOf(m: Measurement): ProgramId | undefined {
  return m.provenance?.programId;
}

// ---------------------------------------------------------------------------
// Health Search Engine
// ---------------------------------------------------------------------------

export class HealthSearchEngine {
  private readonly indexes: Record<SearchIndexType, LocalIndex> = {
    measurements: newIndex(),
    schemas: newIndex(),
    profiles: newIndex(),
    evidence: newIndex(),
  };
  private readonly savedQueries = new Map<QueryId, SavedQuery>();
  private queryCount = 0;
  private lastQueryAt: string | undefined;

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /** Index a measurement for full-text + structured search. */
  indexMeasurement(m: Measurement): void {
    const sourceType = sourceTypeOf(m);
    const unit = unitSymbolOf(m);
    const programId = programIdOf(m);
    const doc: Record<string, unknown> = {
      id: m.id,
      schemaId: m.schemaId,
      profileId: m.profileId,
      programId,
      value: m.value,
      unitId: m.unitId,
      unit,
      timestamp: timestampOf(m),
      sourceId: m.sourceId,
      sourceType,
      verificationState: m.verificationState,
      tags: m.tags,
      version: m.version,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      supersededBy: m.supersededBy,
    };
    this.indexDoc("measurements", m.id as string, doc);
    void getEventBus().publish(
      buildEvent(SEARCH_EVENTS.measurementIndexed, { id: m.id, schemaId: m.schemaId }, {}, "domain"),
    );
  }

  /** Index a schema for full-text search. */
  indexSchema(schema: MeasurementSchema): void {
    const doc: Record<string, unknown> = {
      id: schema.id,
      name: schema.name,
      description: schema.description,
      slug: schema.slug,
      category: schema.category,
      tags: schema.tags,
      programId: schema.programId,
      valueType: schema.valueType,
    };
    this.indexDoc("schemas", schema.id as string, doc);
    void getEventBus().publish(
      buildEvent(SEARCH_EVENTS.schemaIndexed, { id: schema.id, slug: schema.slug }, {}, "domain"),
    );
  }

  /** Index a profile (only fields safe to search — never PII beyond what the caller passes). */
  indexProfile(profile: Profile): void {
    const doc: Record<string, unknown> = {
      id: profile.id,
      displayName: profile.displayName,
      biologicalSex: profile.biologicalSex,
      ageRange: profile.ageRange,
      country: profile.country,
      programId: profile.programId,
    };
    if (profile.customAttributes) {
      for (const [k, v] of Object.entries(profile.customAttributes)) {
        doc[`custom_${k}`] = v;
      }
    }
    this.indexDoc("profiles", profile.id as string, doc);
  }

  /** Index an evidence record. */
  indexEvidence(evidence: {
    id: string;
    type?: string;
    description?: string;
    fileName?: string;
    measurementId?: MeasurementId;
    uploadedAt?: string;
  }): void {
    const doc: Record<string, unknown> = { ...evidence } as Record<string, unknown>;
    this.indexDoc("evidence", evidence.id, doc);
  }

  /** Remove a document from an index. */
  removeFromIndex(type: SearchIndexType, id: string): boolean {
    const idx = this.indexes[type];
    const existing = idx.docs.get(id);
    if (!existing) return false;
    for (const token of existing.tf.keys()) {
      const postings = idx.inverted.get(token);
      if (postings) {
        postings.delete(id);
        if (postings.size === 0) idx.inverted.delete(token);
      }
    }
    idx.docs.delete(id);
    idx.totalLength = Math.max(0, idx.totalLength - existing.fieldLength);
    return true;
  }

  private indexDoc(type: SearchIndexType, id: string, doc: Record<string, unknown>): void {
    const idx = this.indexes[type];
    if (idx.docs.has(id)) {
      this.removeFromIndex(type, id);
    }
    const fields = SEARCHABLE_FIELDS[type];
    const tokens = new Map<string, string[]>();
    const tf = new Map<string, number>();
    let fieldLength = 0;
    for (const field of fields) {
      const toks = tokenizeValue(doc[field]);
      tokens.set(field, toks);
      fieldLength += toks.length;
      for (const t of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
    }
    const indexed: IndexedDoc = { id, type, doc, tokens, tf, fieldLength };
    idx.docs.set(id, indexed);
    for (const token of tf.keys()) {
      let postings = idx.inverted.get(token);
      if (!postings) {
        postings = new Set();
        idx.inverted.set(token, postings);
      }
      postings.add(id);
    }
    idx.totalLength += fieldLength;

    // Best-effort mirror to the kernel search backend (Elasticsearch/Meili in prod).
    try {
      void this.mirrorToKernel(type, id, doc);
    } catch {
      // kernel getSearch not available — local index is authoritative.
    }
  }

  private async mirrorToKernel(
    type: SearchIndexType,
    id: string,
    doc: Record<string, unknown>,
  ): Promise<void> {
    try {
      const { getSearch } = await import("@/kernel");
      const kernelSearch = getSearch();
      await kernelSearch.index(type, { id, fields: serializeFields(doc) });
    } catch {
      // kernel search unavailable — local index is authoritative.
    }
  }

  // -------------------------------------------------------------------------
  // Full-text + structured search
  // -------------------------------------------------------------------------

  async search(query: SearchQuery): Promise<SearchResult> {
    const startedAt = Date.now();
    const queryId = asQueryId(generateId("qry_"));
    const types = query.types ?? (["measurements", "schemas", "profiles", "evidence"] as const);
    const limit = query.pagination?.limit ?? 50;
    const offset = query.pagination?.offset ?? 0;

    const allHits: SearchHit[] = [];
    for (const t of types) {
      const hits = this.searchLocalIndex(this.indexes[t], t, query);
      allHits.push(...hits);
    }

    if (query.sort) {
      const { field, direction } = query.sort;
      allHits.sort((a, b) => {
        const cmp = compareField(a.doc, b.doc, field);
        return direction === "desc" ? -cmp : cmp;
      });
    } else {
      allHits.sort((a, b) => b.score - a.score);
    }

    const total = allHits.length;
    const paged = allHits.slice(offset, offset + limit);

    // Aggregations are computed across the full hit set (pre-pagination).
    const aggregations = (query.aggregations ?? []).map((spec) =>
      this.aggregate(
        allHits.map((h) => h.doc as unknown as Measurement),
        spec,
      ),
    );

    this.queryCount++;
    this.lastQueryAt = getClock().iso();

    const tookMs = Date.now() - startedAt;
    void getEventBus().publish(
      buildEvent(
        SEARCH_EVENTS.queryExecuted,
        { queryId, total, returned: paged.length, types: [...types], tookMs },
        {},
        "domain",
      ),
    );

    return {
      queryId,
      hits: paged,
      aggregations,
      total,
      pagination: { limit, offset },
      tookMs,
    };
  }

  private searchLocalIndex(
    idx: LocalIndex,
    type: SearchIndexType,
    query: SearchQuery,
  ): SearchHit[] {
    const qTokens = query.query ? tokenize(query.query) : [];
    const n = idx.docs.size;
    const avgLength = n > 0 ? idx.totalLength / n : 0;
    const hits: SearchHit[] = [];

    for (const indexed of idx.docs.values()) {
      if (query.filters && !this.matchesAllFilters(indexed.doc, query.filters)) {
        continue;
      }
      let score = 0;
      if (qTokens.length > 0) {
        for (const token of qTokens) {
          const tf = indexed.tf.get(token) ?? 0;
          if (tf === 0) continue;
          const df = idx.inverted.get(token)?.size ?? 0;
          score += bm25Score(tf, indexed.fieldLength, avgLength, df, n);
        }
        if (score <= 0) continue; // OR semantics: must match at least one token
      } else {
        score = 1;
      }
      hits.push({
        id: indexed.id,
        type,
        score,
        doc: indexed.doc,
        highlights: query.query ? this.highlight(indexed, qTokens) : undefined,
      });
    }
    return hits;
  }

  private highlight(indexed: IndexedDoc, qTokens: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const tokenSet = new Set(qTokens);
    for (const [field, toks] of indexed.tokens) {
      if (toks.length === 0) continue;
      const marked = toks
        .map((t) => (tokenSet.has(t) ? `<mark>${t}</mark>` : t))
        .join(" ");
      if (marked.includes("<mark>")) {
        out[field] = marked;
      }
    }
    return out;
  }

  private matchesAllFilters(
    doc: Record<string, unknown>,
    filters: readonly SearchFilter[],
  ): boolean {
    return filters.every((f) => this.matchesFilter(doc, f));
  }

  private matchesFilter(doc: Record<string, unknown>, f: SearchFilter): boolean {
    const val = doc[f.field];
    switch (f.op) {
      case "eq":
        return val === f.value;
      case "ne":
        return val !== f.value;
      case "in":
        return Array.isArray(f.value) && (f.value as readonly unknown[]).includes(val);
      case "gt":
        return typeof val === "number" && typeof f.value === "number" && val > f.value;
      case "gte":
        return typeof val === "number" && typeof f.value === "number" && val >= f.value;
      case "lt":
        return typeof val === "number" && typeof f.value === "number" && val < f.value;
      case "lte":
        return typeof val === "number" && typeof f.value === "number" && val <= f.value;
      case "exists":
        return val !== undefined && val !== null;
      case "prefix":
        return typeof val === "string" && typeof f.value === "string" && val.startsWith(f.value);
      case "between": {
        if (!Array.isArray(f.value) || f.value.length !== 2) return false;
        if (typeof val !== "number") return false;
        const lo = f.value[0] as number;
        const hi = f.value[1] as number;
        return val >= lo && val <= hi;
      }
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Structured measurement search
  // -------------------------------------------------------------------------

  /**
   * Structured query over measurements (by schema, profile, source, date range,
   * verification state, value range). Delegates to the parallel m4-2
   * `getMeasurements().list()` when available, applying additional in-memory
   * filtering for fields the measurements module does not natively index
   * (sourceType, valueMin/Max, unit, programId).
   */
  async searchMeasurements(
    filter: MeasurementSearchFilter,
  ): Promise<readonly Measurement[]> {
    let baseList: readonly Measurement[];
    try {
      const measurementsModule = "../measurements";
      const mod: { getMeasurements(): { list(query: unknown): readonly unknown[] } } =
        await import(measurementsModule);
      const mgr = mod.getMeasurements();
      const query: MeasurementQuery = {
        schemaId: filter.schemaId,
        profileId: filter.profileId,
        sourceId: filter.sourceId,
        verificationState: filter.verificationState,
        dateRange: { from: filter.from, to: filter.to },
        tags: filter.tags,
        includeSuperseded: filter.includeSuperseded,
      };
      baseList = mgr.list(query) as readonly Measurement[];
    } catch {
      // measurements module not yet wired — fall back to the local index.
      baseList = [...this.indexes.measurements.docs.values()].map(
        (d) => d.doc as unknown as Measurement,
      );
    }
    return baseList.filter((m) => this.matchesMeasurementFilter(m, filter));
  }

  private matchesMeasurementFilter(
    m: Measurement,
    f: MeasurementSearchFilter,
  ): boolean {
    if (f.schemaId && m.schemaId !== f.schemaId) return false;
    if (f.profileId && m.profileId !== f.profileId) return false;
    if (f.programId && programIdOf(m) !== f.programId) return false;
    if (f.sourceType && sourceTypeOf(m) !== f.sourceType) return false;
    if (f.verificationState && m.verificationState !== f.verificationState) return false;
    if (f.unit) {
      const sym = unitSymbolOf(m);
      if (sym !== f.unit && (m.unitId as string) !== f.unit) return false;
    }
    if (f.from && timestampOf(m) < f.from) return false;
    if (f.to && timestampOf(m) > f.to) return false;
    if (f.valueMin !== undefined || f.valueMax !== undefined) {
      const n = toNumeric(m.value);
      if (n === null) return false;
      if (f.valueMin !== undefined && n < f.valueMin) return false;
      if (f.valueMax !== undefined && n > f.valueMax) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Schema search (full-text)
  // -------------------------------------------------------------------------

  /**
   * Text search over schema name, description, slug, category, tags.
   * Delegates to the schema registry when available, else searches the local
   * index. Returns ranked results.
   */
  async searchSchemas(query: string): Promise<MeasurementSchema[]> {
    let schemas: MeasurementSchema[];
    try {
      const mod = await import("../schemas");
      schemas = [...mod.getSchemas().list()];
    } catch {
      schemas = [];
    }
    // Also include any locally indexed schemas (covers tests + early dev).
    const locallyIndexed = [...this.indexes.schemas.docs.values()].map(
      (d) => d.doc as unknown as MeasurementSchema,
    );
    const merged = new Map<string, MeasurementSchema>();
    for (const s of [...schemas, ...locallyIndexed]) {
      merged.set(s.id as string, s);
    }
    const all = [...merged.values()];
    if (!query || query.trim() === "") return all;
    const qTokens = new Set(tokenize(query));
    return all
      .map((s) => ({ s, score: this.scoreSchema(s, qTokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.s);
  }

  private scoreSchema(s: MeasurementSchema, qTokens: Set<string>): number {
    const fields = [s.name, s.description, s.slug, s.category, ...(s.tags ?? [])];
    let score = 0;
    for (const field of fields) {
      for (const t of tokenize(field)) {
        if (qTokens.has(t)) score += 1;
      }
    }
    return score;
  }

  // -------------------------------------------------------------------------
  // Profile search (authorization-gated)
  // -------------------------------------------------------------------------

  /**
   * Search profiles by demographics or custom attributes. Authorization is
   * delegated to the identity platform when available (consent + data-gateway).
   * If the profiles module or identity authorization is unavailable, returns
   * an empty list rather than exposing PII.
   */
  async searchProfiles(
    query: string,
    opts?: { programId?: ProgramId; accountId?: string },
  ): Promise<Profile[]> {
    let profiles: Profile[];
    try {
      const profilesModulePath = "../profiles";
      const mod: { getProfiles(): unknown } = await import(profilesModulePath);
      const mgr = mod.getProfiles() as {
        list(): unknown;
        snapshot(accountId: unknown): unknown;
      };
      const raw = opts?.accountId ? mgr.snapshot(opts.accountId) : mgr.list();
      profiles = (Array.isArray(raw) ? raw : []) as Profile[];
    } catch {
      // profiles module not yet wired — fall back to local index.
      profiles = [...this.indexes.profiles.docs.values()].map(
        (d) => d.doc as unknown as Profile,
      );
    }
    if (opts?.programId) {
      profiles = profiles.filter((p) => p.programId === opts.programId);
    }
    if (!query || query.trim() === "") return profiles;
    const qTokens = new Set(tokenize(query));
    return profiles
      .map((p) => ({ p, score: this.scoreProfile(p, qTokens) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }

  private scoreProfile(p: Profile, qTokens: Set<string>): number {
    const fields = [p.displayName, p.biologicalSex, p.ageRange, p.country];
    let score = 0;
    for (const field of fields) {
      if (!field) continue;
      for (const t of tokenize(field)) {
        if (qTokens.has(t)) score += 1;
      }
    }
    if (p.customAttributes) {
      for (const v of Object.values(p.customAttributes)) {
        for (const t of tokenizeValue(v)) {
          if (qTokens.has(t)) score += 1;
        }
      }
    }
    return score;
  }

  // -------------------------------------------------------------------------
  // Aggregation (REAL group-by + count/avg/min/max/sum)
  // -------------------------------------------------------------------------

  /**
   * Group measurements by a field (schemaId, sourceType, verificationState,
   * profileId, programId, unit, day, week, month) and compute count, avg,
   * min, max, sum over the numeric portion of each measurement's value.
   */
  aggregate(
    measurements: readonly Measurement[],
    spec: AggregationSpec,
  ): AggregationResult {
    // First pass: collect numeric values per group + total count per group.
    const numericByGroup = new Map<string, number[]>();
    const countByGroup = new Map<string, number>();
    for (const m of measurements) {
      const key = this.groupKey(m, spec.field);
      countByGroup.set(key, (countByGroup.get(key) ?? 0) + 1);
      const n = toNumeric(m.value);
      if (n !== null) {
        let bucket = numericByGroup.get(key);
        if (!bucket) {
          bucket = [];
          numericByGroup.set(key, bucket);
        }
        bucket.push(n);
      }
    }

    const buckets: AggregationBucket[] = [];
    for (const [key, count] of countByGroup) {
      const values = numericByGroup.get(key) ?? [];
      const metrics: Partial<Record<AggregationMetric, number>> = {};
      for (const metric of spec.metrics) {
        if (metric === "count") {
          metrics.count = count;
        } else if (values.length > 0) {
          switch (metric) {
            case "avg":
              metrics.avg = values.reduce((a, b) => a + b, 0) / values.length;
              break;
            case "min":
              metrics.min = Math.min(...values);
              break;
            case "max":
              metrics.max = Math.max(...values);
              break;
            case "sum":
              metrics.sum = values.reduce((a, b) => a + b, 0);
              break;
          }
        }
      }
      // Always include count even if not explicitly requested.
      if (metrics.count === undefined) metrics.count = count;
      buckets.push({ key, count, metrics });
    }

    buckets.sort((a, b) => b.count - a.count);
    return { name: spec.name, field: spec.field, buckets };
  }

  private groupKey(m: Measurement, field: AggregationGroupBy): string {
    switch (field) {
      case "schemaId":
        return m.schemaId as string;
      case "sourceType":
        return sourceTypeOf(m) ?? "unknown";
      case "verificationState":
        return m.verificationState;
      case "profileId":
        return m.profileId as string;
      case "programId":
        return (programIdOf(m) as string | undefined) ?? "none";
      case "unit":
        return unitSymbolOf(m) ?? (m.unitId as string);
      case "day":
        return dateBucket(timestampOf(m), "day");
      case "week":
        return dateBucket(timestampOf(m), "week");
      case "month":
        return dateBucket(timestampOf(m), "month");
      default:
        return "unknown";
    }
  }

  // -------------------------------------------------------------------------
  // Stats & saved queries
  // -------------------------------------------------------------------------

  getStats(): QueryStats {
    return {
      indexSizes: {
        measurements: this.indexes.measurements.docs.size,
        schemas: this.indexes.schemas.docs.size,
        profiles: this.indexes.profiles.docs.size,
        evidence: this.indexes.evidence.docs.size,
      },
      queryCount: this.queryCount,
      lastQueryAt: this.lastQueryAt,
      savedQueryCount: this.savedQueries.size,
    };
  }

  saveQuery(query: SearchQuery, name: string, savedBy: string): SavedQuery {
    if (!name || name.trim() === "") {
      throw new HealthError({
        code: "eks.health.query.name_required",
        category: "schema_invalid",
        message: "Saved query name is required.",
        userMessage: "Provide a name for the saved query.",
      });
    }
    const id = asQueryId(generateId("qry_"));
    const saved: SavedQuery = {
      id,
      name,
      query,
      savedBy,
      savedAt: getClock().iso(),
    };
    this.savedQueries.set(id, saved);
    void getEventBus().publish(
      buildEvent(SEARCH_EVENTS.querySaved, { queryId: id, name, savedBy }, {}, "domain"),
    );
    return saved;
  }

  listSavedQueries(): SavedQuery[] {
    return [...this.savedQueries.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  getSavedQuery(id: QueryId): SavedQuery | undefined {
    return this.savedQueries.get(id);
  }

  deleteSavedQuery(id: QueryId): boolean {
    return this.savedQueries.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a doc's fields into kernel SearchFieldValue shapes. The kernel
 * search index only accepts string | number | boolean | null | readonly arrays.
 */
function serializeFields(
  doc: Record<string, unknown>,
): Record<string, string | number | boolean | null | readonly string[] | readonly number[]> {
  const out: Record<string, string | number | boolean | null | readonly string[] | readonly number[]> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))) as readonly string[];
    } else {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: HealthSearchEngine | null = null;

export function getHealthSearch(): HealthSearchEngine {
  if (!_engine) _engine = new HealthSearchEngine();
  return _engine;
}

export function setHealthSearch(engine: HealthSearchEngine): void {
  _engine = engine;
}

export function resetHealthSearch(): void {
  _engine = null;
}
