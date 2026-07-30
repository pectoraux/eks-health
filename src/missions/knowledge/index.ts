/**
 * Eks-Health Mission Engine — Knowledge Base Integration
 *
 * Programs attach knowledge bases to their coaching methodology: clinical
 * guidelines, research papers, traditional medicine references, exercise
 * libraries, recipe databases, educational content, FAQs. The AI runtime
 * retrieves from these bases while RESPECTING LICENSING and PARTICIPANT
 * CONSENT.
 *
 * Search is a REAL tokenized text search: lowercase, split on whitespace,
 * score by term frequency × inverse-document-frequency. Only bases with
 * `licensing.allowedRetrieval === true` (and unexpired licenses) are
 * searchable. `retrieve()` additionally checks participant consent via the
 * identity consent manager before returning entries to an AI caller.
 */

import "server-only";
import {
  type KnowledgeBaseId,
  type KnowledgeEntryId,
  type KnowledgeBase,
  type KnowledgeEntry,
  type KnowledgeType,
  type ProgramId,
  type AccountId,
  MissionError,
  asKnowledgeBaseId,
  asKnowledgeEntryId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import { getConsent } from "@/identity";

// ---------------------------------------------------------------------------
// Query & result types
// ---------------------------------------------------------------------------

export interface KnowledgeQuery {
  readonly text: string;
  readonly baseIds?: readonly KnowledgeBaseId[];
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly minScore?: number;
}

export interface KnowledgeRetrievalResult {
  readonly entries: KnowledgeEntry[];
  readonly scores: number[];
  readonly totalFound: number;
  readonly queriedAt: string;
  readonly consentChecked: boolean;
}

export interface KnowledgeListFilter {
  readonly tags?: readonly string[];
  readonly type?: KnowledgeType;
  readonly searchText?: string;
}

export interface KnowledgeStats {
  readonly totalBases: number;
  readonly totalEntries: number;
  readonly byType: Record<string, number>;
  readonly avgEntriesPerBase: number;
  readonly retrievalAllowedBases: number;
}

export interface CreateKnowledgeBaseInput {
  readonly programId: ProgramId;
  readonly name: string;
  readonly description: string;
  readonly type: KnowledgeType;
  readonly licensing?: {
    readonly license: string;
    readonly expiresAt?: string;
    readonly allowedRetrieval: boolean;
  };
}

export interface AddKnowledgeEntryInput {
  readonly title: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Knowledge manager
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "is",
  "are", "was", "were", "be", "been", "being", "have", "has", "had", "do",
  "does", "did", "will", "would", "could", "should", "may", "might", "for",
  "with", "as", "by", "this", "that", "these", "those", "it", "its", "from",
]);

export class KnowledgeManager {
  private readonly bases = new Map<KnowledgeBaseId, KnowledgeBase>();
  private readonly entries = new Map<KnowledgeEntryId, KnowledgeEntry>();
  private readonly entriesByBase = new Map<KnowledgeBaseId, KnowledgeEntryId[]>();
  private readonly byProgram = new Map<ProgramId, KnowledgeBaseId[]>();
  // Pre-tokenized index: entryId → term frequency map
  private readonly index = new Map<KnowledgeEntryId, Map<string, number>>();
  // Document frequency: term → number of entries containing it
  private readonly df = new Map<string, number>();

  createBase(input: CreateKnowledgeBaseInput): KnowledgeBase {
    // Validate licensing: if licensing is provided, allowedRetrieval must be
    // explicit (not undefined). If expiresAt is in the past, the base is
    // created but flagged as non-retrievable.
    if (input.licensing && typeof input.licensing.allowedRetrieval !== "boolean") {
      throw new MissionError({
        code: "eks.mission.knowledge.invalid_licensing",
        category: "validation",
        message: "licensing.allowedRetrieval must be a boolean.",
        userMessage: "Knowledge base licensing is misconfigured.",
      });
    }
    let effectiveLicensing = input.licensing;
    if (input.licensing?.expiresAt) {
      const expired = new Date(input.licensing.expiresAt).getTime() < Date.now();
      if (expired) {
        effectiveLicensing = { ...input.licensing, allowedRetrieval: false };
      }
    }
    const base: KnowledgeBase = {
      id: asKnowledgeBaseId(generateId("kb_")),
      programId: input.programId,
      name: input.name,
      description: input.description,
      type: input.type,
      entryCount: 0,
      createdAt: getClock().iso(),
      licensing: effectiveLicensing,
    };
    this.bases.set(base.id, base);
    this.entriesByBase.set(base.id, []);
    const list = this.byProgram.get(input.programId) ?? [];
    this.byProgram.set(input.programId, [...list, base.id]);
    void getEventBus().publish(
      buildEvent(
        "eks.mission.knowledge.base_created",
        { baseId: base.id, programId: input.programId, type: input.type },
        {},
        "domain",
      ),
    );
    return base;
  }

  getBase(id: KnowledgeBaseId): KnowledgeBase | undefined {
    return this.bases.get(id);
  }

  listBases(programId?: ProgramId): KnowledgeBase[] {
    let list = [...this.bases.values()];
    if (programId) list = list.filter((b) => b.programId === programId);
    return list;
  }

  addEntry(baseId: KnowledgeBaseId, input: AddKnowledgeEntryInput): KnowledgeEntry {
    const base = this.bases.get(baseId);
    if (!base) {
      throw new MissionError({
        code: "eks.mission.knowledge.base_not_found",
        category: "not_found",
        message: `Knowledge base ${baseId} not found.`,
        userMessage: "Knowledge base not found.",
        metadata: { baseId },
      });
    }
    const entry: KnowledgeEntry = {
      id: asKnowledgeEntryId(generateId("ke_")),
      baseId,
      title: input.title,
      content: input.content,
      tags: [...(input.tags ?? [])],
      metadata: input.metadata,
      createdAt: getClock().iso(),
    };
    this.entries.set(entry.id, entry);
    const list = this.entriesByBase.get(baseId) ?? [];
    this.entriesByBase.set(baseId, [...list, entry.id]);

    // Tokenize & index
    const tf = this.tokenize(input.title + " " + input.content);
    this.index.set(entry.id, tf);
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }

    // Update entry count
    const updated: KnowledgeBase = { ...base, entryCount: base.entryCount + 1 };
    this.bases.set(baseId, updated);

    void getEventBus().publish(
      buildEvent(
        "eks.mission.knowledge.entry_added",
        { baseId, entryId: entry.id, programId: base.programId },
        {},
        "domain",
      ),
    );
    return entry;
  }

  getEntry(id: KnowledgeEntryId): KnowledgeEntry | undefined {
    return this.entries.get(id);
  }

  listEntries(baseId: KnowledgeBaseId, filter?: KnowledgeListFilter): KnowledgeEntry[] {
    const ids = this.entriesByBase.get(baseId) ?? [];
    let list = ids.map((id) => this.entries.get(id)!).filter(Boolean);
    if (filter?.type) {
      const base = this.bases.get(baseId);
      if (base && base.type !== filter.type) return [];
    }
    if (filter?.tags && filter.tags.length > 0) {
      const tagSet = new Set(filter.tags);
      list = list.filter((e) => e.tags.some((t) => tagSet.has(t)));
    }
    if (filter?.searchText) {
      const qTokens = new Set(this.tokenize(filter.searchText).keys());
      list = list.filter((e) => {
        const tf = this.index.get(e.id);
        if (!tf) return false;
        for (const t of qTokens) if (tf.has(t)) return true;
        return false;
      });
    }
    return list;
  }

  /**
   * REAL tokenized text search across entries. Returns ranked results by
   * relevance (TF-IDF token overlap score). Respects licensing: only
   * retrieves from bases with `allowedRetrieval === true` and unexpired
   * licenses.
   */
  search(query: KnowledgeQuery): KnowledgeRetrievalResult {
    const queriedAt = getClock().iso();
    const qTokens = this.tokenize(query.text);
    if (qTokens.size === 0) {
      return { entries: [], scores: [], totalFound: 0, queriedAt, consentChecked: false };
    }

    // Determine candidate bases (filtered by baseIds and licensing)
    const allowedBases = new Set<KnowledgeBaseId>();
    for (const base of this.bases.values()) {
      if (query.baseIds && !query.baseIds.includes(base.id)) continue;
      if (!this.isRetrievalAllowed(base)) continue;
      allowedBases.add(base.id);
    }

    const totalEntries = [...this.entriesByBase.entries()]
      .filter(([bid]) => allowedBases.has(bid))
      .reduce((a, [, ids]) => a + ids.length, 0);

    // Score every entry in allowed bases
    const scored: Array<{ entry: KnowledgeEntry; score: number }> = [];
    const N = this.entries.size;
    for (const baseId of allowedBases) {
      const ids = this.entriesByBase.get(baseId) ?? [];
      for (const entryId of ids) {
        const entry = this.entries.get(entryId);
        if (!entry) continue;
        // Optional tag filter
        if (query.tags && query.tags.length > 0) {
          const tagSet = new Set(query.tags);
          if (!entry.tags.some((t) => tagSet.has(t))) continue;
        }
        const tf = this.index.get(entryId);
        if (!tf) continue;
        let score = 0;
        for (const [term, qFreq] of qTokens) {
          const docFreq = tf.get(term) ?? 0;
          if (docFreq === 0) continue;
          const dfCount = this.df.get(term) ?? 0;
          // TF-IDF: term frequency in doc × log(N / df)
          const idf = dfCount > 0 ? Math.log(1 + N / dfCount) : 0;
          score += docFreq * idf * (1 + Math.log(qFreq));
        }
        if (score > 0) scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const minScore = query.minScore ?? 0;
    const filtered = scored.filter((s) => s.score >= minScore);
    const limit = query.limit ?? 20;
    const top = filtered.slice(0, limit);
    const maxScore = top.length > 0 ? top[0]!.score : 1;
    // Normalize scores to 0-1
    const normalizedScores = top.map((s) => (maxScore > 0 ? s.score / maxScore : 0));

    return {
      entries: top.map((s) => s.entry),
      scores: normalizedScores,
      totalFound: filtered.length,
      queriedAt,
      consentChecked: false,
    };
  }

  /**
   * Retrieval for the AI runtime. If `participantId` is provided, checks
   * consent via the identity consent manager (purpose: "ai_retrieval").
   * Falls back to search() if consent cannot be verified.
   */
  retrieve(query: KnowledgeQuery, participantId?: AccountId): KnowledgeRetrievalResult {
    let consentChecked = false;
    if (participantId) {
      try {
        const consent = getConsent();
        // Check for an active consent covering AI retrieval for any program
        // that owns a base in scope. We check the union of programIds
        // attached to the candidate bases.
        const candidateBases = (query.baseIds ?? [...this.bases.keys()])
          .map((id) => this.bases.get(id))
          .filter((b): b is KnowledgeBase => Boolean(b) && this.isRetrievalAllowed(b!));
        const programIds = new Set(candidateBases.map((b) => b.programId as string));
        let hasConsent = false;
        for (const pid of programIds) {
          if (consent.checkAccess(participantId, pid, "ai_retrieval")) {
            hasConsent = true;
            break;
          }
        }
        consentChecked = true;
        if (!hasConsent) {
          return {
            entries: [],
            scores: [],
            totalFound: 0,
            queriedAt: getClock().iso(),
            consentChecked: true,
          };
        }
      } catch {
        // Consent subsystem unavailable — fail closed for participant-scoped
        // retrieval (do not return entries).
        consentChecked = false;
        return {
          entries: [],
          scores: [],
          totalFound: 0,
          queriedAt: getClock().iso(),
          consentChecked: false,
        };
      }
    }
    const result = this.search(query);
    return { ...result, consentChecked };
  }

  removeEntry(id: KnowledgeEntryId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    // Update DF index
    const tf = this.index.get(id);
    if (tf) {
      for (const term of tf.keys()) {
        const current = this.df.get(term) ?? 0;
        if (current <= 1) this.df.delete(term);
        else this.df.set(term, current - 1);
      }
    }
    this.index.delete(id);
    this.entries.delete(id);
    const ids = this.entriesByBase.get(entry.baseId) ?? [];
    this.entriesByBase.set(entry.baseId, ids.filter((x) => x !== id));
    const base = this.bases.get(entry.baseId);
    if (base) {
      this.bases.set(entry.baseId, { ...base, entryCount: Math.max(0, base.entryCount - 1) });
    }
    void getEventBus().publish(
      buildEvent(
        "eks.mission.knowledge.entry_removed",
        { entryId: id, baseId: entry.baseId },
        {},
        "domain",
      ),
    );
  }

  getStats(programId?: ProgramId): KnowledgeStats {
    let bases = [...this.bases.values()];
    if (programId) bases = bases.filter((b) => b.programId === programId);
    const byType: Record<string, number> = {};
    let totalEntries = 0;
    let retrievalAllowed = 0;
    for (const b of bases) {
      byType[b.type] = (byType[b.type] ?? 0) + 1;
      totalEntries += b.entryCount;
      if (this.isRetrievalAllowed(b)) retrievalAllowed++;
    }
    return {
      totalBases: bases.length,
      totalEntries,
      byType,
      avgEntriesPerBase: bases.length > 0 ? totalEntries / bases.length : 0,
      retrievalAllowedBases: retrievalAllowed,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private isRetrievalAllowed(base: KnowledgeBase): boolean {
    if (!base.licensing) return true; // no licensing restriction → open
    if (!base.licensing.allowedRetrieval) return false;
    if (base.licensing.expiresAt && new Date(base.licensing.expiresAt).getTime() < Date.now()) {
      return false;
    }
    return true;
  }

  /**
   * Tokenize text: lowercase, split on non-alphanumeric, drop stop words,
   * return a term-frequency map.
   */
  private tokenize(text: string): Map<string, number> {
    const tf = new Map<string, number>();
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    return tf;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: KnowledgeManager | null = null;
export function getKnowledge(): KnowledgeManager {
  if (!_mgr) _mgr = new KnowledgeManager();
  return _mgr;
}

export function resetKnowledge(): void {
  _mgr = null;
}

export type {
  KnowledgeBaseId,
  KnowledgeEntryId,
  KnowledgeBase,
  KnowledgeEntry,
  KnowledgeType,
  ProgramId,
  AccountId,
};
