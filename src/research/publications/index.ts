/**
 * Eks-Health Research Platform — Publication Platform
 *
 * Researchers publish reports, dashboards, interactive findings, evidence
 * summaries, methodologies, visualizations, and program evaluations.
 * Publications link to Programs (which evidence supports them) and marketplace
 * listings (which solutions the publication evaluates). Publications are
 * tagged, peer-reviewed, DOIs assigned, and full-text searchable.
 *
 * Real logic:
 *  - Real validation: title, abstract, content must be non-empty; at least
 *    one author; type must be one of the seven PublicationTypes.
 *  - Real full-text search: tokenizes the query (lowercase, punctuation split,
 *    dedupe), then matches against title + abstract + tags using a real
 *    token-overlap scoring (title matches weighted 3x, abstract 2x, tags 1x).
 *    Returns relevance-ranked results.
 *  - Real tag management: add/remove with dedupe + case-insensitive comparison.
 *  - Real peer-review: setPeerReviewed flips the flag and (optionally) records
 *    a DOI. DOI is validated for plausible structure (starts with "10.").
 *  - Real program/listing links: get-by-program walks the linkedProgramIds
 *    index; get-by-listing walks linkedListingIds.
 *  - Real stats: by-type distribution, peer-reviewed count, average authors
 *    per publication — all computed by walking the registry.
 *
 * Boundary: publications only contain derived/anonymized findings, never raw
 * participant data. Authors are referenced by account id; affiliations are
 * optional. The publications subsystem does not enforce peer review — it
 * records it when attested by an external reviewer.
 */

import "server-only";
import type {
  AccountId,
  ProgramId,
  Publication,
  PublicationId,
  PublicationType,
  StudyId,
  WorkspaceId,
} from "../core";
import {
  RESEARCH_EVENTS,
  ResearchError,
  asPublicationId,
} from "../core";
import { buildEvent, generateId, getClock, getEventBus } from "@/kernel";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PublicationAuthor {
  readonly accountId: AccountId;
  readonly name: string;
  readonly affiliation?: string;
}

export interface PublishPublicationInput {
  readonly title: string;
  readonly abstract: string;
  readonly type: PublicationType;
  readonly content: string; // markdown
  readonly workspaceId: WorkspaceId;
  readonly studyId?: StudyId;
  readonly authors: PublicationAuthor[];
  readonly tags?: string[];
  readonly linkedProgramIds?: ProgramId[];
  readonly linkedListingIds?: string[];
  readonly publishedBy: AccountId;
}

export interface PublicationListFilter {
  readonly type?: PublicationType;
  readonly workspaceId?: WorkspaceId;
  readonly studyId?: StudyId;
  readonly peerReviewed?: boolean;
  readonly tags?: string[]; // any-of match
  readonly programId?: ProgramId;
  readonly listingId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PublicationSearchResult {
  readonly publication: Publication;
  readonly score: number;
  readonly matchedFields: string[];
}

export interface PublicationStats {
  readonly total: number;
  readonly byType: Record<PublicationType, number>;
  readonly peerReviewed: number;
  readonly withDoi: number;
  readonly averageAuthors: number;
  readonly totalTags: number;
  readonly totalProgramLinks: number;
  readonly totalListingLinks: number;
}

// ---------------------------------------------------------------------------
// Mutable internal types
// ---------------------------------------------------------------------------

interface MutablePublication extends Publication {
  title: string;
  abstract: string;
  type: PublicationType;
  content: string;
  authors: PublicationAuthor[];
  tags: string[];
  linkedProgramIds: ProgramId[];
  linkedListingIds: string[];
  doi?: string;
  peerReviewed: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PUBLICATION_TYPES: readonly PublicationType[] = [
  "report",
  "dashboard",
  "findings",
  "evidence_summary",
  "methodology",
  "visualization",
  "program_evaluation",
];

const TYPE_INDEX = new Map(PUBLICATION_TYPES.map((t, i) => [t, i] as const));

// ---------------------------------------------------------------------------
// PublicationManager
// ---------------------------------------------------------------------------

export class PublicationManager {
  private readonly publications = new Map<PublicationId, MutablePublication>();
  private readonly byWorkspace = new Map<WorkspaceId, PublicationId[]>();
  private readonly byStudy = new Map<StudyId, PublicationId[]>();
  private readonly byProgram = new Map<ProgramId, PublicationId[]>();
  private readonly byListing = new Map<string, PublicationId[]>();
  private readonly byTag = new Map<string, PublicationId[]>();

  /**
   * Publish a new publication. Validates required fields, normalizes tags,
   * indexes the publication across all lookup dimensions, and emits
   * eks.research.publication.released.
   */
  publish(input: PublishPublicationInput): Publication {
    this.validateInput(input);
    const now = getClock().iso();
    const id = asPublicationId(generateId("pub_"));
    const tags = this.normalizeTags(input.tags);
    const linkedProgramIds = [...new Set(input.linkedProgramIds ?? [])];
    const linkedListingIds = [...new Set(input.linkedListingIds ?? [])];

    const pub: MutablePublication = {
      id,
      title: input.title.trim(),
      abstract: input.abstract.trim(),
      type: input.type,
      content: input.content,
      workspaceId: input.workspaceId,
      studyId: input.studyId,
      authors: input.authors.map((a) => ({ ...a })),
      tags,
      linkedProgramIds,
      linkedListingIds,
      publishedAt: now,
      doi: undefined,
      peerReviewed: false,
    };

    this.publications.set(id, pub);
    this.index(this.byWorkspace, input.workspaceId, id);
    if (input.studyId) this.index(this.byStudy, input.studyId, id);
    for (const p of linkedProgramIds) this.index(this.byProgram, p, id);
    for (const l of linkedListingIds) this.index(this.byListing, l, id);
    for (const t of tags) this.index(this.byTag, t.toLowerCase(), id);

    void getEventBus().publish(
      buildEvent(
        RESEARCH_EVENTS.publicationReleased,
        {
          publicationId: id,
          workspaceId: input.workspaceId,
          studyId: input.studyId,
          type: input.type,
          authorCount: input.authors.length,
          publishedBy: input.publishedBy,
        },
        {},
        "domain",
      ),
    );

    // Notify the workspace (best-effort — workspace subsystem may or may not exist yet)
    void this.notifyWorkspace(input.workspaceId, id, input.publishedBy).catch(() => undefined);

    return this.freeze(pub);
  }

  /** Get a publication by id. */
  get(id: PublicationId): Publication {
    const pub = this.publications.get(id);
    if (!pub) {
      throw new ResearchError({
        code: "eks.research.publication.not_found",
        category: "not_found",
        message: `Publication ${id} not found.`,
        userMessage: "Publication not found.",
        metadata: { publicationId: id },
      });
    }
    return this.freeze(pub);
  }

  /** List publications by filter. */
  list(filter: PublicationListFilter = {}): Publication[] {
    let candidates: PublicationId[] | undefined;
    if (filter.workspaceId) {
      candidates = this.byWorkspace.get(filter.workspaceId);
    } else if (filter.studyId) {
      candidates = this.byStudy.get(filter.studyId);
    } else if (filter.programId) {
      candidates = this.byProgram.get(filter.programId);
    } else if (filter.listingId) {
      candidates = this.byListing.get(filter.listingId);
    } else if (filter.tags && filter.tags.length) {
      // intersection across tag matches (any-of within tag set, then union)
      const sets = filter.tags.map((t) => this.byTag.get(t.toLowerCase()) ?? []);
      const union = new Set<PublicationId>();
      for (const s of sets) for (const id of s) union.add(id);
      candidates = [...union];
    } else {
      candidates = [...this.publications.keys()];
    }

    let items = (candidates ?? [])
      .map((id) => this.publications.get(id)!)
      .filter(Boolean);

    if (filter.type) items = items.filter((p) => p.type === filter.type);
    if (filter.peerReviewed !== undefined) items = items.filter((p) => p.peerReviewed === filter.peerReviewed);
    if (filter.workspaceId && !candidates) items = items.filter((p) => p.workspaceId === filter.workspaceId);
    if (filter.studyId && !candidates) items = items.filter((p) => p.studyId === filter.studyId);

    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? items.length;
    return items.slice(offset, offset + limit).map((p) => this.freeze(p));
  }

  /** Link a publication to a Program. */
  linkProgram(publicationId: PublicationId, programId: ProgramId): Publication {
    const pub = this.requireMutable(publicationId);
    if (!pub.linkedProgramIds.includes(programId)) {
      pub.linkedProgramIds = [...pub.linkedProgramIds, programId];
      this.index(this.byProgram, programId, publicationId);
    }
    return this.freeze(pub);
  }

  /** Link a publication to a marketplace listing. */
  linkListing(publicationId: PublicationId, listingId: string): Publication {
    if (!listingId) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "Listing id is required.",
      });
    }
    const pub = this.requireMutable(publicationId);
    if (!pub.linkedListingIds.includes(listingId)) {
      pub.linkedListingIds = [...pub.linkedListingIds, listingId];
      this.index(this.byListing, listingId, publicationId);
    }
    return this.freeze(pub);
  }

  /** Add a tag (case-insensitive dedupe). */
  addTag(publicationId: PublicationId, tag: string): Publication {
    const normalized = this.normalizeTag(tag);
    if (!normalized) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "Tag must be non-empty.",
      });
    }
    const pub = this.requireMutable(publicationId);
    const lower = normalized.toLowerCase();
    if (pub.tags.some((t) => t.toLowerCase() === lower)) return this.freeze(pub);
    pub.tags = [...pub.tags, normalized];
    this.index(this.byTag, lower, publicationId);
    return this.freeze(pub);
  }

  /** Remove a tag (case-insensitive match). */
  removeTag(publicationId: PublicationId, tag: string): Publication {
    const pub = this.requireMutable(publicationId);
    const lower = tag.toLowerCase();
    if (!pub.tags.some((t) => t.toLowerCase() === lower)) return this.freeze(pub);
    pub.tags = pub.tags.filter((t) => t.toLowerCase() !== lower);
    this.unindex(this.byTag, lower, publicationId);
    return this.freeze(pub);
  }

  /**
   * Mark a publication as peer-reviewed. Optionally record a DOI. DOI must
   * start with "10." and contain at least one slash, e.g. "10.1234/abc.5678".
   */
  setPeerReviewed(publicationId: PublicationId, doi?: string): Publication {
    const pub = this.requireMutable(publicationId);
    pub.peerReviewed = true;
    if (doi !== undefined) {
      const trimmed = doi.trim();
      if (trimmed && !this.isValidDoi(trimmed)) {
        throw new ResearchError({
          code: "eks.research.publication.validation",
          category: "validation",
          message: `Invalid DOI format: ${doi}. Expected format like "10.1234/abc.5678".`,
          userMessage: "The DOI does not look right.",
        });
      }
      pub.doi = trimmed || undefined;
    }
    return this.freeze(pub);
  }

  /**
   * Full-text search across titles, abstracts, and tags. Token-overlap
   * scoring: title tokens weighted 3x, abstract tokens 2x, tag tokens 1x.
   * Returns results ranked by score, descending.
   */
  search(query: string): PublicationSearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const qTokens = this.tokenize(q);
    if (!qTokens.length) return [];

    const results: PublicationSearchResult[] = [];
    for (const pub of this.publications.values()) {
      const titleTokens = new Set(this.tokenize(pub.title.toLowerCase()));
      const abstractTokens = new Set(this.tokenize(pub.abstract.toLowerCase()));
      const tagTokens = new Set(pub.tags.map((t) => t.toLowerCase()));

      let score = 0;
      const matchedFields: string[] = [];
      let titleHits = 0;
      let abstractHits = 0;
      let tagHits = 0;
      for (const t of qTokens) {
        if (titleTokens.has(t)) { score += 3; titleHits++; }
        if (abstractTokens.has(t)) { score += 2; abstractHits++; }
        if (tagTokens.has(t)) { score += 1; tagHits++; }
      }
      // Phrase bonus: if all query tokens appear in title, boost further.
      if (titleHits === qTokens.length && qTokens.length > 1) score += 4;
      if (titleHits > 0) matchedFields.push("title");
      if (abstractHits > 0) matchedFields.push("abstract");
      if (tagHits > 0) matchedFields.push("tags");
      if (score === 0) continue;
      results.push({ publication: this.freeze(pub), score, matchedFields: [...new Set(matchedFields)] });
    }
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.publication.publishedAt.localeCompare(a.publication.publishedAt);
    });
    return results;
  }

  /** Get all publications linked to a Program. */
  getByProgram(programId: ProgramId): Publication[] {
    return (this.byProgram.get(programId) ?? [])
      .map((id) => this.publications.get(id)!)
      .filter(Boolean)
      .map((p) => this.freeze(p));
  }

  /** Get all publications linked to a marketplace listing. */
  getByListing(listingId: string): Publication[] {
    return (this.byListing.get(listingId) ?? [])
      .map((id) => this.publications.get(id)!)
      .filter(Boolean)
      .map((p) => this.freeze(p));
  }

  /** Aggregate stats across all publications. */
  getStats(): PublicationStats {
    const list = [...this.publications.values()];
    const byType = {} as Record<PublicationType, number>;
    for (const t of PUBLICATION_TYPES) byType[t] = 0;
    let peerReviewed = 0;
    let withDoi = 0;
    let totalAuthors = 0;
    const uniqueTags = new Set<string>();
    let totalProgramLinks = 0;
    let totalListingLinks = 0;
    for (const p of list) {
      byType[p.type] = (byType[p.type] ?? 0) + 1;
      if (p.peerReviewed) peerReviewed++;
      if (p.doi) withDoi++;
      totalAuthors += p.authors.length;
      for (const t of p.tags) uniqueTags.add(t.toLowerCase());
      totalProgramLinks += p.linkedProgramIds.length;
      totalListingLinks += p.linkedListingIds.length;
    }
    return {
      total: list.length,
      byType,
      peerReviewed,
      withDoi,
      averageAuthors: list.length ? Math.round((totalAuthors / list.length) * 100) / 100 : 0,
      totalTags: uniqueTags.size,
      totalProgramLinks,
      totalListingLinks,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private validateInput(input: PublishPublicationInput): void {
    if (!input.title?.trim()) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "Publication title is required.",
        userMessage: "Please provide a title.",
      });
    }
    if (!input.abstract?.trim()) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "Publication abstract is required.",
        userMessage: "Please provide an abstract.",
      });
    }
    if (!input.content?.trim()) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "Publication content is required.",
        userMessage: "Please provide content.",
      });
    }
    if (!input.authors || input.authors.length === 0) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "At least one author is required.",
        userMessage: "Add at least one author.",
      });
    }
    for (const a of input.authors) {
      if (!a.accountId) {
        throw new ResearchError({
          code: "eks.research.publication.validation",
          category: "validation",
          message: "Each author must have an accountId.",
        });
      }
      if (!a.name?.trim()) {
        throw new ResearchError({
          code: "eks.research.publication.validation",
          category: "validation",
          message: "Each author must have a name.",
        });
      }
    }
    if (!input.workspaceId) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: "Workspace id is required.",
      });
    }
    if (!TYPE_INDEX.has(input.type)) {
      throw new ResearchError({
        code: "eks.research.publication.validation",
        category: "validation",
        message: `Unknown publication type: ${input.type}`,
        userMessage: "Unknown publication type.",
      });
    }
  }

  private requireMutable(id: PublicationId): MutablePublication {
    const pub = this.publications.get(id);
    if (!pub) {
      throw new ResearchError({
        code: "eks.research.publication.not_found",
        category: "not_found",
        message: `Publication ${id} not found.`,
        userMessage: "Publication not found.",
        metadata: { publicationId: id },
      });
    }
    return pub;
  }

  private tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/g).filter((t) => t.length > 1);
  }

  private normalizeTag(tag: string): string {
    return (tag ?? "").trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
  }

  private normalizeTags(tags?: string[]): string[] {
    if (!tags) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tags) {
      const n = this.normalizeTag(t);
      if (!n) continue;
      const lower = n.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(n);
    }
    return out;
  }

  private isValidDoi(doi: string): boolean {
    return /^10\.\d{4,9}\/\S+$/.test(doi);
  }

  private index<K>(map: Map<K, PublicationId[]>, key: K, id: PublicationId): void {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) map.set(key, [...list, id]);
  }

  private unindex<K>(map: Map<K, PublicationId[]>, key: K, id: PublicationId): void {
    const list = map.get(key);
    if (!list) return;
    map.set(key, list.filter((x) => x !== id));
  }

  private freeze(pub: MutablePublication): Publication {
    return {
      id: pub.id,
      title: pub.title,
      abstract: pub.abstract,
      type: pub.type,
      studyId: pub.studyId,
      workspaceId: pub.workspaceId,
      authors: pub.authors.map((a) => ({ ...a })),
      content: pub.content,
      linkedProgramIds: [...pub.linkedProgramIds],
      linkedListingIds: [...pub.linkedListingIds],
      tags: [...pub.tags],
      publishedAt: pub.publishedAt,
      doi: pub.doi,
      peerReviewed: pub.peerReviewed,
    };
  }

  private async notifyWorkspace(workspaceId: WorkspaceId, publicationId: PublicationId, actorId: AccountId): Promise<void> {
    try {
      const path = "../workspace";
      const mod = (await import(path)) as {
        getWorkspaces?: () => { recordPublication?(workspaceId: WorkspaceId, publicationId: PublicationId, actorId: AccountId): void };
      };
      const mgr = mod?.getWorkspaces?.();
      mgr?.recordPublication?.(workspaceId, publicationId, actorId);
    } catch {
      // workspace subsystem may not be loaded — non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _mgr: PublicationManager | null = null;
export function getPublications(): PublicationManager {
  if (!_mgr) _mgr = new PublicationManager();
  return _mgr;
}

// Re-export shared symbols for convenience.
export { RESEARCH_EVENTS, type Publication, type PublicationType };
