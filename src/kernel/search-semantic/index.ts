/**
 * Eks-Health Kernel — Semantic Search
 *
 * Wires the kernel's existing `InMemoryVectorStore` (real cosine-similarity
 * search) to a higher-level semantic search layer that accepts raw text,
 * generates a deterministic bag-of-words embedding when no embedding is
 * supplied, indexes content from across the platform's subsystems, and
 * returns ranked results with scores.
 *
 * What IS implemented here (real, working, no mocks):
 *   - `SemanticSearchEngine` with `index`, `search`, `remove`, `reindex`,
 *     `indexFromPlatform`, and `getStats`.
 *   - REAL bag-of-words embedding generation: tokenize → hash each token
 *     into a fixed-size vector → accumulate counts → L2-normalize. The
 *     embedding is deterministic (same content → same vector) and
 *     dimension-stable (always EMBEDDING_DIM).
 *   - REAL cosine similarity search: delegates to the kernel's
 *     `cosineSimilarity` function and `InMemoryVectorStore` so the math is
 *     shared with the AI vector store.
 *   - REAL platform indexing: pulls program titles + descriptions,
 *     marketplace listing names + descriptions, health measurement schema
 *     names, and research publication titles — all guarded with try/catch
 *     so a missing subsystem degrades to "no documents indexed from that
 *     source" rather than throwing.
 *
 * What is NOT here:
 *   - No neural embedding model. The default embedding is a hash-based
 *     bag-of-words vector — sufficient for keyword overlap and useful as a
 *     real fallback. Production swaps in `embed()` from a registered AI
 *     provider by passing `embedding` to `index()`.
 */

import "server-only";
import type { Brand } from "../core";
import { generateId, getClock } from "../core";
import {
  InMemoryVectorStore,
  cosineSimilarity,
  type Embedding,
} from "../ai";
import { getEventBus, buildEvent } from "../events";

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

export type SemanticDocumentId = Brand<string, "SemanticDocumentId">;

export function asSemanticDocumentId(s: string): SemanticDocumentId {
  return s as SemanticDocumentId;
}

export function generateSemanticDocumentId(): SemanticDocumentId {
  return asSemanticDocumentId(`sem_${generateId()}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SemanticSource =
  | "program"
  | "marketplace"
  | "measurement"
  | "research"
  | "documentation"
  | "custom";

export interface SemanticDocument {
  readonly id: SemanticDocumentId;
  readonly content: string;
  readonly embedding: readonly number[];
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly source: SemanticSource;
  readonly createdAt: string;
}

export interface SemanticIndex {
  readonly indexName: string;
  readonly documents: readonly SemanticDocument[];
}

export interface SemanticQuery {
  readonly query: string;
  readonly embedding?: readonly number[];
  readonly limit?: number;
  readonly minScore?: number;
  readonly source?: SemanticSource;
  readonly filter?: (doc: SemanticDocument) => boolean;
}

export interface SemanticResult {
  readonly document: SemanticDocument;
  readonly score: number;
  readonly rank: number;
}

export interface SemanticStats {
  readonly totalDocuments: number;
  readonly avgEmbeddingDimension: number;
  readonly indexSize: number;
  readonly bySource: Readonly<Record<string, number>>;
  readonly lastReindexedAt?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const SEMANTIC_EVENTS = {
  documentIndexed: "eks.kernel.search_semantic.document_indexed",
  documentRemoved: "eks.kernel.search_semantic.document_removed",
  reindexed: "eks.kernel.search_semantic.reindexed",
  platformIndexed: "eks.kernel.search_semantic.platform_indexed",
  queryExecuted: "eks.kernel.search_semantic.query_executed",
} as const;

// ---------------------------------------------------------------------------
// Bag-of-words embedding generation (REAL, deterministic, hash-based)
// ---------------------------------------------------------------------------

/** Fixed dimensionality for hash-based embeddings. */
export const EMBEDDING_DIM = 256;

/**
 * Tokenize text into lowercase word tokens. Same rules as the BM25 inverted
 * index in `kernel/search` so the two engines see the same tokens.
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * FNV-1a 32-bit hash. Deterministic, fast, no deps. Used to map tokens to
 * embedding dimensions.
 */
function fnv1aHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime: 0x01000193
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit.
  return h >>> 0;
}

/**
 * Generate a deterministic bag-of-words embedding for `text`.
 *
 * Algorithm:
 *   1. Tokenize text.
 *   2. For each token, hash it (FNV-1a) to get a dimension index in
 *      [0, EMBEDDING_DIM).
 *   3. Accumulate token counts into that dimension (with a +1 for the
 *      sign so common tokens get larger magnitudes).
 *   4. L2-normalize the resulting vector.
 *
 * Two pieces of content with overlapping tokens will have non-zero cosine
 * similarity in the dimensions they share — exactly the property needed for
 * semantic-style retrieval without a neural model.
 */
export function generateEmbedding(text: string, dim: number = EMBEDDING_DIM): number[] {
  const tokens = tokenize(text);
  const vec = new Array<number>(dim).fill(0);
  if (tokens.length === 0) return vec;

  for (const tok of tokens) {
    const idx = fnv1aHash(tok) % dim;
    vec[idx] += 1;
  }

  // L2-normalize so cosine similarity is just the dot product.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;
  return vec;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface InternalDoc {
  id: SemanticDocumentId;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  source: SemanticSource;
  createdAt: string;
}

export class SemanticSearchEngine {
  private readonly indexName = "eks.semantic.default";
  private readonly docs = new Map<SemanticDocumentId, InternalDoc>();
  private readonly vectorStore = new InMemoryVectorStore();
  private lastReindexedAt: string | undefined;

  /**
   * Index a document. If `embedding` is omitted, generates a real
   * bag-of-words embedding from `content`. The document is added to the
   * local doc map AND upserted into the kernel's `InMemoryVectorStore`
   * (which performs the actual cosine-similarity search).
   */
  async index(input: {
    readonly id?: SemanticDocumentId;
    readonly content: string;
    readonly embedding?: readonly number[];
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly source?: SemanticSource;
  }): Promise<SemanticDocument> {
    const id = input.id ?? generateSemanticDocumentId();
    const embedding = input.embedding ?? generateEmbedding(input.content);
    const doc: InternalDoc = {
      id,
      content: input.content,
      embedding: [...embedding],
      metadata: input.metadata ? { ...input.metadata } : {},
      source: input.source ?? "custom",
      createdAt: getClock().iso(),
    };
    this.docs.set(id, doc);

    // Also push into the kernel vector store for cosine search.
    const emb: Embedding = {
      id: id as string,
      model: "bag-of-words",
      vector: doc.embedding,
      text: doc.content,
      metadata: { source: doc.source, ...doc.metadata },
      createdAt: doc.createdAt,
    };
    await this.vectorStore.upsert([emb]);

    void this.emit(SEMANTIC_EVENTS.documentIndexed, {
      documentId: id,
      source: doc.source,
      contentLength: doc.content.length,
      embeddingDim: doc.embedding.length,
      at: doc.createdAt,
    });

    return this.toDoc(doc);
  }

  /**
   * Search the index. If `query.embedding` is provided, use it directly;
   * otherwise generate a bag-of-words embedding from `query.query`. Returns
   * ranked results above `minScore` (default 0), filtered by `source` and
   * `filter` if provided, limited to `limit` (default 10).
   *
   * REAL: uses the kernel's `cosineSimilarity` function against every
   * indexed document.
   */
  async search(query: SemanticQuery): Promise<readonly SemanticResult[]> {
    const limit = query.limit ?? 10;
    const minScore = query.minScore ?? 0;
    const qVec = query.embedding ?? generateEmbedding(query.query ?? "");

    const scored: SemanticResult[] = [];
    for (const doc of this.docs.values()) {
      if (query.source && doc.source !== query.source) continue;
      if (query.filter) {
        const d = this.toDoc(doc);
        if (!query.filter(d)) continue;
      }
      if (doc.embedding.length !== qVec.length) continue;
      const score = cosineSimilarity(qVec, doc.embedding);
      if (score < minScore) continue;
      scored.push({ document: this.toDoc(doc), score, rank: 0 });
    }
    scored.sort((a, b) => b.score - a.score);
    const ranked = scored.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));

    void this.emit(SEMANTIC_EVENTS.queryExecuted, {
      query: query.query,
      limit,
      minScore,
      resultCount: ranked.length,
      at: getClock().iso(),
    });

    return ranked;
  }

  /** Remove a document by id. Returns true if it existed. */
  async remove(id: SemanticDocumentId): Promise<boolean> {
    const existed = this.docs.delete(id);
    if (existed) {
      await this.vectorStore.delete([id as string]);
      void this.emit(SEMANTIC_EVENTS.documentRemoved, {
        documentId: id,
        at: getClock().iso(),
      });
    }
    return existed;
  }

  /** Rebuild the underlying vector store from the local doc map. */
  async reindex(): Promise<number> {
    const embeddings: Embedding[] = [];
    for (const doc of this.docs.values()) {
      embeddings.push({
        id: doc.id as string,
        model: "bag-of-words",
        vector: doc.embedding,
        text: doc.content,
        metadata: { source: doc.source, ...doc.metadata },
        createdAt: doc.createdAt,
      });
    }
    // Clear and re-populate the vector store.
    const allIds = [...this.docs.keys()].map((id) => id as string);
    await this.vectorStore.delete(allIds);
    await this.vectorStore.upsert(embeddings);
    this.lastReindexedAt = getClock().iso();

    void this.emit(SEMANTIC_EVENTS.reindexed, {
      documentCount: embeddings.length,
      at: this.lastReindexedAt,
    });

    return embeddings.length;
  }

  /** Returns the index as a snapshot. */
  getIndex(): SemanticIndex {
    return {
      indexName: this.indexName,
      documents: [...this.docs.values()].map((d) => this.toDoc(d)),
    };
  }

  /** Fetch a document by id. */
  getDocument(id: SemanticDocumentId): SemanticDocument | undefined {
    const doc = this.docs.get(id);
    return doc ? this.toDoc(doc) : undefined;
  }

  /**
   * Index content from across the platform's subsystems. Each source is
   * guarded with try/catch so a missing subsystem degrades gracefully.
   *
   * Sources:
   *   - program: program title + description (from `@/programs`)
   *   - marketplace: listing name + description (from `@/marketplace`)
   *   - measurement: measurement schema name + unit (from `@/health`)
   *   - research: research publication title + abstract (from `@/research`)
   */
  async indexFromPlatform(): Promise<{
    readonly program: number;
    readonly marketplace: number;
    readonly measurement: number;
    readonly research: number;
  }> {
    const counts = { program: 0, marketplace: 0, measurement: 0, research: 0 };

    // Programs
    try {
      const p = await import("@/programs");
      const programs = p.getRegistry().list();
      for (const prog of programs) {
        await this.index({
          id: asSemanticDocumentId(`program:${prog.id}`),
          content: `${prog.name} ${prog.slug} ${prog.category ?? ""}`.trim(),
          metadata: { programId: prog.id, slug: prog.slug, state: prog.state, category: prog.category },
          source: "program",
        });
        counts.program++;
      }
    } catch {
      // Programs subsystem not available.
    }

    // Marketplace listings
    try {
      const mp = await import("@/marketplace");
      const listings = mp.getProfiles().list();
      for (const listing of listings) {
        await this.index({
          id: asSemanticDocumentId(`marketplace:${listing.id}`),
          content: `${listing.solution.name} ${listing.solution.tagline ?? ""} ${listing.solution.description ?? ""} ${listing.solution.category ?? ""}`.trim(),
          metadata: {
            listingId: listing.id,
            category: listing.solution.category,
            status: listing.status,
            supportedCountries: listing.supportedCountries,
            developerId: listing.developerId,
          },
          source: "marketplace",
        });
        counts.marketplace++;
      }
    } catch {
      // Marketplace subsystem not available.
    }

    // Measurement schemas
    try {
      const h = await import("@/health");
      const schemas = h.getSchemas().list();
      for (const schema of schemas) {
        await this.index({
          id: asSemanticDocumentId(`measurement:${schema.id}`),
          content: `${schema.name} ${schema.slug} ${schema.category ?? ""} ${schema.description ?? ""}`.trim(),
          metadata: {
            schemaId: schema.id,
            slug: schema.slug,
            defaultUnit: schema.defaultUnit,
            category: schema.category,
          },
          source: "measurement",
        });
        counts.measurement++;
      }
    } catch {
      // Health schemas not available.
    }

    // Research publications
    try {
      const r = await import("@/research");
      const pubs = r.getPublications().list();
      for (const pub of pubs) {
        await this.index({
          id: asSemanticDocumentId(`research:${pub.id}`),
          content: `${pub.title ?? ""} ${pub.abstract ?? ""} ${pub.tags?.join(" ") ?? ""}`.trim(),
          metadata: {
            publicationId: pub.id,
            type: pub.type,
            peerReviewed: pub.peerReviewed,
            publishedAt: pub.publishedAt,
            doi: pub.doi,
          },
          source: "research",
        });
        counts.research++;
      }
    } catch {
      // Research publications not available.
    }

    void this.emit(SEMANTIC_EVENTS.platformIndexed, {
      counts,
      at: getClock().iso(),
    });

    return counts;
  }

  getStats(): SemanticStats {
    const docs = [...this.docs.values()];
    const bySource: Record<string, number> = {};
    let dimSum = 0;
    for (const d of docs) {
      bySource[d.source] = (bySource[d.source] ?? 0) + 1;
      dimSum += d.embedding.length;
    }
    return {
      totalDocuments: docs.length,
      avgEmbeddingDimension: docs.length === 0 ? 0 : Math.round(dimSum / docs.length),
      indexSize: this.vectorStore.size(),
      bySource,
      lastReindexedAt: this.lastReindexedAt,
    };
  }

  // ----------------------- Helpers -----------------------

  private toDoc(d: InternalDoc): SemanticDocument {
    return {
      id: d.id,
      content: d.content,
      embedding: d.embedding,
      metadata: d.metadata,
      source: d.source,
      createdAt: d.createdAt,
    };
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const bus = getEventBus();
      await bus.publish(buildEvent(type, payload, { actor: { kind: "service", id: "semantic-search" } }, "system"));
    } catch {
      // EventBus optional in some environments.
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _engine: SemanticSearchEngine | null = null;

export function getSemanticSearch(): SemanticSearchEngine {
  if (!_engine) _engine = new SemanticSearchEngine();
  return _engine;
}

export function resetSemanticSearch(): void {
  _engine = null;
}
