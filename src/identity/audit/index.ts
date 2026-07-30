/**
 * Eks-Health Identity — Audit Platform
 *
 * Every security-sensitive action becomes immutable. The audit log is an
 * append-only hash chain: each entry's hash is sha256(prevHash + entryJson),
 * so any tampering with a historical entry invalidates every subsequent hash.
 *
 * Categories tracked: authentication, permission grants/denials, consent
 * creation/revocation, data access, policy changes, role assignments, session
 * creation/termination, program installations, program permission changes,
 * security alerts.
 *
 * Tamper-evidence: `verifyChain()` walks the chain from genesis and recomputes
 * every hash; the first entry whose stored hash differs from the recomputed
 * value is reported via `brokenAt`. Entries can NEVER be deleted or mutated —
 * `record` always appends.
 *
 * No external deps beyond node:crypto.
 */

import "server-only";
import { createHash } from "node:crypto";
import {
  type AuditEntryId,
  type AccountId,
  type Principal,
  IdentityError,
  IDENTITY_EVENTS,
  asAuditEntryId,
} from "../core";
import { getEventBus, buildEvent, generateId, getClock } from "@/kernel";
import type { Brand, CorrelationId, TraceId } from "@/kernel";

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

export type AuditExportId = Brand<string, "AuditExportId">;

function asAuditExportId(s: string): AuditExportId {
  return s as AuditExportId;
}

// ---------------------------------------------------------------------------
// Categories & outcomes
// ---------------------------------------------------------------------------

export type AuditCategory =
  | "auth"
  | "permission"
  | "consent"
  | "data_access"
  | "policy"
  | "role"
  | "session"
  | "program"
  | "security"
  | "privacy";

export type AuditOutcome = "success" | "failure" | "denied";

// ---------------------------------------------------------------------------
// Audit entry
// ---------------------------------------------------------------------------

export interface IpMetadata {
  readonly ip?: string;
  readonly country?: string;
  readonly region?: string;
  readonly city?: string;
  readonly asn?: string;
  readonly lat?: number;
  readonly lng?: number;
  readonly vpn?: boolean;
  readonly proxy?: boolean;
  readonly tor?: boolean;
  readonly datacenter?: boolean;
}

export interface AuditTarget {
  readonly kind: string; // "account" | "session" | "consent" | "program" | "policy" | ...
  readonly id: string;
  readonly label?: string;
}

export interface AuditEntry {
  readonly id: AuditEntryId;
  readonly sequence: number; // 0-based monotonic
  readonly timestamp: string;
  readonly category: AuditCategory;
  readonly action: string; // e.g. "session.create", "consent.grant", "data.read"
  readonly outcome: AuditOutcome;
  readonly actor: Principal;
  readonly target?: AuditTarget;
  readonly purpose?: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly source: string; // service name, e.g. "identity.auth"
  readonly device?: { id: string; label?: string; trusted?: boolean };
  readonly ipMetadata?: IpMetadata;
  readonly metadata?: Record<string, unknown>;
  // Hash-chain fields:
  readonly prevHash: string; // "genesis" for the first entry
  readonly hash: string; // sha256(prevHash + "|" + canonicalJson(entryWithoutHash))
}

// ---------------------------------------------------------------------------
// Query & export
// ---------------------------------------------------------------------------

export interface AuditQuery {
  readonly category?: AuditCategory;
  readonly actorId?: string; // PrincipalId
  readonly accountId?: AccountId;
  readonly targetId?: string;
  readonly targetKind?: string;
  readonly action?: string;
  readonly outcome?: AuditOutcome;
  readonly since?: string; // ISO timestamp inclusive
  readonly until?: string; // ISO timestamp inclusive
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly source?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditChain {
  readonly headHash: string;
  readonly length: number;
  readonly genesisHash: string; // hash of the first entry (or "genesis" if empty)
  readonly lastSequence: number;
}

export interface AuditExport {
  readonly id: AuditExportId;
  readonly generatedAt: string;
  readonly filter: AuditQuery;
  readonly entries: AuditEntry[];
  readonly count: number;
  readonly chain: AuditChain;
  readonly signedBy: string;
  readonly signature: string; // sha256 of all entry hashes concatenated
  readonly algorithm: "sha256";
}

// ---------------------------------------------------------------------------
// Hash chain utilities — REAL sha256, deterministic canonical JSON
// ---------------------------------------------------------------------------

export const AUDIT_GENESIS = "genesis";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Recursively sort object keys so JSON.stringify is stable across runtimes
 * (V8 preserves insertion order; we want canonical form for reproducible
 * hashes).
 */
function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = deepSort(obj[k]);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(deepSort(value));
}

/**
 * Recompute the hash for an entry, excluding the `hash` field itself.
 * The hash binds the previous entry's hash, making the chain tamper-evident.
 */
export function computeEntryHash(entry: Omit<AuditEntry, "hash">): string {
  return sha256(entry.prevHash + "|" + canonicalJson(entry));
}

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------

export const AUDIT_EVENTS = {
  entryRecorded: "eks.identity.audit.recorded",
  chainVerified: "eks.identity.audit.chain_verified",
  chainBroken: "eks.identity.audit.chain_broken",
  exportGenerated: "eks.identity.audit.export_generated",
} as const;

// ---------------------------------------------------------------------------
// Audit platform
// ---------------------------------------------------------------------------

export interface RecordInput {
  readonly id?: AuditEntryId;
  readonly timestamp?: string;
  readonly category: AuditCategory;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor: Principal;
  readonly target?: AuditTarget;
  readonly purpose?: string;
  readonly correlationId?: CorrelationId;
  readonly traceId?: TraceId;
  readonly source: string;
  readonly device?: { id: string; label?: string; trusted?: boolean };
  readonly ipMetadata?: IpMetadata;
  readonly metadata?: Record<string, unknown>;
}

export class AuditPlatform {
  /** Append-only store. Entries are NEVER mutated or deleted. */
  private readonly entries = new Map<AuditEntryId, AuditEntry>();
  /** Index by sequence for O(1) chain walk. */
  private readonly bySequence: AuditEntry[] = [];
  /** Index by actor PrincipalId for fast countByActor. */
  private readonly byActor = new Map<string, AuditEntry[]>();
  /** Index by category for fast countByCategory. */
  private readonly byCategory = new Map<AuditCategory, AuditEntry[]>();
  private headHash: string = AUDIT_GENESIS;
  private sequence: number = 0;

  /**
   * Append a new entry to the audit log. The entry is hashed and chained to
   * the previous head. Once written, it CANNOT be modified or removed.
   */
  record(input: RecordInput): AuditEntry {
    const id = input.id ?? asAuditEntryId(generateId("aud_"));
    const timestamp = input.timestamp ?? getClock().iso();
    const prevHash = this.headHash;
    const sequence = this.sequence;

    const entryWithoutHash: Omit<AuditEntry, "hash"> = {
      id,
      sequence,
      timestamp,
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      actor: input.actor,
      target: input.target,
      purpose: input.purpose,
      correlationId: input.correlationId,
      traceId: input.traceId,
      source: input.source,
      device: input.device,
      ipMetadata: input.ipMetadata,
      metadata: input.metadata,
      prevHash,
    };
    const hash = computeEntryHash(entryWithoutHash);
    const entry: AuditEntry = { ...entryWithoutHash, hash };

    // APPEND-ONLY — never overwrite, never delete.
    this.entries.set(id, entry);
    this.bySequence.push(entry);

    const actorList = this.byActor.get(input.actor.id) ?? [];
    actorList.push(entry);
    this.byActor.set(input.actor.id, actorList);

    const catList = this.byCategory.get(input.category) ?? [];
    catList.push(entry);
    this.byCategory.set(input.category, catList);

    this.headHash = hash;
    this.sequence += 1;

    void getEventBus().publish(
      buildEvent(
        AUDIT_EVENTS.entryRecorded,
        {
          auditEntryId: id,
          sequence,
          category: input.category,
          action: input.action,
          outcome: input.outcome,
          actorId: input.actor.id,
          targetId: input.target?.id,
          source: input.source,
          hash,
          prevHash,
          traceId: input.traceId,
        },
        { correlationId: input.correlationId },
        "domain",
      ),
    );
    return entry;
  }

  /** Get a single entry by id. */
  get(id: AuditEntryId): AuditEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Query the audit log. Returns entries in REVERSE chronological order
   * (newest first), filtered by the provided criteria.
   */
  query(filter: AuditQuery): AuditEntry[] {
    let results = [...this.bySequence];
    if (filter.category) results = results.filter((e) => e.category === filter.category);
    if (filter.actorId) results = results.filter((e) => e.actor.id === filter.actorId);
    if (filter.accountId) results = results.filter((e) => e.actor.accountId === filter.accountId);
    if (filter.targetId) results = results.filter((e) => e.target?.id === filter.targetId);
    if (filter.targetKind) results = results.filter((e) => e.target?.kind === filter.targetKind);
    if (filter.action) results = results.filter((e) => e.action === filter.action);
    if (filter.outcome) results = results.filter((e) => e.outcome === filter.outcome);
    if (filter.source) results = results.filter((e) => e.source === filter.source);
    if (filter.correlationId) results = results.filter((e) => e.correlationId === filter.correlationId);
    if (filter.traceId) results = results.filter((e) => e.traceId === filter.traceId);
    if (filter.since) {
      const sinceMs = new Date(filter.since).getTime();
      results = results.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
    }
    if (filter.until) {
      const untilMs = new Date(filter.until).getTime();
      results = results.filter((e) => new Date(e.timestamp).getTime() <= untilMs);
    }
    // Reverse-chronological
    results.sort((a, b) => b.sequence - a.sequence);
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * Verify the integrity of the hash chain. Walks from the first entry to
   * the last, recomputing each hash. Returns `{ valid: false, brokenAt }`
   * at the first mismatch.
   */
  verifyChain(): { valid: boolean; brokenAt?: AuditEntryId; headHash: string } {
    let prevHash: string = AUDIT_GENESIS;
    for (let i = 0; i < this.bySequence.length; i++) {
      const entry = this.bySequence[i];
      // 1. Verify prevHash linkage
      if (entry.prevHash !== prevHash) {
        void getEventBus().publish(
          buildEvent(
            AUDIT_EVENTS.chainBroken,
            { brokenAt: entry.id, sequence: entry.sequence, reason: "prev_hash_mismatch" },
            {},
            "domain",
          ),
        );
        return { valid: false, brokenAt: entry.id, headHash: this.headHash };
      }
      // 2. Verify the stored hash matches a recomputation
      const { hash, ...rest } = entry;
      const recomputed = computeEntryHash(rest);
      if (recomputed !== entry.hash) {
        void getEventBus().publish(
          buildEvent(
            AUDIT_EVENTS.chainBroken,
            { brokenAt: entry.id, sequence: entry.sequence, reason: "hash_mismatch" },
            {},
            "domain",
          ),
        );
        return { valid: false, brokenAt: entry.id, headHash: this.headHash };
      }
      prevHash = entry.hash;
    }
    void getEventBus().publish(
      buildEvent(
        AUDIT_EVENTS.chainVerified,
        { length: this.bySequence.length, headHash: this.headHash },
        {},
        "domain",
      ),
    );
    return { valid: true, headHash: this.headHash };
  }

  /** Append-only chain metadata. */
  getChain(): AuditChain {
    const first = this.bySequence[0];
    return {
      headHash: this.headHash,
      length: this.bySequence.length,
      genesisHash: first?.hash ?? AUDIT_GENESIS,
      lastSequence: this.sequence - 1,
    };
  }

  /**
   * Produce a signed, exportable bundle of audit entries matching the filter.
   * The signature is sha256 of all entry hashes concatenated — any later
   * tampering with a single entry changes its hash, breaking the signature.
   */
  export(filter: AuditQuery, signedBy = "audit-platform"): AuditExport {
    const entries = this.query(filter);
    const signature = sha256(entries.map((e) => e.hash).join("|"));
    const exp: AuditExport = {
      id: asAuditExportId(generateId("audx_")),
      generatedAt: getClock().iso(),
      filter,
      entries,
      count: entries.length,
      chain: this.getChain(),
      signedBy,
      signature,
      algorithm: "sha256",
    };
    void getEventBus().publish(
      buildEvent(
        AUDIT_EVENTS.exportGenerated,
        { exportId: exp.id, count: entries.length, signedBy, filter },
        {},
        "domain",
      ),
    );
    return exp;
  }

  /** Verify an exported bundle: recompute the signature and check each hash. */
  verifyExport(exp: AuditExport): boolean {
    const recomputedSig = sha256(exp.entries.map((e) => e.hash).join("|"));
    if (recomputedSig !== exp.signature) return false;
    // Also verify each entry's hash is self-consistent
    for (const entry of exp.entries) {
      const { hash: _hash, ...rest } = entry;
      if (computeEntryHash(rest) !== entry.hash) return false;
    }
    return true;
  }

  /** Count entries per category. */
  countByCategory(): Record<AuditCategory, number> {
    const counts: Record<AuditCategory, number> = {
      auth: 0,
      permission: 0,
      consent: 0,
      data_access: 0,
      policy: 0,
      role: 0,
      session: 0,
      program: 0,
      security: 0,
      privacy: 0,
    };
    for (const [cat, list] of this.byCategory) counts[cat] = list.length;
    return counts;
  }

  /** Count entries per actor (PrincipalId). */
  countByActor(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const [actorId, list] of this.byActor) counts[actorId] = list.length;
    return counts;
  }

  /** Total entry count. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Convenience: record a permission decision. Returns the entry. Throws
   * never — audit failures must NEVER block the calling operation; the
   * returned entry is the audit receipt.
   */
  recordPermissionDecision(opts: {
    readonly actor: Principal;
    readonly permission: string;
    readonly decision: "allow" | "deny" | "challenge";
    readonly target?: AuditTarget;
    readonly source: string;
    readonly correlationId?: CorrelationId;
    readonly traceId?: TraceId;
    readonly device?: { id: string; label?: string; trusted?: boolean };
    readonly ipMetadata?: IpMetadata;
    readonly metadata?: Record<string, unknown>;
  }): AuditEntry {
    const outcome: AuditOutcome =
      opts.decision === "allow" ? "success" : opts.decision === "challenge" ? "failure" : "denied";
    return this.record({
      category: "permission",
      action: `permission.${opts.decision}`,
      outcome,
      actor: opts.actor,
      target: opts.target,
      source: opts.source,
      correlationId: opts.correlationId,
      traceId: opts.traceId,
      device: opts.device,
      ipMetadata: opts.ipMetadata,
      metadata: { permission: opts.permission, ...opts.metadata },
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience: re-export IDENTITY_EVENTS permission/data keys so consumers
// building audit-adjacent features can subscribe without importing core.
// ---------------------------------------------------------------------------

export const AUDITED_EVENTS = {
  permissionDenied: IDENTITY_EVENTS.permissionDenied,
  permissionGranted: IDENTITY_EVENTS.permissionGranted,
  dataAccessed: IDENTITY_EVENTS.dataAccessed,
  policyViolated: IDENTITY_EVENTS.policyViolated,
  incidentCreated: IDENTITY_EVENTS.incidentCreated,
  consentGranted: IDENTITY_EVENTS.consentGranted,
  consentRevoked: IDENTITY_EVENTS.consentRevoked,
  signedIn: IDENTITY_EVENTS.signedIn,
  signedOut: IDENTITY_EVENTS.signedOut,
} as const;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _platform: AuditPlatform | null = null;
export function getAudit(): AuditPlatform {
  if (!_platform) _platform = new AuditPlatform();
  return _platform;
}
export function setAudit(p: AuditPlatform): void {
  _platform = p;
}
export function resetAudit(): void {
  _platform = null;
}

// Re-export IdentityError for callers building audit-adjacent flows.
export { IdentityError };
