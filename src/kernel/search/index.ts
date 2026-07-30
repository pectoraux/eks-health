/**
 * Eks-Health Kernel — Search Architecture
 *
 * The platform's search abstraction layer. This module is *not* a full text
 * engine — it is the contract that every search provider (Elasticsearch,
 * OpenSearch, Meilisearch, Typesense, Postgres FTS, or an in-memory default)
 * must implement, plus a manager that routes queries to the right index and
 * a registry of well-known indices.
 *
 * Capabilities:
 *  - Pluggable providers (default: in-memory tokenized inverted index)
 *  - Named indices with declared searchable / filterable / sortable fields
 *  - Full-text + phrase queries
 *  - Field filters (eq, ne, in, gt, gte, lt, lte, exists, prefix)
 *  - Sorting (asc/desc) on declared sortable fields
 *  - Highlights (snippets with <mark> wrappers)
 *  - Terms aggregations (facets for marketplace filters, etc.)
 *  - Re-index on demand (rebuild from the document source)
 *
 * The default adapter is in-memory; production swaps in Elasticsearch/Meili.
 */

import type { CorrelationId } from "../core";
import { NotFoundError, ValidationError, getClock } from "../core";

// ---------------------------------------------------------------------------
// Document & query model
// ---------------------------------------------------------------------------

export type SearchFieldValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[];

export interface SearchDocument {
  readonly id: string;
  readonly fields: Record<string, SearchFieldValue>;
}

export interface SearchIndex {
  readonly name: string;
  readonly description?: string;
  readonly searchableFields: readonly string[];
  readonly filterableFields: readonly string[];
  readonly sortableFields: readonly string[];
}

export type SearchFilterOp =
  | "eq"
  | "ne"
  | "in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "prefix";

export interface SearchFilter {
  readonly field: string;
  readonly op: SearchFilterOp;
  readonly value?: SearchFieldValue | readonly SearchFieldValue[];
}

export interface SearchSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface SearchAggregation {
  readonly name: string;
  readonly field: string;
  readonly kind: "terms" | "range" | "stats";
  readonly ranges?: readonly { readonly key: string; readonly from?: number; readonly to?: number }[];
}

export interface SearchHighlight {
  readonly field: string;
  readonly snippet: string;
}

export interface SearchQuery {
  readonly query?: string;
  readonly phrase?: string;
  readonly filters?: readonly SearchFilter[];
  readonly sort?: SearchSort;
  readonly limit?: number;
  readonly offset?: number;
  readonly highlights?: readonly string[];
  readonly aggregations?: readonly SearchAggregation[];
}

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  readonly doc: SearchDocument;
  readonly highlights?: readonly SearchHighlight[];
}

export interface SearchResult {
  readonly indexName: string;
  readonly hits: readonly SearchHit[];
  readonly total: number;
  readonly tookMs: number;
  readonly aggregations?: Record<string, Record<string, number>>;
  readonly correlationId?: CorrelationId;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface SearchProvider {
  readonly name: string;
  index(indexName: string, doc: SearchDocument): Promise<void>;
  search(indexName: string, query: SearchQuery): Promise<SearchResult>;
  delete(indexName: string, id: string): Promise<boolean>;
  reindex(indexName: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Default indices
// ---------------------------------------------------------------------------

export const INDICES = {
  users: "users",
  programs: "programs",
  measurements: "measurements",
  research: "research",
  documentation: "documentation",
  marketplace: "marketplace",
  extensions: "extensions",
} as const;

export type SearchIndexName = keyof typeof INDICES;

export const INDEX_DEFINITIONS: Record<SearchIndexName, SearchIndex> = {
  users: {
    name: INDICES.users,
    description: "Patient, clinician, and operator profiles.",
    searchableFields: ["displayName", "email", "bio", "specialization"],
    filterableFields: ["country", "role", "organizationId", "status", "createdAt"],
    sortableFields: ["createdAt", "displayName"],
  },
  programs: {
    name: INDICES.programs,
    description: "Preventive health programs published to the catalog.",
    searchableFields: ["title", "description", "tags", "category"],
    filterableFields: ["category", "ownerId", "published", "language", "country"],
    sortableFields: ["createdAt", "title", "popularity"],
  },
  measurements: {
    name: INDICES.measurements,
    description: "Per-user health measurements & observations.",
    searchableFields: ["type", "notes", "unit"],
    filterableFields: ["userId", "type", "programId", "takenAt", "value"],
    sortableFields: ["takenAt", "value"],
  },
  research: {
    name: INDICES.research,
    description: "Peer-reviewed studies & citations.",
    searchableFields: ["title", "abstract", "authors", "keywords"],
    filterableFields: ["domain", "year", "peerReviewed", "journal"],
    sortableFields: ["publishedAt", "citations"],
  },
  documentation: {
    name: INDICES.documentation,
    description: "Help center, API docs, guides.",
    searchableFields: ["title", "body", "tags", "section"],
    filterableFields: ["category", "version", "audience"],
    sortableFields: ["updatedAt", "title"],
  },
  marketplace: {
    name: INDICES.marketplace,
    description: "Extensions & integrations marketplace.",
    searchableFields: ["name", "description", "vendor", "tags"],
    filterableFields: ["category", "price", "rating", "verified"],
    sortableFields: ["price", "rating", "downloads", "publishedAt"],
  },
  extensions: {
    name: INDICES.extensions,
    description: "Installed extensions & their metadata.",
    searchableFields: ["name", "description", "author"],
    filterableFields: ["version", "category", "verified", "enabled"],
    sortableFields: ["publishedAt", "downloads"],
  },
};

// ---------------------------------------------------------------------------
// In-memory provider (default adapter) — tokenized inverted index
// ---------------------------------------------------------------------------

interface IndexedDoc {
  readonly doc: SearchDocument;
  /** field -> ordered tokens */
  readonly fieldTokens: Map<string, string[]>;
  /** token -> term frequency across all searchable fields */
  readonly tf: Map<string, number>;
  /** token -> set of fields containing it (for field-scoped queries) */
  readonly fieldsByToken: Map<string, Set<string>>;
}

interface IndexState {
  readonly definition: SearchIndex;
  docs: Map<string, IndexedDoc>;
  /** token -> Set<docId> */
  inverted: Map<string, Set<string>>;
  /** total token count across the index (for avgdl in BM25) */
  totalTokens: number;
}

/** Tokenize: lowercase, split on whitespace + punctuation, drop empties. */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length > 0);
}

function tokenizeValue(value: SearchFieldValue): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return tokenize(value);
  if (typeof value === "number" || typeof value === "boolean") return tokenize(String(value));
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) out.push(...tokenizeValue(v as SearchFieldValue));
    return out;
  }
  return [];
}

const K1 = 1.5;
const B = 0.75;

export class InMemorySearchProvider implements SearchProvider {
  readonly name = "in-memory";
  private readonly indices = new Map<string, IndexState>();

  /** Ensure an index exists in this provider. */
  private ensureIndex(indexName: string): IndexState {
    let state = this.indices.get(indexName);
    if (!state) {
      // Fall back to a permissive definition if the index wasn't pre-registered.
      const def =
        INDEX_DEFINITIONS[indexName as SearchIndexName] ??
        ({
          name: indexName,
          searchableFields: [],
          filterableFields: [],
          sortableFields: [],
        } as SearchIndex);
      state = {
        definition: def,
        docs: new Map(),
        inverted: new Map(),
        totalTokens: 0,
      };
      this.indices.set(indexName, state);
    }
    return state;
  }

  async index(indexName: string, doc: SearchDocument): Promise<void> {
    const state = this.ensureIndex(indexName);
    // Remove existing version if present.
    if (state.docs.has(doc.id)) {
      this.removeFromInverted(state, doc.id);
    }
    const searchable = state.definition.searchableFields.length
      ? state.definition.searchableFields
      : Object.keys(doc.fields);
    const tokensByField = new Map<string, string[]>();
    const tf = new Map<string, number>();
    const fieldsByToken = new Map<string, Set<string>>();
    let docTokens = 0;
    for (const field of searchable) {
      const toks = tokenizeValue(doc.fields[field] ?? null);
      tokensByField.set(field, toks);
      docTokens += toks.length;
      const seenInThisField = new Set<string>();
      for (const t of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        seenInThisField.add(t);
      }
      for (const t of seenInThisField) {
        let set = fieldsByToken.get(t);
        if (!set) {
          set = new Set();
          fieldsByToken.set(t, set);
        }
        set.add(field);
      }
    }
    const indexed: IndexedDoc = { doc, fieldTokens: tokensByField, tf, fieldsByToken };
    state.docs.set(doc.id, indexed);
    for (const token of tf.keys()) {
      let postings = state.inverted.get(token);
      if (!postings) {
        postings = new Set();
        state.inverted.set(token, postings);
      }
      postings.add(doc.id);
    }
    state.totalTokens += docTokens;
  }

  private removeFromInverted(state: IndexState, docId: string): void {
    const existing = state.docs.get(docId);
    if (!existing) return;
    for (const [token, set] of existing.fieldsByToken.entries()) {
      void set;
      const postings = state.inverted.get(token);
      if (postings) {
        postings.delete(docId);
        if (postings.size === 0) state.inverted.delete(token);
      }
    }
    let docLen = 0;
    for (const toks of existing.fieldTokens.values()) docLen += toks.length;
    state.totalTokens -= docLen;
    state.docs.delete(docId);
  }

  async delete(indexName: string, id: string): Promise<boolean> {
    const state = this.indices.get(indexName);
    if (!state) return false;
    if (!state.docs.has(id)) return false;
    this.removeFromInverted(state, id);
    return true;
  }

  async reindex(indexName: string): Promise<number> {
    const state = this.indices.get(indexName);
    if (!state) return 0;
    const snapshot = [...state.docs.values()].map((d) => d.doc);
    // Reset
    state.docs.clear();
    state.inverted.clear();
    state.totalTokens = 0;
    for (const doc of snapshot) {
      await this.index(indexName, doc);
    }
    return snapshot.length;
  }

  async search(indexName: string, query: SearchQuery): Promise<SearchResult> {
    const started = getClock().epochMs();
    const state = this.ensureIndex(indexName);
    const def = state.definition;
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    // --- Candidate set: start with all docs, narrow by filters ---
    let candidateIds = new Set<string>(state.docs.keys());

    if (query.filters && query.filters.length > 0) {
      for (const f of query.filters) {
        if (def.filterableFields.length && !def.filterableFields.includes(f.field)) {
          throw new ValidationError(
            "eks.error.search.field_not_filterable",
            `Field '${f.field}' is not filterable in index '${indexName}'`,
            "Search filter is not allowed.",
          );
        }
        candidateIds = this.applyFilter(state, candidateIds, f);
      }
    }

    // --- Text query: tokenize + score (BM25-ish) ---
    const queryTokens = query.query ? tokenize(query.query) : [];
    const phraseTokens = query.phrase ? tokenize(query.phrase) : [];

    const avgdl = state.docs.size > 0 ? state.totalTokens / state.docs.size : 0;
    const scored: { id: string; score: number; doc: SearchDocument }[] = [];

    for (const id of candidateIds) {
      const idx = state.docs.get(id)!;
      let score = 0;
      let matched = false;

      if (queryTokens.length > 0) {
        for (const qt of queryTokens) {
          const postings = state.inverted.get(qt);
          if (!postings || !postings.has(id)) continue;
          matched = true;
          const tf = idx.tf.get(qt) ?? 0;
          const df = postings.size;
          const N = state.docs.size;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          let docLen = 0;
          for (const toks of idx.fieldTokens.values()) docLen += toks.length;
          const denom = tf + K1 * (1 - B + B * (docLen / (avgdl || 1)));
          score += (idf * (tf * (K1 + 1))) / (denom || 1);
        }
        // OR semantics: a doc must match at least one query token to qualify.
        if (!matched) continue;
      } else if (query.phrase) {
        // Phrase-only query: include docs that contain the phrase.
        if (!this.containsPhrase(idx, phraseTokens)) continue;
        matched = true;
        score = 1;
      }
      // else: no text query — match-all (filtered listing). Score 0.

      // Phrase filter on top of token query.
      if (query.phrase && !this.containsPhrase(idx, phraseTokens)) {
        continue;
      }

      scored.push({ id, score, doc: idx.doc });
    }

    // --- Sort ---
    if (query.sort) {
      if (def.sortableFields.length && !def.sortableFields.includes(query.sort.field)) {
        throw new ValidationError(
          "eks.error.search.field_not_sortable",
          `Field '${query.sort.field}' is not sortable in index '${indexName}'`,
          "Search sort is not allowed.",
        );
      }
      const dir = query.sort.direction === "asc" ? 1 : -1;
      const field = query.sort.field;
      scored.sort((a, b) => {
        const av = a.doc.fields[field];
        const bv = b.doc.fields[field];
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === "number" && typeof bv === "number") {
          return (av - bv) * dir;
        }
        return String(av).localeCompare(String(bv)) * dir;
      });
    } else if (queryTokens.length > 0 || query.phrase) {
      // Default: relevance desc.
      scored.sort((a, b) => b.score - a.score);
    }

    const total = scored.length;
    const page = scored.slice(offset, offset + limit);

    // --- Highlights ---
    const highlightFields =
      query.highlights ?? (def.searchableFields.length ? def.searchableFields.slice(0, 2) : []);

    const hits: SearchHit[] = page.map(({ id, score, doc }) => {
      const idx = state.docs.get(id)!;
      const highlights: SearchHighlight[] = [];
      if (queryTokens.length > 0 || phraseTokens.length > 0) {
        const needles = new Set([...queryTokens, ...phraseTokens]);
        for (const field of highlightFields) {
          const toks = idx.fieldTokens.get(field) ?? [];
          if (toks.length === 0) continue;
          const snippet = buildSnippet(toks, needles);
          if (snippet) highlights.push({ field, snippet });
        }
      }
      return { id, score, doc, highlights: highlights.length ? highlights : undefined };
    });

    // --- Aggregations (terms only for the default adapter) ---
    let aggregations: Record<string, Record<string, number>> | undefined;
    if (query.aggregations && query.aggregations.length > 0) {
      aggregations = {};
      for (const agg of query.aggregations) {
        if (def.filterableFields.length && !def.filterableFields.includes(agg.field)) {
          throw new ValidationError(
            "eks.error.search.field_not_aggregatable",
            `Field '${agg.field}' is not aggregatable in index '${indexName}'`,
            "Aggregation is not allowed.",
          );
        }
        const buckets: Record<string, number> = {};
        if (agg.kind === "terms") {
          for (const { doc } of scored) {
            const v = doc.fields[agg.field];
            if (v === null || v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) {
                const key = String(item);
                buckets[key] = (buckets[key] ?? 0) + 1;
              }
            } else {
              const key = String(v);
              buckets[key] = (buckets[key] ?? 0) + 1;
            }
          }
        } else if (agg.kind === "range" && agg.ranges) {
          for (const r of agg.ranges) buckets[r.key] = 0;
          for (const { doc } of scored) {
            const v = doc.fields[agg.field];
            if (typeof v !== "number") continue;
            for (const r of agg.ranges) {
              const from = r.from ?? -Infinity;
              const to = r.to ?? Infinity;
              if (v >= from && v < to) {
                buckets[r.key] = (buckets[r.key] ?? 0) + 1;
                break;
              }
            }
          }
        } else if (agg.kind === "stats") {
          let count = 0;
          let sum = 0;
          let min = Infinity;
          let max = -Infinity;
          for (const { doc } of scored) {
            const v = doc.fields[agg.field];
            if (typeof v !== "number") continue;
            count++;
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          buckets.count = count;
          buckets.sum = sum;
          buckets.min = count ? min : 0;
          buckets.max = count ? max : 0;
          buckets.avg = count ? sum / count : 0;
        }
        aggregations[agg.name] = buckets;
      }
    }

    const tookMs = getClock().epochMs() - started;
    return {
      indexName,
      hits,
      total,
      tookMs,
      aggregations,
    };
  }

  private applyFilter(state: IndexState, ids: Set<string>, f: SearchFilter): Set<string> {
    const out = new Set<string>();
    for (const id of ids) {
      const doc = state.docs.get(id)!.doc;
      const v = doc.fields[f.field];
      switch (f.op) {
        case "exists":
          if (v !== null && v !== undefined) out.add(id);
          break;
        case "eq":
          if (Array.isArray(v)) {
            if (v.some((x) => String(x) === String(f.value))) out.add(id);
          } else if (String(v) === String(f.value)) {
            out.add(id);
          }
          break;
        case "ne":
          if (Array.isArray(v)) {
            if (!v.some((x) => String(x) === String(f.value))) out.add(id);
          } else if (String(v) !== String(f.value)) {
            out.add(id);
          }
          break;
        case "in": {
          const vals = (f.value as readonly SearchFieldValue[] | undefined) ?? [];
          const set = new Set(vals.map((x) => String(x)));
          if (Array.isArray(v)) {
            if (v.some((x) => set.has(String(x)))) out.add(id);
          } else if (set.has(String(v))) {
            out.add(id);
          }
          break;
        }
        case "gt":
        case "gte":
        case "lt":
        case "lte": {
          const target = f.value as number | string | undefined;
          if (target === undefined) break;
          if (typeof v === "number" && typeof target === "number") {
            if (f.op === "gt" && v > target) out.add(id);
            else if (f.op === "gte" && v >= target) out.add(id);
            else if (f.op === "lt" && v < target) out.add(id);
            else if (f.op === "lte" && v <= target) out.add(id);
          } else if (typeof v === "string" && typeof target === "string") {
            const cmp = v.localeCompare(target);
            if (f.op === "gt" && cmp > 0) out.add(id);
            else if (f.op === "gte" && cmp >= 0) out.add(id);
            else if (f.op === "lt" && cmp < 0) out.add(id);
            else if (f.op === "lte" && cmp <= 0) out.add(id);
          }
          break;
        }
        case "prefix":
          if (typeof v === "string" && typeof f.value === "string") {
            if (v.toLowerCase().startsWith(f.value.toLowerCase())) out.add(id);
          }
          break;
      }
    }
    return out;
  }

  /** True if the phrase's tokens appear consecutively in any searchable field. */
  private containsPhrase(idx: IndexedDoc, phraseTokens: string[]): boolean {
    if (phraseTokens.length === 0) return true;
    for (const toks of idx.fieldTokens.values()) {
      for (let i = 0; i + phraseTokens.length <= toks.length; i++) {
        let match = true;
        for (let j = 0; j < phraseTokens.length; j++) {
          if (toks[i + j] !== phraseTokens[j]) {
            match = false;
            break;
          }
        }
        if (match) return true;
      }
    }
    return false;
  }

  /** Test/maintenance hook. */
  clear(indexName?: string): void {
    if (indexName) {
      this.indices.delete(indexName);
    } else {
      this.indices.clear();
    }
  }

  docCount(indexName: string): number {
    return this.indices.get(indexName)?.docs.size ?? 0;
  }
}

function buildSnippet(toks: string[], needles: Set<string>, radius = 6): string {
  if (toks.length === 0) return "";
  let firstHit = -1;
  for (let i = 0; i < toks.length; i++) {
    if (needles.has(toks[i])) {
      firstHit = i;
      break;
    }
  }
  if (firstHit === -1) return "";
  const start = Math.max(0, firstHit - radius);
  const end = Math.min(toks.length, firstHit + radius + 1);
  const slice = toks.slice(start, end);
  const marked = slice.map((t) => (needles.has(t) ? `<mark>${t}</mark>` : t));
  let snippet = marked.join(" ");
  if (start > 0) snippet = `… ${snippet}`;
  if (end < toks.length) snippet = `${snippet} …`;
  return snippet;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface SearchManagerStats {
  readonly registeredProviders: number;
  readonly registeredIndices: number;
  readonly defaultProvider: string | null;
}

export class SearchManager {
  private readonly providers = new Map<string, SearchProvider>();
  private readonly indices = new Map<string, SearchIndex>();
  private defaultProvider: string | null = null;

  constructor() {
    const mem = new InMemorySearchProvider();
    this.providers.set(mem.name, mem);
    this.defaultProvider = mem.name;
    // Register the well-known catalog.
    for (const name of Object.keys(INDEX_DEFINITIONS) as SearchIndexName[]) {
      this.indices.set(INDEX_DEFINITIONS[name].name, INDEX_DEFINITIONS[name]);
    }
  }

  registerProvider(name: string, provider: SearchProvider): void {
    this.providers.set(name, provider);
    if (this.defaultProvider === null) this.defaultProvider = name;
  }

  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new NotFoundError(
        "eks.error.search.provider_not_found",
        `Search provider '${name}' is not registered`,
        "Search provider is not configured.",
      );
    }
    this.defaultProvider = name;
  }

  getDefault(): SearchProvider {
    if (!this.defaultProvider) {
      throw new NotFoundError(
        "eks.error.search.no_default_provider",
        "No default search provider is configured",
        "Search is not configured.",
      );
    }
    const p = this.providers.get(this.defaultProvider);
    if (!p) {
      throw new NotFoundError(
        "eks.error.search.provider_not_found",
        `Default search provider '${this.defaultProvider}' is missing`,
        "Search is not configured.",
      );
    }
    return p;
  }

  getProvider(name: string): SearchProvider | undefined {
    return this.providers.get(name);
  }

  listProviders(): readonly string[] {
    return [...this.providers.keys()];
  }

  registerIndex(index: SearchIndex): void {
    this.indices.set(index.name, index);
  }

  listIndices(): readonly SearchIndex[] {
    return [...this.indices.values()];
  }

  getIndex(name: string): SearchIndex | undefined {
    return this.indices.get(name);
  }

  /** Validate a doc against an index's declared fields. */
  private validateDoc(indexName: string, doc: SearchDocument): SearchIndex {
    const idx = this.indices.get(indexName);
    if (!idx) {
      throw new NotFoundError(
        "eks.error.search.index_not_found",
        `Search index '${indexName}' is not registered`,
        "Search index is not configured.",
      );
    }
    const declared = new Set([
      ...idx.searchableFields,
      ...idx.filterableFields,
      ...idx.sortableFields,
    ]);
    if (declared.size > 0) {
      for (const key of Object.keys(doc.fields)) {
        if (!declared.has(key)) {
          // Allow extra fields; they're just not searchable/filterable/sortable.
          // Real engines index arbitrary fields; we keep them as-is.
        }
      }
    }
    return idx;
  }

  async index(indexName: string, doc: SearchDocument): Promise<void> {
    this.validateDoc(indexName, doc);
    await this.getDefault().index(indexName, doc);
  }

  async search(indexName: string, query: SearchQuery): Promise<SearchResult> {
    if (!this.indices.has(indexName)) {
      throw new NotFoundError(
        "eks.error.search.index_not_found",
        `Search index '${indexName}' is not registered`,
        "Search index is not configured.",
      );
    }
    return this.getDefault().search(indexName, query);
  }

  async delete(indexName: string, id: string): Promise<boolean> {
    if (!this.indices.has(indexName)) {
      throw new NotFoundError(
        "eks.error.search.index_not_found",
        `Search index '${indexName}' is not registered`,
        "Search index is not configured.",
      );
    }
    return this.getDefault().delete(indexName, id);
  }

  async reindex(indexName: string): Promise<number> {
    if (!this.indices.has(indexName)) {
      throw new NotFoundError(
        "eks.error.search.index_not_found",
        `Search index '${indexName}' is not registered`,
        "Search index is not configured.",
      );
    }
    return this.getDefault().reindex(indexName);
  }

  stats(): SearchManagerStats {
    return {
      registeredProviders: this.providers.size,
      registeredIndices: this.indices.size,
      defaultProvider: this.defaultProvider,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _search: SearchManager | null = null;

export function getSearch(): SearchManager {
  if (!_search) _search = new SearchManager();
  return _search;
}

export function setSearch(mgr: SearchManager): void {
  _search = mgr;
}

export function resetSearch(): void {
  _search = null;
}
